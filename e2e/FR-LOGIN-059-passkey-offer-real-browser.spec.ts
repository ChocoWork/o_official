/**
 * FR-LOGIN-059 メールのコードの後のパスキーの勧め（/login/passkey）と、本物のブラウザでの往復
 * 対応: FR-AUTH-028-AC-01〜07（設計: DD-AUTH-064）
 *
 * Chromium の仮想の認証器（CDP。e2e/passkey-virtual-authenticator.ts）で、`navigator.credentials` を本物のまま動かす。
 * 本物の `toJSON()` は無い項目（`authenticatorAttachment`）を `null` で返しうる。その応答が、作る（register/finish）・ログイン（login/finish）の
 * 窓口で 400 にならないこと（1b の持ち越し T2 M12）を、AC-01・AC-02 の往復で確かめる。
 * 手元のアプリ（本番ビルド）・手元の Supabase・手元の Mailpit で流す。会員ごとに別のアドレス、試験ごとに別の x-real-ip
 * （`playwright.config.ts` が文脈ごとに付ける）。保留の Cookie・コードが通信記録に残るので `trace` は取らない。仮想の認証器は試験の終わりで必ず外す。
 */
import { randomBytes, randomInt } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { readLatestCode, readMailpitMessages } from './member-session-helpers';
import { addVirtualAuthenticator, type VirtualAuthenticator } from './passkey-virtual-authenticator';

test.use({ trace: 'off' });

const ORIGIN = 'http://localhost:3000';
const VALID_TURNSTILE_TOKEN = 'test-turnstile-token';
// 確定の応答・状態の更新・移動は、同時に走る他の試験で遅れることがある。
const NAVIGATION = { timeout: 15_000 };

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

function uniqueIp(): string {
  return `198.19.${randomInt(0, 256)}.${randomInt(1, 255)}`;
}

function uniqueEmail(label: string): string {
  return `e2e-passkey-offer-${label}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}@example.com`;
}

/** メールのコードでログインし、`/login/code` の確定を押すところまで進める。行き先は呼び出し側が確かめる。 */
async function signInByCode(page: Page, email: string, next?: string): Promise<void> {
  const previous = new Set((await readMailpitMessages(email)).map((message) => message.ID));
  const started = await page.request.post('/api/auth/email-code/start', {
    headers: { origin: ORIGIN, 'x-real-ip': uniqueIp() },
    data: { email, turnstileToken: VALID_TURNSTILE_TOKEN, ...(next ? { next } : {}) },
    maxRedirects: 0,
  });
  expect(started.status()).toBe(202);
  const code = await readLatestCode(email, previous);

  await page.goto('/login/code');
  await page.getByLabel('確認コード 1桁目').click();
  await page.keyboard.type(code);
  await expect(page.getByLabel('確認コード 8桁目')).toHaveValue(code[7]);
  await page.getByRole('button', { name: 'ログイン' }).click();
}

/** 新規のお客さんがコードで入り、勧めの画面でパスキーを作り、続けるまで。 */
async function registerThroughOffer(page: Page, email: string): Promise<void> {
  await signInByCode(page, email);
  await expect(page).toHaveURL(`${ORIGIN}/login/passkey`, NAVIGATION);
  await page.getByRole('button', { name: 'パスキーを作る' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'パスキーを作りました。' })).toBeVisible();
  await page.getByRole('button', { name: '続ける' }).click();
  await expect(page).toHaveURL(`${ORIGIN}/`, NAVIGATION);
}

/** 本物のログアウトの窓口（CSRF の Cookie を付ける）。 */
async function logout(page: Page): Promise<void> {
  const csrf = (await page.context().cookies(ORIGIN)).find((cookie) => cookie.name === 'sb-csrf-token')?.value;
  expect(csrf).toBeTruthy();
  const response = await page.request.post('/api/auth/logout', { headers: { origin: ORIGIN, 'x-csrf-token': csrf! } });
  expect(response.ok()).toBe(true);
}

