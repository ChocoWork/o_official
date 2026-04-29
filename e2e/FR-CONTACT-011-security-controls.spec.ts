import { expect, test } from '@playwright/test';

test.describe('FR-CONTACT-011 問い合わせAPIセキュリティ制御', () => {
  test('異なる Origin の送信を拒否する', async ({ request }) => {
    const response = await request.post('/api/contact', {
      headers: {
        origin: 'https://evil.example.com',
        referer: 'https://evil.example.com/contact',
      },
      data: {
        name: 'Cross Site User',
        email: 'cross-site@example.com',
        inquiryType: 'other',
        subject: 'Cross site test',
        message: 'This should be blocked.',
      },
    });

    expect(response.status()).toBe(403);
    const json = await response.json();
    expect(json).toEqual({ success: false, error: 'Forbidden origin' });
  });

  test('honeypot 入力ありの送信を拒否する', async ({ request }) => {
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';

    const response = await request.post('/api/contact', {
      headers: {
        origin: baseUrl,
        referer: `${baseUrl}/contact`,
      },
      data: {
        name: 'Bot User',
        email: 'bot-user@example.com',
        inquiryType: 'other',
        subject: 'Bot spam',
        message: 'Spam message',
        website: 'https://spam.example.com',
      },
    });

    expect(response.status()).toBe(403);
    const json = await response.json();
    expect(json).toEqual({ success: false, error: 'Bot detection failed' });
  });
});
