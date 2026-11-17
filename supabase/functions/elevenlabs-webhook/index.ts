import { transcriptionWebhookHandler } from '../_shared/transcription-worker.ts';
export const handler = transcriptionWebhookHandler;
Deno.serve(handler);
