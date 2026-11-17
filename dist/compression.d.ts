import type { ImageMediaType, StoredImageAttachment } from '@deepseek-ai/dsh-attachment';
export interface CompressionOptions {
    maxBytes: number;
    maxEdge: number;
}
export interface CompressedImage {
    data: Uint8Array;
    mediaType: ImageMediaType;
    width: number;
    height: number;
}
export declare const defaultOptions: Readonly<CompressionOptions>;
export declare function parseOptions(input: string): CompressionOptions & {
    dryRun: boolean;
};
export declare function needsCompression(image: Pick<StoredImageAttachment['ref'], 'bytes' | 'width' | 'height'>, options: CompressionOptions): boolean;
export declare function compressImage(image: StoredImageAttachment, options: CompressionOptions, signal: AbortSignal): Promise<CompressedImage>;
