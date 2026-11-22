/**
 * FR-LOGIN-078 パスワードで作ったアカウント（確認済み・確認前）が、メールのコードで /account に入れ、鍵を足す勧めの画面が出る。店員は旗が真でも同じ断りの文で断られる
 * 対応: FR-AUTH-054-AC-01 / FR-AUTH-054-AC-02 / FR-AUTH-054-AC-03 / FR-AUTH-054-AC-04（上位: SR-AUTH-030）
 *
 * パスワードとコードのログインを消す前の基準で、消した後も意味が変わらない残す流れ。アカウントは spec の中で
 * `createUser({ email, password, email_confirm: true })` で作る（createTestMember に頼らない）。
 * AC-03 は旗 reject_customer_password（DB 全体に効く）を真にするので isolated-global（直列）に入れる（playwright.config.ts）。
 * 手元のアプリ（本番ビルド）・手元の Supabase・手元の Mailpit で流す。要求ごとに別の x-real-ip と origin を付ける。Turnstile は E2E の公式のテスト鍵（常に通る）。
 * 確認コードが通信記録に残らないよう trace は切る。
 */
import { randomBytes, randomInt } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { expect, test, type Page } from '@playwright/test';
import { provisionStaff } from '../scripts/e2e/passkey-staff';
import { readLatestCode, readMailpitMessages } from './member-session-helpers';
import { withLocalDb } from './order-email-test-utils';
import { withCustomerPasswordFlag } from './passkey-hook-scenarios';

test.use({ trace: 'off' });

const ORIGIN = 'http://localhost:3000';
const VALID_TURNSTILE_TOKEN = 'test-turnstile-token';
const STAFF_MESSAGE = '店員の方は、パスキーでログインしてください。';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

function uniqueIp(): string {
  return `198.${randomInt(16, 20)}.${randomInt(0, 256)}.${randomInt(1, 255)}`;
}

/** パスワード付き・確認済みのアカウントを手元の Supabase に作る（今の master で通る、消す前の形） */
async function createPasswordAccount(label: string): Promise<{ userId: string; email: string }> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const email = `e2e-legacy-${label}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}@example.com`;
  const created = await createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }).auth.admin
    .createUser({ email, password: `E2e-${randomBytes(12).toString('hex')}!`, email_confirm: true })
    .catch(() => {
      throw new Error('手元のアカウントを作る要求に失敗した');
    });
  if (created.error || !created.data.user) throw new Error(`手元のアカウントを作れない（status: ${created.error?.status ?? '不明'}）`);
  return { userId: created.data.user.id, email };
}

/** パスワード付き・確認前（email_confirm: false）のアカウントを手元の Supabase に作る（確認のメールは作った時には送られない） */
async function createUnconfirmedAccount(label: string): Promise<{ userId: string; email: string }> {
  const email = `e2e-legacy-${label}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}@example.com`;
  const created = await localAdmin().auth.admin
    .createUser({ email, password: `E2e-${randomBytes(12).toString('hex')}!`, email_confirm: false })
    .catch(() => {
      throw new Error('手元のアカウントを作る要求に失敗した');
    });
  if (created.error || !created.data.user) throw new Error(`手元のアカウントを作れない（status: ${created.error?.status ?? '不明'}）`);
  return { userId: created.data.user.id, email };
}

function localAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** 宛先に届いた最初のメールの件名・本文（テキストと HTML）を Mailpit から Node で読む（コードをブラウザの通信記録に載せないため）。 */
async function readFirstMail(email: string): Promise<{ subject: string; text: string; html: string }> {
  const base = process.env.MAIL_LOCAL_URL ?? '';
  await expect
    .poll(async () => (await readMailpitMessages(email)).length, { timeout: 30_000, message: '確認のメールが届く' })
    .toBeGreaterThan(0);
  const [first] = await readMailpitMessages(email);
  const response = await fetch(new URL(`/api/v1/message/${encodeURIComponent(first.ID)}`, base), {
    signal: AbortSignal.timeout(5_000),
    redirect: 'manual',
  });
  const body = (await response.json()) as { Subject?: string; Text?: string; HTML?: string };
  return { subject: body.Subject ?? '', text: body.Text ?? '', html: body.HTML ?? '' };
}

/** メールのコードを始める（202）。作った直後は GoTrue の送信の間隔（手元は1秒）の中なので、過ぎるまで待ってから呼ぶ */
async function startCode(page: Page, email: string): Promise<void> {
  const intervalEnds = Date.now() + 1_500;
  await expect.poll(() => Date.now() >= intervalEnds, { intervals: [100], timeout: 5_000 }).toBe(true);
  const started = await page.request.post('/api/auth/email-code/start', {
    headers: { origin: ORIGIN, 'x-real-ip': uniqueIp() },
    data: { email, turnstileToken: VALID_TURNSTILE_TOKEN },
    maxRedirects: 0,
  });
  expect(started.status()).toBe(202);
}

async function typeCode(page: Page, code: string): Promise<void> {
  await page.goto('/login/code');
  await page.getByLabel('確認コード 1桁目').click();
  await page.keyboard.type(code);
  await page.getByRole('button', { name: 'ログイン' }).click();
}

