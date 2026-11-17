/**
 * DD-AUTH-060 no-store の /api/auth/* の応答は、本文を読み切るか捨てる（読まない fetch は E2E の networkidle を止める）。
 */
const clientFetchMock = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => clientFetchMock(...args) }));

import { deletePasskey, listPasskeys, registerPasskey, renamePasskey } from '@/features/auth/passkey/passkey-client';

const res = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });

beforeEach(() => clientFetchMock.mockReset());

describe('DD-AUTH-060 応答の本文を読み切る', () => {
  test.each([
    ['削除の成功', () => deletePasskey('k1'), res(200, { ok: true })],
    ['削除の失敗', () => deletePasskey('k1'), res(404, { error: 'not_found' })],
    ['一覧の失敗', () => listPasskeys(), res(401, { error: 'Unauthorized' })],
    ['名前の変更の失敗', () => renamePasskey('k1', 'x'), res(502, { error: 'passkey_manage_failed' })],
  ])('DD-AUTH-060 %s で本文が使われる', async (_name, run, response) => {
    clientFetchMock.mockResolvedValue(response);
    await run();
    expect(response.bodyUsed).toBe(true);
  });

  test('DD-AUTH-060 registerPasskey の名前の変更が失敗しても、その応答の本文が使われる', async () => {
    const patch = res(502, { error: 'x' });
    const queue = [
      res(200, { challenge_id: 'c', options: { challenge: 'AQID' } }),
      res(200, { passkey: { id: 'k1', friendly_name: null, created_at: 'c' } }),
      patch,
    ];
    await registerPasskey({
      fetchApi: (async () => queue.shift()) as never,
      create: (async () => ({ ok: true, credential: {} })) as never,
      deviceName: 'iPhone',
    });
    expect(patch.bodyUsed).toBe(true);
  });
});
