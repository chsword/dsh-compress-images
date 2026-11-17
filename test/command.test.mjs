import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { compressHistory } from '../dist/command.js'
import { parseOptions } from '../dist/compression.js'
import { imageHistoryProjection } from '../dist/history.js'
import * as plugin from '../dist/index.js'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-compress-images-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const session = Session.create('compression-test')
  const counters = { reads: 0, writes: 0, flushes: 0, warnings: [] }
  const attachments = {
    async saveImage({ data, mediaType, name }) {
      const metadata = await sharp(data).metadata()
      const hash = createHash('sha256').update(data).digest('hex')
      await writeFile(join(directory, hash), data)
      counters.writes += 1
      return {
        attachmentId: `sha256:${hash}`,
        mediaType,
        bytes: data.byteLength,
        width: metadata.width,
        height: metadata.height,
        ...(name === undefined ? {} : { name }),
      }
    },
    async readImage(ref) {
      counters.reads += 1
      const data = await readFile(join(directory, ref.attachmentId.slice(7)))
      assert.equal(createHash('sha256').update(data).digest('hex'), ref.attachmentId.slice(7))
      assert.equal(data.byteLength, ref.bytes)
      return { ref, data }
    },
  }
  const host = {
    attachments,
    state() {
      return session.snapshotEvents().reduce(
        (state, event) => imageHistoryProjection.apply(state, event),
        imageHistoryProjection.init(),
      )
    },
    async flush() {
      counters.flushes += 1
      await writeFile(join(directory, 'session.json'), JSON.stringify(session.snapshotEvents()))
    },
    warn(error) { counters.warnings.push(error) },
  }
  const data = await sharp(randomBytes(640 * 480 * 3), {
    raw: { width: 640, height: 480, channels: 3 },
  }).png({ compressionLevel: 0 }).toBuffer()
  const ref = await attachments.saveImage({ data, mediaType: 'image/png', name: 'screenshot.png' })
  counters.writes = 0
  const addUser = (refs = [ref]) => {
    const message = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Keep this text.' }, ...refs.map(attachment => ({ type: 'image', attachment }))],
    })
    session.append('user/message', message, { surfaceOp: 'append' })
    return message
  }
  const run = (input = '--max-kb 32 --max-edge 640', signal = new AbortController().signal) =>
    compressHistory(session, host, input, signal)
  return { directory, session, counters, attachments, host, ref, data, addUser, run }
}

test('compresses historical images and replays replacements without the plugin', async t => {
  const f = await fixture(t)
  const original = f.addUser()
  const before = f.session.seq
  const result = await f.run()
  assert.equal(result.kind, 'success', result.text)
  assert.ok(f.session.seq > before)
  const [message] = f.session.deriveMessages()
  assert.equal(message.id, original.id)
  assert.deepEqual(message.content[0], original.content[0])
  const compressed = message.content[1].attachment
  assert.equal(compressed.mediaType, 'image/webp')
  assert.ok(compressed.bytes <= 32 * 1024)
  assert.ok(compressed.width <= 640 && compressed.height <= 640)
  assert.ok(compressed.bytes < f.ref.bytes)
  assert.deepEqual((await f.attachments.readImage(f.ref)).data, f.data)
  const saved = JSON.parse(await readFile(join(f.directory, 'session.json'), 'utf8'))
  const restored = Session.create(f.session.id, saved)
  assert.deepEqual(restored.deriveMessages(), f.session.deriveMessages())
  const seq = f.session.seq
  const writes = f.counters.writes
  assert.equal((await f.run()).kind, 'success')
  assert.equal(f.session.seq, seq)
  assert.equal(f.counters.writes, writes)
})

test('preserves tool call identity, role, position, and error state', async t => {
  const f = await fixture(t)
  const first = f.addUser([])
  const message = createMessage({
    role: 'tool',
    source: { kind: 'tool', callId: 'call-test' },
    toolCallId: 'call-test',
    isError: true,
    content: [{ type: 'image', attachment: f.ref }],
  })
  const error = { name: 'TestError', code: 'TEST', reason: 'Preserve this failure.' }
  const meta = { example: ['preserved', 1] }
  f.session.append('tool/result', { turn: 1, step: 2, message, error, meta }, { surfaceOp: 'append' })
  const last = f.addUser([])
  assert.equal((await f.run()).kind, 'success')
  const messages = f.session.deriveMessages()
  assert.deepEqual(messages.map(value => value.id), [first.id, message.id, last.id])
  assert.equal(messages[1].role, 'tool')
  assert.equal(messages[1].toolCallId, message.toolCallId)
  assert.equal(messages[1].isError, true)
  const event = f.session.snapshotEvents().at(-1)
  assert.equal(event.type, 'tool/result')
  assert.equal(event.data.turn, 1)
  assert.equal(event.data.step, 2)
  assert.deepEqual(event.data.error, error)
  assert.deepEqual(event.data.meta, meta)
})

test('deduplicates attachment work and leaves offloaded images untouched', async t => {
  const f = await fixture(t)
  f.addUser([f.ref, f.ref])
  const message = createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'image', attachment: f.ref, offloaded: true }],
  })
  f.session.append('user/message', message, { surfaceOp: 'append' })
  const result = await f.run()
  assert.equal(result.kind, 'success', result.text)
  assert.equal(f.counters.reads, 1)
  assert.equal(f.counters.writes, 1)
  const messages = f.session.deriveMessages()
  assert.equal(messages[0].content[1].attachment.attachmentId, messages[0].content[2].attachment.attachmentId)
  assert.deepEqual(messages[1], message)
})

