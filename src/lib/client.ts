import { clearResourceCache, getResourceCacheEpoch, invalidateResourceFamilies, invalidateResources } from './resource-cache';
import { mutationResourceDependencies } from './resource-dependencies';

export const REQUEST_TIMEOUT_MS = 30_000;
export const READ_REQUEST_TIMEOUT_MESSAGE = 'Request timed out. Please try again.';
export const MUTATION_REQUEST_TIMEOUT_MESSAGE = 'Request timed out. It may have completed. Refresh status before trying again.';

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); this.name = 'ApiError'; }
}

function invalidateMutation(path: string, options: RequestInit) {
  const dependencies = mutationResourceDependencies(path, options.method ?? 'GET', options.body);
  if (!dependencies) invalidateResources();
  else if (dependencies.families.length) invalidateResourceFamilies(dependencies.families, dependencies.workspaceId);
}

function discardAuthResources() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('reelradar-auth-change'));
  clearResourceCache();
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const epoch = getResourceCacheEpoch();
  const isAuthRequest = ['/api/auth/login', '/api/auth/logout'].includes(path.split('?')[0]);
  const isMutation = !['GET', 'HEAD', 'OPTIONS'].includes((options.method ?? 'GET').toUpperCase());
  const callerSignal = options.signal;
  // A cancelled/unmounted caller must not start a request (or a deadline timer).
  if (callerSignal?.aborted) throw callerSignal.reason;
  const controller = new AbortController();
  let finished = false;
  let timeoutError: ApiError | undefined;
  let rejectStopped!: (error: unknown) => void;
  const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
  const onAbort = () => {
    if (finished) return;
    finished = true;
    // Reject before aborting: even a custom fetch ignoring abort must settle.
    rejectStopped(callerSignal?.reason);
    controller.abort(callerSignal?.reason);
  };
  callerSignal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => {
    if (finished) return;
    finished = true;
    timeoutError = new ApiError('REQUEST_TIMEOUT', isMutation ? MUTATION_REQUEST_TIMEOUT_MESSAGE : READ_REQUEST_TIMEOUT_MESSAGE, 504);
    rejectStopped(timeoutError);
    controller.abort(timeoutError);
  }, REQUEST_TIMEOUT_MS);

  let data: unknown;
  try {
    // Only transport/body parsing lives in the raced operation. All cache/auth
    // effects are below the race, so a late response cannot apply them again.
    const request = (async () => {
      const response = await fetch(path, {
        ...options,
        signal: controller.signal,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
      });
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new ApiError(body?.error?.code ?? 'REQUEST_FAILED', body?.error?.message ?? `Request failed (${response.status}). Please try again.`, response.status);
      }
      return response.status === 204 ? undefined : await response.json();
    })();
    data = await Promise.race([request, stopped]);
    if (controller.signal.aborted) throw controller.signal.reason;
  } catch (error) {
    if (timeoutError && error === timeoutError && getResourceCacheEpoch() === epoch) {
      // Auth may have changed cookies already. Forget private cached data and
      // stop the old sync bridge, but never replay auth or launch recovery reads.
      if (isAuthRequest) discardAuthResources();
      // Data writes may have committed: request one scoped read reconciliation,
      // never replay a mutation or alter provider holds/costs on the client.
      else if (isMutation) invalidateMutation(path, options);
    }
    throw error;
  } finally {
    finished = true;
    clearTimeout(timeout);
    callerSignal?.removeEventListener('abort', onAbort);
  }
  if (getResourceCacheEpoch() === epoch) {
    if (isAuthRequest) discardAuthResources();
    else invalidateMutation(path, options);
  }
  return data as T;
}

export function queryString(query: Record<string, string | number | boolean | undefined | null>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  return params.toString();
}

export function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'Something went wrong. Please try again.'; }