async function isSignedIn(page: Page): Promise<boolean> {
  const me = await page.request.get('/api/auth/me');
  return ((await me.json()) as { authenticated?: boolean }).authenticated === true;
}

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-059 passkey offer real browser (${viewport.name})`, () => {
    let authenticator: VirtualAuthenticator | undefined;

    test.beforeEach(async ({ page, browserName }) => {
      test.skip(browserName !== 'chromium', '仮想の認証器は Chromium だけ');
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test.afterEach(async () => {
      await authenticator?.remove();
      authenticator = undefined;
    });

    test(`FR-AUTH-028-AC-01 ${viewport.name}: 新規のお客さんがコードで入ると勧めが出て、作ると鍵が1つ入り、「続ける」で行き先へ着く`, async ({ page }) => {
      authenticator = await addVirtualAuthenticator(page);
      const finishBodies: Array<Record<string, unknown>> = [];
      page.on('request', (request) => {
        if (request.url().endsWith('/api/auth/passkey/register/finish') && request.method() === 'POST') {
          finishBodies.push(JSON.parse(request.postData() ?? '{}') as Record<string, unknown>);
        }
      });

      await signInByCode(page, uniqueEmail('create'));

      await expect(page).toHaveURL(`${ORIGIN}/login/passkey`, NAVIGATION);
      const heading = page.getByRole('heading', { name: 'パスキーを作りませんか' });
      await expect(heading).toBeFocused();
      await expect(
        page.getByText('次回からは、この端末の顔認証・指紋・PIN でログインできます。メールでコードを待つ必要はありません。'),
      ).toBeVisible();
      await expect(page.getByText('あとからでも、アカウントの「ログイン方法」で作れます。')).toBeVisible();

      await page.getByRole('button', { name: 'パスキーを作る' }).click();

      await expect(page.getByRole('status').filter({ hasText: 'パスキーを作りました。' })).toBeVisible();
      // 自動では進まない。「続ける」へフォーカスが移り、しばらく待っても同じ画面にいる。
      await expect(page.getByRole('button', { name: '続ける' })).toBeFocused();
      await page.waitForTimeout(2000);
      await expect(page).toHaveURL(`${ORIGIN}/login/passkey`, NAVIGATION);
      expect(await authenticator.credentials()).toHaveLength(1);
      // 本物のブラウザの応答の形が、作る窓口を通る。仮想の認証器（internal）は結びつきを 'platform' で返し、`null` は出ない。
      // `null` を落とす分岐そのものは Task 2 の単体で確かめる（T2 M12。`null` を送る端末・ブラウザは開店前に実機で確かめる）。
      expect(finishBodies.length).toBe(1);
      expect((finishBodies[0].credential as Record<string, unknown>).authenticatorAttachment).toBe('platform');

      await page.getByRole('button', { name: '続ける' }).click();
      await expect(page).toHaveURL(`${ORIGIN}/`, NAVIGATION);
      expect(await isSignedIn(page)).toBe(true);
    });

    test(`FR-AUTH-028-AC-02 ${viewport.name}: ログアウトして「パスキーでログイン」を押すと、本物のブラウザの応答でログインできる`, async ({ page }) => {
      authenticator = await addVirtualAuthenticator(page);
      await registerThroughOffer(page, uniqueEmail('login'));

      await logout(page);
      expect(await isSignedIn(page)).toBe(false);
      await page.goto('/login');
      await page.getByRole('button', { name: 'パスキーでログイン' }).click();

      await expect(page).toHaveURL(`${ORIGIN}/`, NAVIGATION);
      expect(await isSignedIn(page)).toBe(true);
    });

    test(`FR-AUTH-028-AC-03 ${viewport.name}: 鍵を持つお客さんがもう一度コードで入ると、勧めを出さずに行き先へ着く`, async ({ page }) => {
      authenticator = await addVirtualAuthenticator(page);
      const email = uniqueEmail('again');
      await registerThroughOffer(page, email);

      await logout(page);
      // 手元の GoTrue は同じアドレスへの送信に1秒の間隔を置く。
      await page.waitForTimeout(1500);
      await signInByCode(page, email);

      await expect(page).toHaveURL(`${ORIGIN}/`, NAVIGATION);
      expect(await authenticator.credentials()).toHaveLength(1);
      expect(await isSignedIn(page)).toBe(true);
    });

    test(`FR-AUTH-028-AC-04 ${viewport.name}: 本人確認ができない認証器では作成が中止され、終わりの窓口は呼ばれず、先へ進める`, async ({ page }) => {
      authenticator = await addVirtualAuthenticator(page, { userVerified: false });
      let finishCalls = 0;
      page.on('request', (request) => {
        if (request.url().endsWith('/api/auth/passkey/register/finish')) finishCalls += 1;
      });

      await signInByCode(page, uniqueEmail('uv'));
      await expect(page).toHaveURL(`${ORIGIN}/login/passkey`, NAVIGATION);
      await page.getByRole('button', { name: 'パスキーを作る' }).click();

      await expect(page.getByRole('alert').filter({ hasText: 'パスキーの作成を中止しました。' })).toBeVisible();
      expect(finishCalls).toBe(0);
      expect(await authenticator.credentials()).toHaveLength(0);
      await expect(page.getByRole('button', { name: 'パスキーを作る' })).toBeEnabled();
      await page.getByRole('button', { name: 'あとで' }).click();
      await expect(page).toHaveURL(`${ORIGIN}/`, NAVIGATION);
    });

    test(`FR-AUTH-028-AC-05 ${viewport.name}: 「あとで」で、使い切られていない戻り先へ着く`, async ({ page }) => {
      authenticator = await addVirtualAuthenticator(page);
      await signInByCode(page, uniqueEmail('later'), '/stockist');

      await expect(page).toHaveURL(`${ORIGIN}/login/passkey`, NAVIGATION);
      await page.getByRole('button', { name: 'あとで' }).click();

      await expect(page).toHaveURL(`${ORIGIN}/stockist`, NAVIGATION);
      expect(await authenticator.credentials()).toHaveLength(0);
    });

    test(`FR-AUTH-028-AC-06 ${viewport.name}: パスキーに未対応のブラウザでは勧めを飛ばし、行き先へ着く`, async ({ page }) => {
      await page.addInitScript(() => {
        Object.defineProperty(window, 'PublicKeyCredential', { configurable: true, value: undefined });
      });

      await signInByCode(page, uniqueEmail('unsupported'));

      await expect(page).toHaveURL(`${ORIGIN}/`, NAVIGATION);
      expect(await isSignedIn(page)).toBe(true);
    });

    test(`FR-AUTH-028-AC-07 ${viewport.name}: ログインしていない人が /login/passkey を開くと /login へ送られ、勧めの画面は横にはみ出さない`, async ({ page }) => {
      await page.goto('/login/passkey');
      await expect(page).toHaveURL(`${ORIGIN}/login`, NAVIGATION);
      await expect(page.getByRole('heading', { name: 'パスキーを作りませんか' })).toHaveCount(0);

      authenticator = await addVirtualAuthenticator(page);
      await signInByCode(page, uniqueEmail('layout'));
      await expect(page.getByRole('heading', { name: 'パスキーを作りませんか' })).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      for (const name of ['パスキーを作る', 'あとで']) {
        const box = await page.getByRole('button', { name }).boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
        // 大きさは、リポジトリの Button（size md）にそのまま従う（ログインの画面どうしをそろえる）。
        await expect(page.getByRole('button', { name })).toHaveAttribute('data-ui-button-size', 'md');
      }
    });
  });
}
