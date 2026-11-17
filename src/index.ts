import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-session-projection'
import { compressHistory } from './command.js'
import { imageHistoryProjection } from './history.js'

export const name = 'compress-images'
export const inject = ['commands', 'sessions', 'attachments', 'sessionProjections']

export async function apply(ctx: Context): Promise<void> {
  const projection = await ctx.sessionProjections.register(imageHistoryProjection)
  const busy = new Set<string>()
  const active = new Set<Promise<CommandResult>>()
  const handler = (invocation: CommandInvocation): Promise<CommandResult> => {
    const { agent, signal, rawInput } = invocation
    const session = ctx.sessions.get(agent.id)
    if (session === undefined) return Promise.resolve({ kind: 'error', text: 'The current session is no longer available.' })
    if (busy.has(session.id)) return Promise.resolve({ kind: 'error', text: 'Image compression is already running for this conversation.' })
    busy.add(session.id)
    const operation = compressHistory(session, {
      attachments: ctx.attachments,
      state: () => {
        if (ctx.sessions.get(agent.id) !== session) throw new Error('The session was closed or replaced. No history was changed.')
        return projection.stateOf(session)
      },
      flush: async () => {
        if (!await ctx.sessions.flush(session)) throw new Error('No session persistence listener is active.')
      },
      warn: error => ctx.logger.warn(error),
    }, rawInput, signal)
    active.add(operation)
    const retire = (): void => {
      busy.delete(session.id)
      active.delete(operation)
    }
    void operation.then(retire, retire)
    return operation
  }
  ctx.effect(function* () {
    yield async () => { await Promise.allSettled(active) }
    yield ctx.commands.register({
      name: 'compress-images',
      description: 'Locally compress existing conversation images without calling a model',
      input: { hint: '[--max-kb 200] [--max-edge 1600] [--dry-run]' },
      handler,
    })
  }, 'compress-images lifecycle')
}
