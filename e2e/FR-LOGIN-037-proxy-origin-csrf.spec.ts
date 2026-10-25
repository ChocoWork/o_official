import { expect, test } from '@playwright/test';
import { createTestMember, loginAsMember } from './member-session-helpers';

// AC-04 は会員の確認コードと Cookie を扱う。通信記録に残さないため trace を切る。
test.use({ trace: 'off' });

// FREQ-327 / SEC-AUTH-025: 状態を変える /api の窓口の Origin の確かめは proxy が既定で全部に掛け、
// 外すのは署名か共有の秘密で送り元を確かめる道だけにする。HTTP の応答だけを見る。
// 窓口を HTTP で叩く試験で、画面の幅で結果が変わらない。幅ごとに流すと DB の書き込みと回数の制限の枠が3倍になるので、1つの幅（desktop）だけ流す。
const viewports = [{ name: 'desktop', width: 1280, height: 800 }] as const;

const EVIL_ORIGIN = 'https://evil.example.com';
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

for (const viewport of viewports) {
  test.describe(`${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`FREQ-327-AC-01 proxy に並べていない /api の窓口へ許可外オリジンから POST すると 403 (${viewport.name})`, async ({ request }) => {
      const paths = [
        '/api/contact',
        `/api/contact/threads/${NIL_UUID}/reply`,
        '/api/profile',
        '/api/checkout/place-order',
        '/api/orders',
      ];

      for (const path of paths) {
        const response = await request.post(path, {
          headers: { origin: EVIL_ORIGIN, referer: `${EVIL_ORIGIN}/` },
          data: {},
        });

        expect(response.status(), `${path} への許可外オリジンの POST`).toBe(403);
      }
    });

    test(`FREQ-327-AC-02 外した道への Origin 無しの POST と /api の外への POST は 403 にならない (${viewport.name})`, async ({ request }) => {
      const exemptPaths = [
        '/api/webhook/stripe',
        '/api/contact/inbound',
        '/api/cron/meta-kpi-sync',
        '/api/cron/does-not-exist',
      ];

      for (const path of exemptPaths) {
        const response = await request.post(path, { data: {} });

        expect(response.status(), `${path} への Origin 無しの POST`).not.toBe(403);
      }

      // /api 配下でないパスは、許可外オリジンを付けても検査しない。
      const outsideApi = await request.post('/checkout', {
        headers: { origin: EVIL_ORIGIN },
        data: {},
      });

      expect(outsideApi.status(), '/api 配下でない /checkout への POST').not.toBe(403);
    });

    test(`FREQ-327-AC-03 許可外オリジンからの /api/contact への POST に proxy の応答が 403 で返る (${viewport.name})`, async ({ request }) => {
      const response = await request.post('/api/contact', {
        headers: { origin: EVIL_ORIGIN, referer: `${EVIL_ORIGIN}/contact` },
        data: {
          name: 'Cross Site User',
          email: 'cross-site@example.com',
          inquiryType: 'other',
          subject: 'Cross site test',
          message: 'This should be blocked.',
        },
      });

      expect(response.status()).toBe(403);
      // ルート固有の本文（{ success: false, ... }）ではなく proxy の本文であること。
      expect(await response.json()).toEqual({ error: 'Forbidden origin' });
    });

    test(`FREQ-327-AC-04 同じ利用者の問い合わせの返信が1時間に30件を超えると 429 (${viewport.name})`, async ({ page }) => {
      // 返信の窓口は回数の制限を持ち主より先に掛けるため、存在しない問い合わせでも数えられる。
      // 最初の30件は 429 にならず、31件目で 429 になる。
      const member = await createTestMember('freq327-reply');
      await page.goto('/');
      await loginAsMember(page, member, `203.0.113.${100 + viewports.indexOf(viewport)}`);

      const origin = new URL(page.url()).origin;
      const reply = () =>
        page.request.post(`${origin}/api/contact/threads/${NIL_UUID}/reply`, {
          headers: { origin },
          data: { body: 'rate limit check' },
          maxRedirects: 0,
        });

      for (let count = 1; count <= 30; count += 1) {
        const response = await reply();
        expect(response.status(), `${count} 件目`).not.toBe(429);
        expect(response.status(), `${count} 件目は認証を通る`).not.toBe(401);
        expect(response.status(), `${count} 件目は Origin を通る`).not.toBe(403);
      }

      const overLimit = await reply();

      expect(overLimit.status(), '31 件目').toBe(429);
    });

    test(`SEC-AUTH-025-AC-01 別のオリジンからの再設定の完了が 403 (${viewport.name})`, async ({ request }) => {
      const response = await request.post('/api/auth/password-reset/confirm', {
        headers: { origin: 'https://evil.example' },
        data: {},
      });

      expect(response.status()).toBe(403);
      expect(await response.json()).toEqual({ error: 'Forbidden origin' });
    });
  });
}
