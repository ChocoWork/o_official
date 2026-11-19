/**
 * DD-AUTH-090 店員の削除の下限（409 staff_min_keys）を、失敗の理由 'min_keys' として見分ける。本文は必ず読み切る。
 */
const clientFetchMock = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => clientFetchMock(...args) }));

import { deletePasskey } from '@/features/auth/passkey/passkey-client';

const res = (status: number, body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

beforeEach(() => clientFetchMock.mockReset());

describe('DD-AUTH-090 削除の失敗の理由 min_keys', () => {
  test('DD-AUTH-090 409 の本文が staff_min_keys なら min_keys で、本文は読み切られる', async () => {
    const response = res(409, { error: 'staff_min_keys' });
    clientFetchMock.mockResolvedValue(response);
    await expect(deletePasskey('k1')).resolves.toEqual({ ok: false, reason: 'min_keys' });
    expect(response.bodyUsed).toBe(true);
  });

  test('DD-AUTH-090 本文が違う 409 は failed', async () => {
    const response = res(409, { error: 'other' });
    clientFetchMock.mockResolvedValue(response);
    await expect(deletePasskey('k1')).resolves.toEqual({ ok: false, reason: 'failed' });
    expect(response.bodyUsed).toBe(true);
  });

  test('DD-AUTH-090 本文が JSON でない 409 も failed で、本文は読み切られる', async () => {
    const response = res(409, 'not json');
    clientFetchMock.mockResolvedValue(response);
    await expect(deletePasskey('k1')).resolves.toEqual({ ok: false, reason: 'failed' });
    expect(response.bodyUsed).toBe(true);
  });

  test.each([500, 404, 503])('DD-AUTH-090 %i は min_keys にならず、本文は読み切られる', async (status) => {
    const response = res(status, { error: 'staff_min_keys' });
    clientFetchMock.mockResolvedValue(response);
    const result = await deletePasskey('k1');
    expect(result).toMatchObject({ ok: false });
    expect(result).not.toEqual({ ok: false, reason: 'min_keys' });
    expect(response.bodyUsed).toBe(true);
  });

  test('DD-AUTH-090 投げた fetch は failed', async () => {
    clientFetchMock.mockRejectedValue(new Error('network'));
    await expect(deletePasskey('k1')).resolves.toEqual({ ok: false, reason: 'failed' });
  });
});