/** /account が会員の画面として開く（未ログインの「ログインが必要です」の画面ではない）ことを確かめる。未ログインでも URL は /account のまま変わらないため */
async function expectAccountOpenedAsMember(page: Page): Promise<void> {
  await page.goto('/account');
  await expect(page).toHaveURL(/\/account(\?|$|\/)/);
  await expect(page.getByText('読み込み中...')).toBeHidden();
  await expect(page.getByText('会員情報の確認には、ログインが必要です。')).toBeHidden();
}

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-078 legacy account email code login (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test(`FR-AUTH-054-AC-01 ${viewport.name}: パスワード付きで作った確認済みのアカウントが、メールのコードで /account に入れる`, async ({ page }) => {
      const account = await createPasswordAccount('in');
      await startCode(page, account.email);
      const code = await readLatestCode(account.email, new Set());

      const verified = await page.request.post('/api/auth/email-code/verify', {
        headers: { origin: ORIGIN, 'x-real-ip': uniqueIp() },
        data: { code },
        maxRedirects: 0,
      });
      expect(verified.status()).toBe(200);
      const body = (await verified.json()) as { user: { id: string; role: string } };
      expect(body.user.id).toBe(account.userId);
      expect(body.user.role).toBe('user');

      await expectAccountOpenedAsMember(page);
      const me = (await (await page.request.get('/api/auth/me')).json()) as { authenticated?: boolean; user?: { id?: string } };
      expect(me.authenticated).toBe(true);
      expect(me.user?.id).toBe(account.userId);
    });

    test(`FR-AUTH-054-AC-02 ${viewport.name}: 同じアカウントに、鍵を足せる勧めの画面（offerPasskey）が出る`, async ({ page }) => {
      const account = await createPasswordAccount('offer');
      await startCode(page, account.email);
      const code = await readLatestCode(account.email, new Set());

      await typeCode(page, code);

      await expect(page).toHaveURL(/\/login\/passkey/);
    });

    test(`FR-AUTH-054-AC-04 ${viewport.name}: 確認前のアカウントにも、リンクの無い8桁のコードの確認メールが届き、そのコードで /account に入れて確認済みになる`, async ({ page }) => {
      const account = await createUnconfirmedAccount('unconfirmed');
      const before = await localAdmin().auth.admin.getUserById(account.userId);
      expect(before.data.user?.email_confirmed_at ?? null, '作った直後は確認前（準備）').toBeNull();

      // /login/code の入口（POST /api/auth/email-code/start）を通す
      await startCode(page, account.email);
      const mail = await readFirstMail(account.email);
      expect(mail.subject, '確認前のアカウントには「メールアドレスの確認」のメールが届く').toBe('メールアドレスの確認');
      const mailText = `${mail.text}\n${mail.html.replace(/<[^>]*>/g, ' ')}`;
      expect(mailText.match(/\b(\d{8})\b/), '本文に8桁のコードがある').not.toBeNull();
      expect(/https?:\/\//.test(mail.text) || /<a\s/i.test(mail.html) || /href=/i.test(mail.html), '本文にリンクが無い').toBe(false);
      expect(mailText.includes('パスワード'), '本文にパスワードの案内が無い').toBe(false);

      const code = await readLatestCode(account.email, new Set());
      const verified = await page.request.post('/api/auth/email-code/verify', {
        headers: { origin: ORIGIN, 'x-real-ip': uniqueIp() },
        data: { code },
        maxRedirects: 0,
      });
      expect(verified.status()).toBe(200);

      await expectAccountOpenedAsMember(page);
      const me = (await (await page.request.get('/api/auth/me')).json()) as { authenticated?: boolean; user?: { id?: string } };
      expect(me.authenticated).toBe(true);
      expect(me.user?.id).toBe(account.userId);
      const after = await localAdmin().auth.admin.getUserById(account.userId);
      expect(after.data.user?.email_confirmed_at ?? null, 'コードを入れると確認済みになる').not.toBeNull();
    });

    // 店員の断り自体は FR-LOGIN-069（FR-AUTH-046-AC-04）が持つ。ここでは、旗が真でも断りの文が同じことだけを確かめる（確かめを繰り返さない）。
    test(`FR-AUTH-054-AC-03 ${viewport.name}: 店員は、お客さんの password を拒む旗が真でも、メールのコードで入ろうとすると同じ断りの文で断られる（店員の断り自体は FR-LOGIN-069 が持つ）`, async ({ page }) => {
      await withLocalDb(async (db) => {
        await withCustomerPasswordFlag(db, true, async () => {
          // 旗が本当に真の中で確かめる（既定のまま通る確かめにならないように）
          const flag = await db.query('select reject_customer_password as f from private.passkey_staff_config');
          expect(flag.rows[0].f).toBe(true);
          const staff = await provisionStaff(db, { role: 'admin', approvedPasskeys: 2 });
          await startCode(page, staff.email);
          const code = await readLatestCode(staff.email, new Set());

          await typeCode(page, code);

          await expect(page.getByText(STAFF_MESSAGE)).toBeVisible();
          const me = (await (await page.request.get('/api/auth/me')).json()) as { authenticated?: boolean };
          expect(me.authenticated).toBe(false);
        });
      });
    });
  });
}
