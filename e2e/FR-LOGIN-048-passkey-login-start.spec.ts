/**
 * FR-LOGIN-048 パスキーのログインの始め (a)（POST /api/auth/passkey/login/start）
 * 対応: FR-AUTH-016-AC-01〜03
 *
 * 手元のアプリ（本番ビルド）を呼ぶ HTTP の試験。画面は開かない（幅で結果は変わらないが、3つの幅でくり返す）。
 * 手元の GoTrue は Sb-Forwarded-For を数えないので、ここでは「ヘッダーを付けて送り、GoTrue が断らず 200 を返す」ことまでを確かめる。
 * 試験ごとに別の x-real-ip を付ける（回数の枠を使い切らないため）。
 */
import { expect, test, type APIRequestContext } from '@playwright/test';

const ENDPOINT = '/api/auth/passkey/login/start';
const ORIGIN = 'http://localhost:3000';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

function uniqueIp(): string {
  const octet = () => 1 + Math.floor(Math.random() * 253);
  return `10.${octet()}.${octet()}.${octet()}`;
}

function start(request: APIRequestContext, ip: string) {
  return request.post(ENDPOINT, { headers: { origin: ORIGIN, 'x-real-ip': ip } });
}

for (const viewport of viewports) {
  test.describe(`${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`FR-AUTH-016-AC-01 IP の見出しつきで呼ぶと 200 で、userVerification が required の選択肢と challenge_id が返る (${viewport.name})`, async ({ request }) => {
      const res = await start(request, uniqueIp());
      expect(res.status()).toBe(200);
      const body = (await res.json()) as {
        challenge_id?: string;
        options?: { challenge?: string; userVerification?: string };
        expires_at?: number;
      };
      expect(typeof body.challenge_id).toBe('string');
      expect(body.challenge_id).not.toBe('');
      expect(body.options?.userVerification).toBe('required');
      expect(typeof body.options?.challenge).toBe('string');
      expect(typeof body.expires_at).toBe('number');
      expect(res.headers()['cache-control']).toContain('no-store');
    });

    test(`FR-AUTH-016-AC-02 IP の見出しが無い要求は 503 で断られ、選択肢は返らない (${viewport.name})`, async ({ request }) => {
      const res = await start(request, '');
      expect(res.status()).toBe(503);
      expect(await res.json()).toEqual({ error: 'client_ip_unavailable' });
    });

    test(`FR-AUTH-016-AC-03 同じ IP の21回目は 429 で断られる (${viewport.name})`, async ({ request }) => {
      const ip = uniqueIp();
      for (let i = 1; i <= 20; i += 1) {
        const ok = await start(request, ip);
        expect(ok.status(), `${i}回目`).toBe(200);
      }
      const limited = await start(request, ip);
      expect(limited.status()).toBe(429);
      expect(await limited.json()).toEqual({ error: 'Too many requests' });
      expect(limited.headers()['retry-after']).toBeTruthy();
    });
  });
}