test('dry-run compresses to measure but writes neither images nor history', async t => {
  const f = await fixture(t)
  f.addUser()
  const seq = f.session.seq
  const result = await f.run('--max-kb 32 --max-edge 640 --dry-run')
  assert.equal(result.kind, 'success', result.text)
  assert.match(result.text, /Preview only/)
  assert.equal(f.session.seq, seq)
  assert.equal(f.counters.writes, 0)
  assert.equal(f.counters.flushes, 0)
})

test('rejects a running turn and a conversation changed during compression', async t => {
  const f = await fixture(t)
  f.addUser()
  f.session.append('turn/start', { turn: 1 })
  assert.equal((await f.run()).kind, 'error')
  assert.equal(f.counters.reads, 0)
  f.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const read = f.attachments.readImage
  f.attachments.readImage = async ref => {
    const image = await read(ref)
    f.addUser([])
    return image
  }
  const result = await f.run()
  assert.equal(result.kind, 'error')
  assert.match(result.text, /conversation changed/)
  assert.equal(f.session.deriveMessages()[0].content[1].attachment.attachmentId, f.ref.attachmentId)
})

test('aborts before mutation and reports persistence failure after commit', async t => {
  const f = await fixture(t)
  f.addUser()
  const controller = new AbortController()
  controller.abort()
  const before = f.session.seq
  assert.equal((await f.run(undefined, controller.signal)).kind, 'error')
  assert.equal(f.session.seq, before)
  f.host.flush = async () => { throw new Error('test disk failure') }
  const result = await f.run()
  assert.equal(result.kind, 'error')
  assert.match(result.text, /History was updated, but persistence could not be confirmed/)
  assert.match(result.text, /test disk failure/)
  assert.notEqual(f.session.deriveMessages()[0].content[1].attachment.attachmentId, f.ref.attachmentId)
})

test('does not partially replace history when an image cannot be read', async t => {
  const f = await fixture(t)
  const missing = { ...f.ref, attachmentId: `sha256:${'0'.repeat(64)}` }
  f.addUser([f.ref, missing])
  const before = f.session.seq
  assert.equal((await f.run()).kind, 'error')
  assert.equal(f.session.seq, before)
  assert.equal(f.counters.flushes, 0)
})

test('rejects invalid limits instead of silently applying defaults', () => {
  for (const input of ['--max-kb', '--max-kb 0', '--max-kb -1', '--max-kb 16.5', '--max-edge 200', '--unknown']) {
    assert.throws(() => parseOptions(input))
  }
})

test('rejects an unattainable hard budget without changing history', async t => {
  const f = await fixture(t)
  const data = await sharp(randomBytes(256 * 256 * 3), {
    raw: { width: 256, height: 256, channels: 3 },
  }).png({ compressionLevel: 0 }).toBuffer()
  const ref = await f.attachments.saveImage({ data, mediaType: 'image/png' })
  f.addUser([ref])
  const seq = f.session.seq
  const result = await f.run('--max-kb 16 --max-edge 256')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /could not be made smaller and fit/)
  assert.equal(f.session.seq, seq)
})

test('preserves image transparency', async t => {
  const f = await fixture(t)
  const data = await sharp(randomBytes(640 * 480 * 4), {
    raw: { width: 640, height: 480, channels: 4 },
  }).png().toBuffer()
  const ref = await f.attachments.saveImage({ data, mediaType: 'image/png' })
  f.addUser([ref])
  const result = await f.run('--max-kb 100 --max-edge 640')
  assert.equal(result.kind, 'success', result.text)
  const compressed = f.session.deriveMessages()[0].content[1].attachment
  const image = await f.attachments.readImage(compressed)
  assert.equal((await sharp(image.data).metadata()).hasAlpha, true)
  assert.ok((await sharp(image.data).stats()).channels[3].min < 255)
})

test('rejects animation instead of silently flattening it', async t => {
  const f = await fixture(t)
  const animation = await sharp(randomBytes(128 * 256 * 4), {
    raw: { width: 128, height: 256, channels: 4, pageHeight: 128 },
  }).gif({ delay: [100, 100], loop: 0 }).toBuffer()
  assert.equal((await sharp(animation).metadata()).pages, 2)
  const animatedRef = await f.attachments.saveImage({ data: animation, mediaType: 'image/gif' })
  f.addUser([animatedRef])
  const seq = f.session.seq
  const failure = await f.run('--max-kb 16 --max-edge 256')
  assert.equal(failure.kind, 'error')
  assert.match(failure.text, /Animated images/)
  assert.equal(f.session.seq, seq)
})

test('registers the command against the real host projection and session services', async t => {
  const f = await fixture(t)
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const sessions = new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  ctx.provide('attachments', f.attachments)
  let definition
  let registered = true
  ctx.provide('commands', {
    register(value) {
      definition = value
      return () => { registered = false }
    },
  })
  await plugin.apply(ctx)
  assert.equal(definition.name, 'compress-images')
  const session = sessions.create('live-compression-test')
  const original = createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'image', attachment: f.ref }],
  })
  session.append('user/message', original, { surfaceOp: 'append' })
  let flushed = false
  ctx.on('session/flush', () => { flushed = true })
  const invocation = {
    agent: { id: session.id },
    rawInput: '--max-kb 32 --max-edge 640',
    signal: new AbortController().signal,
    attachments: [],
    commandId: 'test-command',
  }
  const pending = definition.handler(invocation)
  const duplicate = await definition.handler(invocation)
  assert.equal(duplicate.kind, 'error')
  assert.match(duplicate.text, /already running/)
  const result = await pending
  assert.equal(result.kind, 'success', result.text)
  assert.equal(flushed, true)
  assert.notEqual(session.deriveMessages()[0].content[0].attachment.attachmentId, f.ref.attachmentId)
  await ctx.fiber.dispose()
  assert.equal(registered, false)
})
