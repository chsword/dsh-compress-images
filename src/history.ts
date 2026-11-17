import { z } from 'zod'
import type { ImageBlock, Message, ToolResultMessage, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionEventInput } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-compaction'

const commonNode = {
  seq: z.number().int().nonnegative(),
  messageId: z.string(),
}

const stateSchema = z.object({
  turnOpen: z.boolean(),
  compacting: z.boolean(),
  nodes: z.array(z.discriminatedUnion('type', [
    z.object({ ...commonNode, type: z.literal('user/message') }),
    z.object({
      ...commonNode,
      type: z.literal('tool/result'),
      turn: z.number().int().nonnegative(),
      step: z.number().int().nonnegative(),
      error: z.object({ name: z.string(), code: z.string(), reason: z.string().optional() }).optional(),
      meta: z.json().optional(),
    }),
  ])),
})

export type HistoryState = z.infer<typeof stateSchema>
export type InputNode = HistoryState['nodes'][number]
export type InputMessage = UserMessage | ToolResultMessage

export const imageHistoryProjection: ProjectionDefinition<'compress-images-history', HistoryState> = {
  key: 'compress-images-history',
  stateSchema,
  stateVersion: 1,
  init: () => ({ turnOpen: false, compacting: false, nodes: [] }),
  apply(state, event: SessionEvent) {
    switch (event.type) {
      case 'turn/start':
        return { ...state, turnOpen: true }
      case 'turn/end':
        return { ...state, turnOpen: false }
      case 'compaction/start':
        return { ...state, compacting: true }
      case 'compaction/end':
        return { ...state, compacting: false }
      case 'user/message':
        if (retainedImages(event.data).length === 0) return state
        return {
          ...state,
          nodes: [...state.nodes, { seq: event.seq, messageId: event.data.id, type: event.type }],
        }
      case 'tool/result':
        if (retainedImages(event.data.message).length === 0) return state
        return {
          ...state,
          nodes: [...state.nodes, {
            seq: event.seq,
            messageId: event.data.message.id,
            type: event.type,
            turn: event.data.turn,
            step: event.data.step,
            ...(event.data.error === undefined ? {} : { error: event.data.error }),
            ...(event.data.meta === undefined ? {} : { meta: event.data.meta }),
          }],
        }
      default:
        return state
    }
  },
}

export function retainedImages(message: Message): ImageBlock[] {
  return message.content.filter(
    (block): block is ImageBlock => block.type === 'image' && block.offloaded !== true,
  )
}

export function inputMessages(session: Session, state: HistoryState): {
  node: InputNode
  message: InputMessage
}[] {
  const active = new Set<number>(session.surface.nodes)
  const metadata = new Map(
    state.nodes.filter(node => active.has(node.seq)).map(node => [node.messageId, node]),
  )
  const result: { node: InputNode; message: InputMessage }[] = []
  for (const message of session.deriveMessages()) {
    if ((message.role !== 'user' && message.role !== 'tool') || retainedImages(message).length === 0) continue
    const node = metadata.get(message.id)
    if (node === undefined) throw new Error('An active image message has no history metadata. No history was changed.')
    if ((message.role === 'user') !== (node.type === 'user/message')) {
      throw new Error('An image message has inconsistent history metadata. No history was changed.')
    }
    result.push({ node, message })
  }
  return result
}

export function replacement(
  session: Session,
  node: InputNode,
  message: InputMessage,
): SessionEventInput {
  const seq = session.surface.nodes.find(value => value === node.seq)
  if (seq === undefined) throw new Error('The selected image history changed. Retry when the conversation is idle.')
  const intent = { surfaceOp: { op: 'replace' as const, startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] }
  if (node.type === 'user/message' && message.role === 'user') {
    return ['user/message', message, intent]
  }
  if (node.type === 'tool/result' && message.role === 'tool') {
    return ['tool/result', {
      turn: node.turn,
      step: node.step,
      message,
      ...(node.error === undefined ? {} : {
        error: {
          name: node.error.name,
          code: node.error.code,
          ...(node.error.reason === undefined ? {} : { reason: node.error.reason }),
        },
      }),
      ...(node.meta === undefined ? {} : { meta: node.meta }),
    }, intent]
  }
  throw new Error('The replacement message does not match the original role.')
}
