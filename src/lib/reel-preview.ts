import { api, errorMessage } from './client';
import { reelPlaybackUrl } from './reel-detail';

export function reelPreviewSources(value: unknown, reelId: string): string[] {
  const detail = value as { reel?: { id?: string; provider?: string }; media?: { urls?: unknown }; processing?: { reason?: string } } | null;
  if (detail?.reel?.id !== reelId || typeof detail.reel.provider !== 'string' || detail.reel.provider.startsWith('mock') || detail.processing?.reason === 'demo') return [];
  const urls = detail.media?.urls;
  return Array.isArray(urls) ? [...new Set(urls.slice(0, 16).map(reelPlaybackUrl).filter((url): url is string => url !== null))].slice(0, 3) : [];
}

/** Fetch only authorized metadata; the native player streams captured media progressively. */
export function startReelPreview(workspaceId: string, reelId: string, onReady: (sources: string[]) => void, onError: (message: string) => void) {
  const controller = new AbortController();
  const finished = (async () => {
    try {
      const detail = await api<unknown>(`/api/workspaces/${encodeURIComponent(workspaceId)}/reels/${encodeURIComponent(reelId)}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      const sources = reelPreviewSources(detail, reelId);
      if (!sources.length) throw new Error('No playable video is stored for this Reel yet. View the original on Instagram.');
      onReady(sources);
    } catch (error) {
      if (!controller.signal.aborted) onError(errorMessage(error));
    }
  })();
  return { finished, cancel: () => controller.abort() };
}
