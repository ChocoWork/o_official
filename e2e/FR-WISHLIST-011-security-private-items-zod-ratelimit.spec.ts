/**
 * FR-WISHLIST-011: セキュリティテスト
 * - private 商品の wishlist 追加拒否
 * - Zod バリデーション（item_id の型チェック）
 * - レート制限（POST での連続リクエスト制限）
 * 
 * 対応仕様: docs/5.Implement/security_review_item_id.md
 */

import { expect, test } from '@playwright/test';
import type { APIResponse } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

function buildWishlistHeaders(sessionCookie?: string) {
  return {
    origin: BASE_URL,
    referer: `${BASE_URL}/wishlist`,
    ...(sessionCookie ? { Cookie: `session_id=${sessionCookie}` } : {}),
  };
}

test.describe('FR-WISHLIST-011 Security - Private Items, Zod Validation, Rate Limiting', () => {
  let sessionCookie: string;

  test.beforeEach(async ({ request }) => {
    // Create a session by accessing home page
    const response = await request.get('/');
    const cookies = response.headers()['set-cookie'];
    if (cookies) {
      const sessionMatch = cookies.match(/session_id=([^;]+)/);
      if (sessionMatch) {
        sessionCookie = sessionMatch[1];
      }
    }
  });

  test.describe('High: private 商品の wishlist 追加拒否', () => {
    test('private 商品を wishlist に追加しようとしたら 404 を返す', async ({
      request,
    }) => {
      // NOTE: このテストは、DB に private 商品が実際に存在することを前提とします
      // DB seed や管理画面でテスト用の private 商品を作成してから実行してください
      // ここでは、実装の意図を示すためのテストです

      // 仮想的に private 商品 ID を 9999 とします（実際には DB に確認が必要）
      const privateItemId = 9999;

      const res = await request.post('/api/wishlist', {
        data: { item_id: privateItemId },
        headers: buildWishlistHeaders(sessionCookie),
      });

      // private 商品は status != 'published' なので、404 を返すべき
      expect(res.status()).toBe(404);
      expect((await res.json()).error).toMatch(/not found/i);
    });

    test('GET: wishlist から削除された商品は結果から除外される', async ({
      request,
    }) => {
      // 公開商品を追加
      const addRes = await request.post('/api/wishlist', {
        data: { item_id: 1 },
        headers: buildWishlistHeaders(sessionCookie),
      });

      expect([201, 409]).toContain(addRes.status()); // 201 or 409 (already in wishlist)

      // GET で取得
      const getRes = await request.get('/api/wishlist', {
        headers: sessionCookie ? { Cookie: `session_id=${sessionCookie}` } : {},
      });

      expect(getRes.status()).toBe(200);
      const data = await getRes.json();

      // 取得したアイテムがすべて items !== null であること（deleted items は除外）
      if (Array.isArray(data)) {
        for (const item of data) {
          expect(item.items).not.toBeNull();
        }
      }
    });
  });

  test.describe('Medium: Zod バリデーション（item_id の型チェック）', () => {
    test('item_id が文字列で非数値の場合、400 を返す', async ({
      request,
    }) => {
      const res = await request.post('/api/wishlist', {
        data: { item_id: 'invalid' },
        headers: buildWishlistHeaders(sessionCookie),
      });

      expect(res.status()).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('Invalid request body');
    });

    test('item_id が負の数の場合、400 を返す', async ({ request }) => {
      const res = await request.post('/api/wishlist', {
        data: { item_id: -1 },
        headers: buildWishlistHeaders(sessionCookie),
      });

      expect(res.status()).toBe(400);
    });

    test('item_id が小数の場合、400 を返す', async ({ request }) => {
      const res = await request.post('/api/wishlist', {
        data: { item_id: 1.5 },
        headers: buildWishlistHeaders(sessionCookie),
      });

      expect(res.status()).toBe(400);
    });

    test('item_id が存在しない場合、404 を返す', async ({ request }) => {
      const res = await request.post('/api/wishlist', {
        data: { item_id: 999999 },
        headers: buildWishlistHeaders(sessionCookie),
      });

      expect(res.status()).toBe(404);
    });

    test('リクエスト body が空の場合、400 を返す', async ({ request }) => {
      const res = await request.post('/api/wishlist', {
        data: {},
        headers: buildWishlistHeaders(sessionCookie),
      });

      expect(res.status()).toBe(400);
    });
  });

  test.describe('Medium: レート制限（IP + セッション単位）', () => {
    test('POST でセッション単位のレート制限が機能する（30 req/min）', async ({
      request,
    }) => {
      test.setTimeout(90_000);

      // IP 単位の上限（60 回/分）は、並列実行中の他のテストと 127.0.0.1 を共有している。
      // セッション単位の上限だけを見るため、この試験では文書用 IPv6（2001:db8::/32）を名乗る。
      // x-forwarded-for をそのまま使うのは Vercel を通らないローカルの E2E サーバーだけ。
      const forwardedFor = `2001:db8::${Date.now().toString(16).slice(-4)}:${Math.floor(Math.random() * 0xffff).toString(16)}`;

      // 回数は1分ごとの固定枠で数える。35 回を送る途中で枠が切り替わると数え直しになり、
      // 31 回目以降が 429 にならない。枠の残りが短ければ次の枠の頭まで待つ。
      const msIntoWindow = Date.now() % 60_000;
      if (msIntoWindow > 45_000) {
        await new Promise((resolve) => setTimeout(resolve, 60_000 - msIntoWindow + 200));
      }

      const validItemIds = [1, 2, 3, 4, 5];
      const responses: APIResponse[] = [];

      for (let i = 0; i < 35; i++) {
        const res = await request.post('/api/wishlist', {
          data: { item_id: validItemIds[i % validItemIds.length] },
          headers: { ...buildWishlistHeaders(sessionCookie), 'x-forwarded-for': forwardedFor },
        });
        responses.push(res);
      }

      // 30 回目までは上限に掛からない（追加済み・存在しない商品などの応答はあり得る）。
      for (const res of responses.slice(0, 30)) {
        expect([201, 409, 400, 404]).toContain(res.status());
      }

      // 31 回目以降はセッション単位の上限で 429 になり、再試行までの秒数を返す。
      // 以前はここを「429 があれば 429 であること」としか確かめておらず、上限が一度も
      // 効いていなかった不具合（FREQ-360）を見逃していた。
      for (const res of responses.slice(30)) {
        expect(res.status()).toBe(429);
        expect(res.headers()['retry-after']).toBeTruthy();
      }
    });

    test('POST で same-origin でない送信は 403 を返す', async ({ request }) => {
      const res = await request.post('/api/wishlist', {
        data: { item_id: 1 },
        headers: {
          origin: 'https://evil.example.com',
          referer: 'https://evil.example.com/wishlist',
          Cookie: 'session_id=nonexistent',
        },
      });

      expect(res.status()).toBe(403);
    });
  });

  test.describe('Integration: 複合シナリオ', () => {
    test('正常なフロー: 公開商品を wishlist に追加→取得→確認', async ({
      request,
    }) => {
      // 1. POST で公開商品を追加
      const addRes = await request.post('/api/wishlist', {
        data: { item_id: 1 },
        headers: buildWishlistHeaders(sessionCookie),
      });

      expect([201, 409]).toContain(addRes.status());

      // 2. GET で取得
      const getRes = await request.get('/api/wishlist', {
        headers: sessionCookie ? { Cookie: `session_id=${sessionCookie}` } : {},
      });

      expect(getRes.status()).toBe(200);
      const data = await getRes.json();

      // 3. 取得したアイテムにはすべて items が存在する（published 確認済み）
      if (Array.isArray(data) && data.length > 0) {
        for (const item of data) {
          expect(item.items).not.toBeNull();
          expect(item.items.status).toBe('published');
        }
      }
    });

    test('エラーハンドリング: 不正なリクエストから復帰', async ({
      request,
    }) => {
      // 1. 不正な item_id で POST
      const badRes = await request.post('/api/wishlist', {
        data: { item_id: 'invalid' },
        headers: buildWishlistHeaders(sessionCookie),
      });

      expect(badRes.status()).toBe(400);

      // 2. 正常なリクエストで POST（復帰可能なことを確認）
      const goodRes = await request.post('/api/wishlist', {
        data: { item_id: 1 },
        headers: buildWishlistHeaders(sessionCookie),
      });

      expect([201, 409]).toContain(goodRes.status());

      // 3. GET で正常に取得
      const getRes = await request.get('/api/wishlist', {
        headers: sessionCookie ? { Cookie: `session_id=${sessionCookie}` } : {},
      });

      expect(getRes.status()).toBe(200);
    });
  });
});
