import { transcriptionInternalHandler } from '../_shared/transcription-worker.ts';
export async function handler(request: Request): Promise<Response> { return await transcriptionInternalHandler(request, true); }
Deno.serve(handler);
