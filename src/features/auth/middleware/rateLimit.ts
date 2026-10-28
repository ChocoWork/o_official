import { NextResponse } from 'next/server';
import { incrementCounter } from '@/features/auth/ratelimit';
import { withNoStore } from '@/lib/http/no-store';
import { getClientIp } from '@/lib/request-ip';

// 429・503 は利用者ごとの回数の状態を表すので、共有のキャッシュに残さない（SEC-AUTH-013、DD-AUTH-038）。
function limitResponse(error: string, status: number, retryAfter: number): Response {
  try {
    const res = NextResponse.json({ error }, { status });
    res.headers.set('Retry-After', String(retryAfter));
    return withNoStore(res);
  } catch {
    // In test environments NextResponse may not be available; return Web Response.
    return withNoStore(
      new Response(JSON.stringify({ error }), {
        status,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(retryAfter),
        },
      }),
    );
  }
}

export async function enforceRateLimit({ request, endpoint, limit = 50, windowSeconds = 600, subject }: { request?: Request; endpoint: string; limit?: number; windowSeconds?: number; subject?: string | null }) {
  // 送り元が取れない時は null のまま渡す。rate_limit_counters.ip は inet で 'unknown' は入らず、
  // null は一意制約（NULLS NOT DISTINCT）で「送り元が分からない全員が 1 つの枠」になる。
  const ip = getClientIp(request);

  // Compute bucket timestamp truncated to windowSeconds
  const windowMs = windowSeconds * 1000;
  const bucketTs = new Date(Math.floor(Date.now() / windowMs) * windowMs).toISOString();

  try {
    const count = await incrementCounter({ ip, endpoint, bucket: bucketTs, subject: subject ?? null });
    if (count > limit) {
      const retryAfter = windowSeconds; // simple retry-after = window
      return limitResponse('Too many requests', 429, retryAfter);
    }
    return undefined;
  } catch (err) {
    // On DB errors, fail-closed to preserve authentication abuse protection.
    console.error('enforceRateLimit error:', err);
    return limitResponse('Rate limiter unavailable', 503, windowSeconds);
  }
}
