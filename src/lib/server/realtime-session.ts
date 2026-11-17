import type { Session } from '@supabase/supabase-js';
import { ApiError } from './errors';

export function safeRealtimeSession(session: Session | null, verifiedOwnerId: string, now = Date.now()) {
  if (!session || session.user.id !== verifiedOwnerId || !session.expires_at || session.expires_at * 1000 <= now + 10_000) {
    throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in to continue.');
  }
  let claims: { sub?: string; role?: string; exp?: number };
  try { claims = JSON.parse(Buffer.from(session.access_token.split('.')[1], 'base64url').toString()); }
  catch { throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in to continue.'); }
  if (claims.sub !== verifiedOwnerId || claims.role !== 'authenticated' || typeof claims.exp !== 'number' || claims.exp * 1000 <= now + 10_000) {
    throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in to continue.');
  }
  return { access_token: session.access_token, expires_at: Math.min(session.expires_at, claims.exp), owner_user_id: verifiedOwnerId };
}
