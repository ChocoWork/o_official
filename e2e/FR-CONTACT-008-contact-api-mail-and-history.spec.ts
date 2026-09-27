import { expect, test } from '@playwright/test';

test.describe('FR-CONTACT-008 問い合わせAPI実装', () => {
  test('APIが問い合わせ受付と履歴保存処理を返す', async ({ request }) => {
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    // 同じメールアドレスは1時間5回までしか受け付けない（FREQ-360）。実行のたびに別のアドレスにする。
    const email = `api-tester+${Date.now()}@example.com`;

    const response = await request.post('/api/contact', {
      headers: {
        origin: baseUrl,
        referer: `${baseUrl}/contact`,
      },
      data: {
        name: 'APIテスト太郎',
        email,
        inquiryType: 'other',
        subject: 'APIテスト',
        message: 'APIルートの動作確認です。',
      },
    });

    expect(response.ok()).toBeTruthy();
    const json = await response.json();
    expect(json.success).toBeTruthy();
  });
});
