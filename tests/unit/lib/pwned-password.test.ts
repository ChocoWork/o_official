import crypto from 'crypto';
import { checkPwnedPassword } from '@/lib/pwned-password';

// FREQ-323: 漏洩済みパスワードの検査（Supabase の leaked password protection は
// Pro プラン以上でしか使えないため、同等の制御をアプリ側に置いている）

const originalFetch = global.fetch;

function sha1Upper(value: string) {
  return crypto.createHash('sha1').update(value, 'utf8').digest('hex').toUpperCase();
}

/** HIBP の Range API と同じ形（サフィックス:出現回数 の行）で応答を作る */
function rangeResponse(lines: string[]) {
  return {
    ok: true,
    status: 200,
    text: async () => lines.join('\r\n'),
  } as unknown as Response;
}

describe('checkPwnedPassword', () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('パスワードそのものも完全なハッシュも送らない（k-匿名性）', async () => {
    const password = 'correct horse battery staple';
    const hash = sha1Upper(password);
    const fetchMock = jest.fn().mockResolvedValue(rangeResponse([]));
    global.fetch = fetchMock as unknown as typeof fetch;

    await checkPwnedPassword(password);

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toBe(`https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`);
    // 送るのは先頭5文字だけ。残り 35 文字もパスワード本体も URL に出さない。
    expect(url).not.toContain(hash.slice(5));
    expect(url).not.toContain(password);
  });

  test('漏洩リストに載っていれば pwned と件数を返す', async () => {
    const password = 'leaked-password-example';
    const suffix = sha1Upper(password).slice(5);
    global.fetch = jest.fn().mockResolvedValue(
      rangeResponse([`${suffix}:4242`, 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:1']),
    ) as unknown as typeof fetch;

    await expect(checkPwnedPassword(password)).resolves.toEqual({ status: 'pwned', count: 4242 });
  });

  test('一致しなければ ok', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      rangeResponse(['0000000000000000000000000000000000A:3']),
    ) as unknown as typeof fetch;

    await expect(checkPwnedPassword('some-unique-passphrase')).resolves.toEqual({ status: 'ok' });
  });

  // Add-Padding で混ぜられるダミー行は count が 0 で返る。これを漏洩扱いしない。
  test('padding のダミー行（count 0）は漏洩とみなさない', async () => {
    const password = 'padded-entry-example';
    const suffix = sha1Upper(password).slice(5);
    global.fetch = jest.fn().mockResolvedValue(
      rangeResponse([`${suffix}:0`]),
    ) as unknown as typeof fetch;

    await expect(checkPwnedPassword(password)).resolves.toEqual({ status: 'ok' });
  });

  // 外部サービスの障害で自社の認証を止めない。呼び出し側は fail-open にする。
  test('HIBP が非 ok を返したら unavailable', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => '',
    } as unknown as Response) as unknown as typeof fetch;

    await expect(checkPwnedPassword('anything')).resolves.toEqual({
      status: 'unavailable',
      reason: 'hibp_status_503',
    });
  });

  test('ネットワーク例外でも throw せず unavailable', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('boom')) as unknown as typeof fetch;

    const result = await checkPwnedPassword('anything');
    expect(result.status).toBe('unavailable');
  });

  test('空文字なら外部 API を呼ばない', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(checkPwnedPassword('')).resolves.toEqual({ status: 'ok' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
