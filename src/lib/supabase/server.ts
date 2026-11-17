import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { ApiError } from '../server/errors';
import { supabaseConfig } from '../server/security';

export async function createSupabaseServerClient() {
  const config = supabaseConfig();
  const cookieStore = await cookies();
  return createServerClient(config.url, config.key, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: values => {
        for (const { name, value, options } of values) cookieStore.set(name, value, { ...options, httpOnly: true, secure: process.env.NODE_ENV === 'production' && new URL(config.url).protocol === 'https:', sameSite: 'lax', path: '/' });
      },
    },
  });
}

export async function authenticatedClient() {
  const config = supabaseConfig();
  const client = await createSupabaseServerClient();
  // getUser validates the token server-side; never trust getSession alone.
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in to continue.');
  if (data.user.id !== config.ownerId || data.user.email?.toLowerCase() !== config.ownerEmail) throw new ApiError(403, 'OWNER_ONLY', 'This application is restricted to its configured owner.');
  return { client, user: data.user };
}
