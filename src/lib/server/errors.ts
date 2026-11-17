export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export function publicError(error: unknown): { status: number; body: { error: { code: string; message: string } } } {
  if (error instanceof ApiError) return { status: error.status, body: { error: { code: error.code, message: error.message } } };
  // Never return database messages, credentials, provider payloads, or stacks to clients.
  console.error('[ReelRadar] request failed', error instanceof Error ? error.name : 'UnknownError');
  return { status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' } } };
}
