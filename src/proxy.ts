import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { assertDemoRequest, supabaseConfig } from './lib/server/security';
import { publicError } from './lib/server/errors';
import { canonicalAppUrl } from './lib/server/app-origin';

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  // APIs authenticate independently and return JSON rather than login redirects.
  if (pathname === '/api' || pathname.startsWith('/api/')) return NextResponse.next();
  try {
    const canonicalUrl = canonicalAppUrl(request);
    if (canonicalUrl) {
      const response = NextResponse.redirect(canonicalUrl);
      response.headers.set('Cache-Control', 'no-store');
      return response;
    }
    if (assertDemoRequest(request)) return NextResponse.next();
    if (pathname === '/login') return NextResponse.next();
    const config = supabaseConfig();
    let response = NextResponse.next({ request });
    const client = createServerClient(config.url, config.key, {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: cookies => {
          for (const { name, value } of cookies) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookies) response.cookies.set(name, value, { ...options, httpOnly: true, sameSite: 'lax', secure: request.nextUrl.protocol === 'https:', path: '/' });
        },
      },
    });
    const { data, error } = await client.auth.getUser();
    if (error || !data.user || data.user.id !== config.ownerId || data.user.email?.toLowerCase() !== config.ownerEmail) {
      const redirect = NextResponse.redirect(new URL('/login', request.url));
      for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
      redirect.headers.set('Cache-Control', 'no-store');
      return redirect;
    }
    response.headers.set('Cache-Control', 'no-store, private');
    return response;
  } catch (error) {
    const result = publicError(error);
    return NextResponse.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store' } });
  }
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff|woff2)$).*)'],
};
