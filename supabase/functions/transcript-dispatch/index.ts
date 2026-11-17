import { authenticateTranscriptionInternal, transcriptionInternalHandler } from '../_shared/transcription-worker.ts';
import { transcriptionBody, transcriptionJson } from '../_shared/transcription-db.ts';

export async function handler(request: Request): Promise<Response> {
  if (!await authenticateTranscriptionInternal(request)) return transcriptionJson({ error: 'unauthorized' }, 401);
  // pg_net can acknowledge a committed wake quickly while bounded media and
  // provider work stays alive within the Edge runtime's normal execution limits.
  const runtime = (globalThis as unknown as { EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void } }).EdgeRuntime;
  if (runtime) {
    try {
      const input = await transcriptionBody(request.clone());
      const action = input.action ?? 'dispatch';
      if (action === 'dispatch' || action === 'maintenance') {
        runtime.waitUntil(transcriptionInternalHandler(request).then(response => {
          if (!response.ok) console.warn('Transcription background batch unavailable; maintenance will recover');
        }).catch(() => { console.warn('Transcription background batch unavailable; maintenance will recover'); }));
        return transcriptionJson({ accepted: true }, 202);
      }
    } catch { return transcriptionJson({ error: 'transcription_blocked_or_unavailable' }, 503); }
  }
  return await transcriptionInternalHandler(request);
}
Deno.serve(handler);
