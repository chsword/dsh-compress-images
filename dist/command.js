import { compressImage, needsCompression, parseOptions } from './compression.js';
import { inputMessages, replacement, retainedImages } from './history.js';
function formatBytes(bytes) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}
export async function compressHistory(session, host, rawInput, signal) {
    let committed = false;
    try {
        const options = parseOptions(rawInput);
        signal.throwIfAborted();
        const state = host.state();
        if (state.turnOpen || state.compacting) {
            return { kind: 'error', text: 'Stop the current turn or compaction before running /compress-images.' };
        }
        const sequence = session.seq;
        const selected = inputMessages(session, state);
        const images = selected.flatMap(({ message }) => retainedImages(message));
        const before = images.reduce((sum, image) => sum + image.attachment.bytes, 0);
        const unique = new Map(images.map(image => [image.attachment.attachmentId, image.attachment]));
        const candidates = [...unique.values()].filter(ref => needsCompression(ref, options));
        if (images.length === 0)
            return { kind: 'success', text: 'No retained historical input images to compress.' };
        if (candidates.length === 0) {
            return { kind: 'success', text: `All ${images.length} image occurrences already fit the limits (${formatBytes(before)}).` };
        }
        const versions = new Map();
        for (const ref of candidates) {
            signal.throwIfAborted();
            const source = await host.attachments.readImage(ref, signal);
            const compressed = await compressImage(source, options, signal);
            const saved = options.dryRun
                ? { ...ref, bytes: compressed.data.byteLength, width: compressed.width, height: compressed.height }
                : await host.attachments.saveImage({
                    data: compressed.data,
                    mediaType: compressed.mediaType,
                    ...(ref.name === undefined ? {} : { name: ref.name.replace(/\.[^.]+$/, '') + '.webp' }),
                });
            signal.throwIfAborted();
            if (saved.bytes > options.maxBytes || Math.max(saved.width, saved.height) > options.maxEdge
                || saved.bytes >= ref.bytes) {
                throw new Error('The attachment backend did not preserve the compression limits. No history was changed.');
            }
            versions.set(ref.attachmentId, saved);
        }
        const after = images.reduce((sum, image) => sum + (versions.get(image.attachment.attachmentId)?.bytes ?? image.attachment.bytes), 0);
        const summary = `${images.length} image occurrences (${candidates.length} unique images compressed): ${formatBytes(before)} -> ${formatBytes(after)}.`;
        if (options.dryRun)
            return { kind: 'success', text: `Preview only; nothing saved or replaced. ${summary}` };
        const current = host.state();
        if (current.turnOpen || current.compacting || session.seq !== sequence) {
            throw new Error('The conversation changed while compressing. No history was changed; retry when it is idle.');
        }
        signal.throwIfAborted();
        const updates = [];
        for (const { node, message } of selected) {
            let changed = false;
            const content = message.content.map(block => {
                if (block.type !== 'image' || block.offloaded === true)
                    return block;
                const attachment = versions.get(block.attachment.attachmentId);
                if (attachment === undefined)
                    return block;
                changed = true;
                return { ...block, attachment };
            });
            if (changed)
                updates.push(replacement(session, node, { ...message, content }));
        }
        session.append(updates);
        committed = true;
        await host.flush();
        return { kind: 'success', text: `${summary} Original attachments and log entries were retained. Future requests use the compressed copies.` };
    }
    catch (error) {
        host.warn(error);
        const detail = signal.aborted ? 'Compression cancelled.' : error instanceof Error ? error.message : 'Compression failed; inspect the DSH log.';
        return {
            kind: 'error',
            text: committed
                ? `History was updated, but persistence could not be confirmed. Do not retry blindly; check storage. ${detail}`
                : detail,
        };
    }
}
