import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import type { CommandResult } from '@deepseek-ai/dsh-commands';
import type { Session } from '@deepseek-ai/dsh-session';
import type { HistoryState } from './history.js';
export interface CommandHost {
    attachments: AttachmentStore;
    state(): HistoryState;
    flush(): Promise<void>;
    warn(error: unknown): void;
}
export declare function compressHistory(session: Session, host: CommandHost, rawInput: string, signal: AbortSignal): Promise<CommandResult>;
