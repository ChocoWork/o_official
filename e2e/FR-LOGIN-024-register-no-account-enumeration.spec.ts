import { randomBytes, randomInt } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';
import { createTestMember } from './member-session-helpers';
import { withLocalDb } from './order-email-test-utils';
import { stubTurnstileScript } from './turnstile-test-utils';

// FREQ-320: 会員登録の応答から「そのメールが登録済みか」を判別できないようにする
//
// 手元の Supabase に本物の会員を作り、登録済みのアドレスで /api/auth/register を叩く。
// Turnstile は .env.local の常に通る鍵（トークンは適当な文字列でよい）。
// 注: 手元の supabase/config.toml は enable_confirmations = false なので、未登録のアドレスは 201（その場でログイン）、
// 登録済みは 202 になり、応答が一致しない。本番と同じ Confirm email ON にするまで、
// FREQ-320-AC-03 は状態の不一致で失敗する（設定の差。コードの欠陥ではない）。

test.use({ trace: 'off' });

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

// FREQ-323 で最小長を 16 文字にしたため、フィクスチャもそれ以上にする。
// 15 文字以下だと送信ボタンが無効のままで、AC を一度も検証しない。
const VALID_PASSWORD = 'Passw0rd!2026-enum-check';

const ENUMERATION_WORDS = /既に登録|すでに登録|already registered|Email already registered/i;

/** 試験ごとに違う送り元（198.18.0.0/15）。IP 単位の回数の制限（20 回／時）を他の試験と分ける */
function uniqueForwardedFor(): string {
  return `198.18.${randomInt(0, 256)}.${randomInt(1, 255)}`;
}

function uniqueEmail(label: string): string {
  return `e2e-enum-${label}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}@example.com`;
}

/** 試験が作った会員を消す。登録の窓口が作った会員は id を知らないので、メールから引く */
async function removeUsersByEmail(emails: string[]): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !isLocalUrl(url)) {
    throw new Error('会員を消せるのは手元の Supabase だけ');
  }
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const ids = await withLocalDb(async (db) =>
    (await db.query('select id from auth.users where email = any($1::text[])', [emails])).rows.map((row) => row.id as string),
  );
  for (const id of ids) {
    await admin.auth.admin.deleteUser(id).catch(() => undefined);
  }
}

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-024 register account enumeration (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    // FREQ-320-AC-04
    test('FREQ-320-AC-04 the register form never reveals that an address is already taken', async ({ page }) => {
      const registered = await createTestMember('enum-ui');
      try {
        await stubTurnstileScript(page);
        const sourceIp = uniqueForwardedFor();
        await page.route('**/api/auth/register', (route) =>
          route.continue({ headers: { ...route.request().headers(), 'x-real-ip': sourceIp } }),
        );

        await page.goto('/login');
        await page.getByRole('tab', { name: '会員登録' }).click();

        const panel = page.getByRole('tabpanel');
        await expect(panel).toBeVisible();

        await panel.getByLabel('Email').fill(registered.email);
        await panel.getByLabel('Password', { exact: true }).fill(VALID_PASSWORD);
        // 確認用パスワードを埋めないと送信ボタンが無効のままで、AC を一度も検証しない。
        await panel.getByLabel('Confirm Password', { exact: true }).fill(VALID_PASSWORD);
        // ボット検証の印が入るまで送らない（入る前だと「ボット検証を完了してください」で止まる）。
        await expect(page.locator('input[name="cf-turnstile-response"]')).not.toHaveValue('');

        // 送信の結果が返り、画面に結果が出てから、登録済みを示す文言が無いことを見る
        const responsePromise = page.waitForResponse('**/api/auth/register');
        await panel.getByRole('button', { name: '登録して確認メールを受け取る' }).click();
        const response = await responsePromise;
        expect(response.status(), '登録済みのアドレスは公開の登録の受け付け（202）として扱われる').toBe(202);
        await expect(page.getByText(/確認メールを送信しました|Confirmation email sent/)).toBeVisible();

        await expect(page.locator('body')).not.toHaveText(ENUMERATION_WORDS);
      } finally {
        await removeUsersByEmail([registered.email]);
      }
    });
  });
}

test.describe('FR-LOGIN-024 register account enumeration (API contract)', () => {
  // FREQ-320-AC-03: 409 は廃止した。登録済みと未登録で状態・本文が完全に一致する
  // HTTP だけの試験なので画面の幅は結果を変えない（1 本だけ流す）。
  test('FREQ-320-AC-03 a registered and an unregistered address get the same status and body, never 409', async ({ request, baseURL }) => {
    test.fail(true, 'ENV enable_confirmations=false（会員登録が 201 で即ログインになり、本番の 202 にならない） — 手元の supabase/config.toml が本番と違う');
    const registered = await createTestMember('enum-api');
    const unregisteredEmail = uniqueEmail('unregistered');
    const origin = new URL(baseURL ?? 'http://localhost:3000').origin;
    const post = (email: string) =>
      request.post('/api/auth/register', {
        headers: { origin, 'x-real-ip': uniqueForwardedFor() },
        data: { email, password: VALID_PASSWORD, turnstileToken: 'e2e-probe' },
        failOnStatusCode: false,
      });

    try {
      const registeredResponse = await post(registered.email);
      const unregisteredResponse = await post(unregisteredEmail);
      const registeredText = await registeredResponse.text();
      const unregisteredText = await unregisteredResponse.text();

      // 窓口自身が受け付けた応答である（proxy の 403・Turnstile の 403 では何も確かめられない）
      expect([registeredResponse.status(), unregisteredResponse.status()]).not.toContain(403);
      expect(registeredResponse.status()).not.toBe(409);
      expect(unregisteredResponse.status()).not.toBe(409);
      // 状態と本文が完全に一致する
      expect(registeredResponse.status()).toBe(unregisteredResponse.status());
      expect(registeredText).toBe(unregisteredText);
      // 本文に登録済みを示す語が無い
      expect(registeredText).not.toMatch(ENUMERATION_WORDS);
      expect(registeredText).not.toMatch(/already/i);
      expect(registeredText).not.toContain('登録済み');
    } finally {
      await removeUsersByEmail([registered.email, unregisteredEmail]);
    }
  });
});
