/** @jest-environment node */
import { createClient } from '@/lib/supabase/server';

jest.mock('next/headers', () => ({
  cookies: jest.fn(async () => ({ get: () => undefined, getAll: () => [], set: () => {} })),
  headers: jest.fn(async () => new Headers()),
}));

function makeJwt(expSeconds: number): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return [
    encode({ alg: 'ES256', typ: 'JWT' }),
    encode({ sub: 'user-1', session_id: 'auth-session-1', exp: expSeconds, name: '桜井' }),
    'signature',
  ].join('.');
}

function requestWithCookies(cookie: string): Request {
  return new Request('https://app.invalid/api/wishlist', { headers: { cookie } });
}

describe('createClient forwards only tokens Supabase can still accept', () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;
  const requests: Array<{ authorization: string | null; sessionId: string | null }> = [];

  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.invalid';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'fake-public-key';
    requests.length = 0;
    global.fetch = jest.fn(async (_input, init) => {
      const headers = new Headers(init?.headers);
      requests.push({
        authorization: headers.get('authorization'),
        sessionId: headers.get('x-session-id'),
      });
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof global.fetch;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = originalFetch;
  });

  test('期限切れの access token は載せず、セッション文脈だけで匿名として叩く', async () => {
    const expired = makeJwt(Math.floor(Date.now() / 1000) - 60);
    const supabase = await createClient(
      requestWithCookies(`session_id=guest-session-1; sb-access-token=${expired}`),
    );

    await supabase.from('wishlist').insert({ session_id: 'guest-session-1', item_id: 1 });

    expect(requests).toHaveLength(1);
    expect(requests[0].authorization).toBe('Bearer fake-public-key');
    expect(requests[0].sessionId).toBe('guest-session-1');
  });

  test('JWT として読めない access token も載せない', async () => {
    const supabase = await createClient(
      requestWithCookies('session_id=guest-session-2; sb-access-token=not-a-jwt'),
    );

    await supabase.from('wishlist').insert({ session_id: 'guest-session-2', item_id: 1 });

    expect(requests).toHaveLength(1);
    expect(requests[0].authorization).toBe('Bearer fake-public-key');
    expect(requests[0].sessionId).toBe('guest-session-2');
  });

  test('有効な access token はこれまで通り転送する', async () => {
    const valid = makeJwt(Math.floor(Date.now() / 1000) + 3600);
    const supabase = await createClient(
      requestWithCookies(`session_id=guest-session-3; sb-access-token=${valid}`),
    );

    await supabase.from('wishlist').insert({ session_id: 'guest-session-3', item_id: 1 });

    expect(requests).toHaveLength(1);
    expect(requests[0].authorization).toBe(`Bearer ${valid}`);
    expect(requests[0].sessionId).toBe('guest-session-3');
  });
});
