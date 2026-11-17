import type { ImageMediaType, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'

export interface CompressionOptions {
  maxBytes: number
  maxEdge: number
}

export interface CompressedImage {
  data: Uint8Array
  mediaType: ImageMediaType
  width: number
  height: number
}

export const defaultOptions: Readonly<CompressionOptions> = {
  maxBytes: 200 * 1024,
  maxEdge: 1600,
}

export function parseOptions(input: string): CompressionOptions & { dryRun: boolean } {
  const options = { ...defaultOptions, dryRun: false }
  const args = input.trim().length === 0 ? [] : input.trim().split(/\s+/)
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (arg !== '--max-kb' && arg !== '--max-edge') {
      throw new Error('Usage: /compress-images [--max-kb 200] [--max-edge 1600] [--dry-run]')
    }
    const value = args[++i]
    if (value === undefined || !/^[1-9]\d*$/.test(value)) {
      throw new Error(`${arg} requires a positive integer.`)
    }
    const number = Number(value)
    if (arg === '--max-kb') {
      if (!Number.isSafeInteger(number) || number < 16 || number > 4096) {
        throw new Error('--max-kb must be between 16 and 4096 KiB.')
      }
      options.maxBytes = number * 1024
    } else {
      if (!Number.isSafeInteger(number) || number < 256 || number > 8192) {
        throw new Error('--max-edge must be between 256 and 8192 pixels.')
      }
      options.maxEdge = number
    }
  }
  return options
}

export function needsCompression(
  image: Pick<StoredImageAttachment['ref'], 'bytes' | 'width' | 'height'>,
  options: CompressionOptions,
): boolean {
  return image.bytes > options.maxBytes || Math.max(image.width, image.height) > options.maxEdge
}

export async function compressImage(
  image: StoredImageAttachment,
  options: CompressionOptions,
  signal: AbortSignal,
): Promise<CompressedImage> {
  signal.throwIfAborted()
  const { default: sharp } = await import('sharp')
  signal.throwIfAborted()
  const source = sharp(image.data, { failOn: 'error', limitInputPixels: 64_000_000 })
  const metadata = await source.metadata()
  if ((metadata.pages ?? 1) > 1) {
    throw new Error('Animated images are not compressed: flattening them would lose frames.')
  }
  let edge = Math.min(options.maxEdge, Math.max(image.ref.width, image.ref.height))
  const smallestEdge = Math.min(256, edge)
  while (true) {
    for (const quality of [85, 75, 65, 55, 45]) {
      signal.throwIfAborted()
      const { data, info } = await source.clone()
        .rotate()
        .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
        .toColourspace('srgb')
        .webp({ quality, alphaQuality: 100, effort: 4 })
        .toBuffer({ resolveWithObject: true })
      signal.throwIfAborted()
      if (data.byteLength <= options.maxBytes && data.byteLength < image.ref.bytes) {
        return { data, mediaType: 'image/webp', width: info.width, height: info.height }
      }
    }
    if (edge === smallestEdge) break
    edge = Math.max(smallestEdge, Math.floor(edge * 0.75))
  }
  throw new Error(
    `An image could not be made smaller and fit ${options.maxBytes} bytes without going below ${smallestEdge}px. No history was changed.`,
  )
}
