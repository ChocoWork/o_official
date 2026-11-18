import { completeStaffRegistration } from '@/features/auth/staff/staff-register-client';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('DD-AUTH-080 2本の登録の終わりの呼び（staff-register-client）', () => {
  test('DD-AUTH-080 200 は redirectTo を返し、/ で始まらない値は /login にする', async () => {
    const fetchApi = jest.fn().mockResolvedValue(json(200, { redirectTo: '/login' }));
    await expect(completeStaffRegistration(fetchApi)).resolves.toEqual({ ok: true, redirectTo: '/login' });
    expect(fetchApi).toHaveBeenCalledWith('/api/auth/staff/register/complete', { method: 'POST' });
    const bad = jest.fn().mockResolvedValue(json(200, { redirectTo: 'https://evil.example' }));
    await expect(completeStaffRegistration(bad)).resolves.toEqual({ ok: true, redirectTo: '/login' });
    const protocolRelative = jest.fn().mockResolvedValue(json(200, { redirectTo: '//evil.example' }));
    await expect(completeStaffRegistration(protocolRelative)).resolves.toEqual({ ok: true, redirectTo: '/login' });
  });

  test('DD-AUTH-080 本文が無い・配列・文字列でも、状態だけで理由を決める（409・403 は failed）', async () => {
    for (const body of ['[]', '"x"', 'null', 'not json']) {
      const make = (status: number) => jest.fn().mockResolvedValue(new Response(body, { status }));
      await expect(completeStaffRegistration(make(409))).resolves.toEqual({ ok: false, reason: 'failed' });
      await expect(completeStaffRegistration(make(403))).resolves.toEqual({ ok: false, reason: 'failed' });
      await expect(completeStaffRegistration(make(503))).resolves.toEqual({ ok: false, reason: 'unavailable' });
    }
    await expect(completeStaffRegistration(jest.fn().mockResolvedValue(new Response('[]', { status: 200 })))).resolves.toEqual({
      ok: true,
      redirectTo: '/login',
    });
  });

  test.each([
    [409, { error: 'keys_short' }, 'keys_short'],
    [409, { error: 'keys_not_window' }, 'keys_not_window'],
    [403, { error: 'window_closed' }, 'window_closed'],
    [401, { error: 'Unauthorized' }, 'window_closed'],
    [429, {}, 'rate_limited'],
    [503, {}, 'unavailable'],
    [500, { error: 'register_complete_failed' }, 'failed'],
    [409, { error: 'other' }, 'failed'],
  ])('DD-AUTH-080 %i %j は %s', async (status, body, reason) => {
    const fetchApi = jest.fn().mockResolvedValue(json(status, body));
    await expect(completeStaffRegistration(fetchApi)).resolves.toEqual({ ok: false, reason });
  });

  test('DD-AUTH-080 通信の失敗・壊れた本文は failed', async () => {
    await expect(completeStaffRegistration(jest.fn().mockRejectedValue(new Error('x')))).resolves.toEqual({
      ok: false,
      reason: 'failed',
    });
    await expect(
      completeStaffRegistration(jest.fn().mockResolvedValue(new Response('not json', { status: 500 }))),
    ).resolves.toEqual({ ok: false, reason: 'failed' });
  });
});
