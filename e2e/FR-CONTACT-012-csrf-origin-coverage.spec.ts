import { expect, test } from '@playwright/test';

/**
 * FREQ-327: 状態変更 API の Origin 検査を、保護対象の列挙（許可リスト）ではなく
 * 除外対象の明示（除外リスト）で回す。
 *
 * 許可リスト方式だと、新しく作ったルートが検査対象から漏れても誰も気づけない。
 * 実際に /api/contact 配下が漏れており、/api/contact/threads/{id}/reply は
 * Origin 検査も CSRF トークンも無い状態だった。
 */
test.describe('FR-CONTACT-012 状態変更APIのOrigin検査カバレッジ', () => {
  const EVIL = 'https://evil.example.com';

  // 以前 proxy の許可リストに載っていなかった経路。すべて検査対象であること。
  const previouslyUnprotected = [
    '/api/contact',
    '/api/contact/threads/00000000-0000-0000-0000-000000000000/reply',
    '/api/profile',
    '/api/checkout/update-shipping',
  ];

  for (const path of previouslyUnprotected) {
    test(`AC-01 列挙外の ${path} も許可外オリジンを拒否する`, async ({ request }) => {
      const response = await request.post(path, {
        headers: { origin: EVIL, referer: `${EVIL}/` },
        data: {},
      });

      expect(response.status()).toBe(403);
    });
  }

  // 署名・共有シークレットで発信元を検証している経路だけが除外対象。
  // Origin を持たない正当な外部 POST を壊さないこと（403 以外なら何でもよい）。
  const exempt = ['/api/webhook/stripe', '/api/contact/inbound', '/api/cron/meta-kpi-sync'];

  for (const path of exempt) {
    test(`AC-02 ${path} は Origin 検査の対象外`, async ({ request }) => {
      const response = await request.post(path, { data: {} });

      expect(response.status()).not.toBe(403);
    });
  }

  test('AC-03 Origin 検査は proxy に一本化されている', async ({ request }) => {
    const response = await request.post('/api/contact', {
      headers: { origin: EVIL, referer: `${EVIL}/contact` },
      data: {
        name: 'Cross Site User',
        email: 'cross-site@example.com',
        inquiryType: 'other',
        subject: 'Cross site test',
        message: 'This should be blocked.',
      },
    });

    expect(response.status()).toBe(403);
    // ルート固有の実装（{ success: false, ... }）ではなく proxy の応答が返ること。
    expect(await response.json()).toEqual({ error: 'Forbidden origin' });
  });

  test('AC-02 /api 配下でないパスへの POST は検査しない', async ({ request }) => {
    const response = await request.post('/checkout', {
      headers: { origin: EVIL },
      data: {},
    });

    expect(response.status()).not.toBe(403);
  });
});
