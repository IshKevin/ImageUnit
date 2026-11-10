import { NextRequest, NextResponse } from 'next/server';

// Pages that only a signed-in person may open. The API is the authority: the session is checked with it before the
// page is sent, so the protected screens are not delivered to anyone who is not signed in. Data is protected by the API.
const PROTECTED_PREFIXES = ['/console'];
const API_URL = process.env.API_URL ?? 'http://localhost:4000';

export async function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const isProtected = PROTECTED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
  if (!isProtected) return NextResponse.next();

  const session = req.cookies.get('iu_session');
  if (session) {
    try {
      const res = await fetch(`${API_URL}/api/auth/me`, {
        headers: { cookie: `iu_session=${session.value}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return NextResponse.next();
    } catch {
      // API unreachable: treat as not signed in. The login page explains and offers sign-in again.
    }
  }

  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = `?next=${encodeURIComponent(`${pathname}${search}`)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/console/:path*'],
};
