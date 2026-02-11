import { NextResponse } from 'next/server';
import { incrementCounter } from '@/features/auth/ratelimit';

function getIpFromRequest(request?: Request): string {
  try {
    if (!request) return '127.0.0.1';
    // Prefer forwarded header, else use connection remote addr if available
    const fwd = request.headers.get('x-forwarded-for');
    if (fwd) return fwd.split(',')[0].trim();
    const real = request.headers.get('x-real-ip');
    if (real) return real;
  } catch (e) {
    // ignore
  }
  return '127.0.0.1';
}

export async function enforceRateLimit({ request, endpoint, limit = 50, windowSeconds = 600, subject }: { request?: Request; endpoint: string; limit?: number; windowSeconds?: number; subject?: string | null }) {
  const ip = getIpFromRequest(request);

  // Compute bucket timestamp truncated to windowSeconds
  const windowMs = windowSeconds * 1000;
  const bucketTs = new Date(Math.floor(Date.now() / windowMs) * windowMs).toISOString();

  try {
    const count = await incrementCounter({ ip, endpoint, bucket: bucketTs, subject: subject ?? null });
    if (count > limit) {
      const retryAfter = windowSeconds; // simple retry-after = window
      try {
        const res = NextResponse.json({ error: 'Too many requests' }, { status: 429 });
        res.headers.set('Retry-After', String(retryAfter));
        return res;
      } catch (err) {
        // In test environments NextResponse may not be available; return a
        // plain-like object to make assertions easier.
        return { status: 429, _body: { error: 'Too many requests' }, headers: { 'Retry-After': String(retryAfter) } } as any;
      }
    }
    return undefined;
  } catch (err) {
    // On DB errors, fail-open (allow request) but log error
    console.error('enforceRateLimit error:', err);
    return undefined;
  }
}
