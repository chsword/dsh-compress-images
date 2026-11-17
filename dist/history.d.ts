import { z } from 'zod';
import type { ImageBlock, Message, ToolResultMessage, UserMessage } from '@deepseek-ai/dsh-llm';
import type { Session, SessionEventInput } from '@deepseek-ai/dsh-session';
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection';
declare const stateSchema: z.ZodObject<{
    turnOpen: z.ZodBoolean;
    compacting: z.ZodBoolean;
    nodes: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"user/message">;
        seq: z.ZodNumber;
        messageId: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"tool/result">;
        turn: z.ZodNumber;
        step: z.ZodNumber;
        error: z.ZodOptional<z.ZodObject<{
            name: z.ZodString;
            code: z.ZodString;
            reason: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        meta: z.ZodOptional<z.ZodJSONSchema>;
        seq: z.ZodNumber;
        messageId: z.ZodString;
    }, z.core.$strip>], "type">>;
}, z.core.$strip>;
export type HistoryState = z.infer<typeof stateSchema>;
export type InputNode = HistoryState['nodes'][number];
export type InputMessage = UserMessage | ToolResultMessage;
export declare const imageHistoryProjection: ProjectionDefinition<'compress-images-history', HistoryState>;
export declare function retainedImages(message: Message): ImageBlock[];
export declare function inputMessages(session: Session, state: HistoryState): {
    node: InputNode;
    message: InputMessage;
}[];
export declare function replacement(session: Session, node: InputNode, message: InputMessage): SessionEventInput;
export {};
