/**
 * FR-LOGIN-068 店員のパスキー管理の画面 /admin/passkeys と、認めた鍵が1本の店員の「もう1本」の画面
 * 対応: FR-AUTH-045-AC-01〜05、FR-AUTH-046-AC-01〜03（設計: SCR-AUTH-015、DD-AUTH-082、SEC-AUTH-055）
 *
 * 手元のアプリ（本番ビルド）・手元の Supabase で通しで確かめる。店員は provisionStaff（ソフトの認証器）で用意し、パスキーでログインして Cookie を得る
 * （page.request と画面は同じ Cookie）。鍵の追加は Chromium の仮想の認証器（CDP）で行う。仮想の認証器は試験の終わりで必ず外す。
 * 鍵の中身・トークンは、試験の文面にも出さない。
 */
import { expect, test, type Page } from '@playwright/test';
import { addUnapprovedPasskey, provisionStaff, skipPasskeyNotificationsOf } from '../scripts/e2e/passkey-staff';
import { withLocalDb } from './order-email-test-utils';
import { loginViaApp } from './passkey-app-api';
import { addVirtualAuthenticator, type VirtualAuthenticator } from './passkey-virtual-authenticator';

test.use({ trace: 'off' });

const ORIGIN = 'http://localhost:3000';
const NAVIGATION = { timeout: 30_000 };

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

function uniqueIp(): string {
  const octet = () => 1 + Math.floor(Math.random() * 253);
  return `10.${octet()}.${octet()}.${octet()}`;
}

type Staff = Awaited<ReturnType<typeof provisionStaff>>;

/** 認めた鍵が n 本の店員を用意し、パスキーでログインした Cookie を、画面と同じ文脈（page.request）に得る。 */
async function staffLoggedIn(page: Page, approvedPasskeys: 1 | 2): Promise<Staff> {
  const staff = await withLocalDb((db) => provisionStaff(db, { role: 'admin', approvedPasskeys }));
  const login = await loginViaApp(page.request, { authenticator: staff.authenticators[0], ip: uniqueIp() });
  expect(login.status).toBe(200);
  return staff;
}

async function keyCounts(userId: string): Promise<{ keys: number; approved: number }> {
  return withLocalDb(async (db) => {
    const keys = await db.query('select count(*)::int as n from auth.webauthn_credentials where user_id = $1::uuid', [userId]);
    const approved = await db.query('select count(*)::int as n from private.approved_passkeys where user_id = $1::uuid', [userId]);
    return { keys: keys.rows[0].n as number, approved: approved.rows[0].n as number };
  });
}

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-068 staff passkey manage (${viewport.name})`, () => {
    let authenticators: VirtualAuthenticator[] = [];
    let cleanup: string[] = [];

    test.beforeEach(async ({ page, browserName }) => {
      test.skip(browserName !== 'chromium', '仮想の認証器は Chromium だけ');
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test.afterEach(async () => {
      for (const authenticator of authenticators) await authenticator.remove();
      authenticators = [];
      for (const userId of cleanup) await withLocalDb((db) => skipPasskeyNotificationsOf(db, userId));
      cleanup = [];
    });

    test(`FR-AUTH-045-AC-01 ${viewport.name}: 一覧に鍵の名前・作成日・最後に使った日が出る`, async ({ page }) => {
      test.setTimeout(120_000);
      const staff = await staffLoggedIn(page, 2);
      cleanup.push(staff.userId);
      await page.goto('/admin/passkeys');
      await expect(page.getByRole('heading', { name: 'パスキー', level: 1 })).toBeVisible(NAVIGATION);
      const items = page.locator('main ul > li');
      await expect(items).toHaveCount(2);
      await expect(items.first()).toContainText('に作成');
      await expect(page.getByText(/最後に使った日: \d{4}年\d{1,2}月\d{1,2}日/).first()).toBeVisible();
    });

    test(`FR-AUTH-045-AC-02 ${viewport.name}: 鍵の名前を変えられる`, async ({ page }) => {
      test.setTimeout(120_000);
      const staff = await staffLoggedIn(page, 2);
      cleanup.push(staff.userId);
      await page.goto('/admin/passkeys');
      await expect(page.locator('main ul > li')).toHaveCount(2, NAVIGATION);
      await page.getByRole('button', { name: /の名前を変更$/ }).first().click();
      await page.getByRole('textbox', { name: '名前' }).fill('店のパソコン');
      await page.getByRole('button', { name: '保存' }).click();
      await expect(page.getByText('店のパソコン')).toBeVisible();
      await page.reload();
      await expect(page.getByText('店のパソコン')).toBeVisible(NAVIGATION);
    });

    test(`FR-AUTH-045-AC-03 ${viewport.name}: 認めた鍵が2本の店員は、削除ボタンが無効で、窓口も 409 staff_min_keys で、鍵が残る`, async ({ page }) => {
      test.setTimeout(120_000);
      const staff = await staffLoggedIn(page, 2);
      cleanup.push(staff.userId);
      await page.goto('/admin/passkeys');
      await expect(page.locator('main ul > li')).toHaveCount(2, NAVIGATION);
      for (const button of await page.getByRole('button', { name: /を削除$/ }).all()) await expect(button).toBeDisabled();
      await expect(page.getByText('パスキーは2本以上必要です。先に別のパスキーを登録してください。').first()).toBeVisible();

      const list = (await (await page.request.get('/api/auth/passkey', { headers: { 'x-real-ip': uniqueIp() } })).json()) as {
        passkeys: Array<{ id: string }>;
      };
      const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'sb-csrf-token')?.value ?? '';
      const blocked = await page.request.delete(`/api/auth/passkey/${list.passkeys[0].id}`, {
        headers: { origin: ORIGIN, 'x-real-ip': uniqueIp(), 'x-csrf-token': csrf },
        failOnStatusCode: false,
      });
      expect(blocked.status()).toBe(409);
      expect(await blocked.json()).toEqual({ error: 'staff_min_keys' });
      expect(await keyCounts(staff.userId)).toEqual({ keys: 2, approved: 2 });
    });

    test(`FR-AUTH-045-AC-04 ${viewport.name}: 入り直した直後に3本目を追加すると、1本消せて、認めた鍵は2本に戻る`, async ({ page }) => {
      test.setTimeout(180_000);
      const staff = await staffLoggedIn(page, 2);
      cleanup.push(staff.userId);
      authenticators.push(await addVirtualAuthenticator(page));
      await page.goto('/admin/passkeys');
      await expect(page.locator('main ul > li')).toHaveCount(2, NAVIGATION);

      await page.getByRole('button', { name: 'パスキーを追加' }).click();
      await expect(page.getByText('パスキーを追加しました。')).toBeVisible(NAVIGATION);
      await expect(page.locator('main ul > li')).toHaveCount(3);
      expect(await keyCounts(staff.userId)).toEqual({ keys: 3, approved: 3 });

      await page.getByRole('button', { name: /を削除$/ }).first().click();
      await page.getByRole('button', { name: '削除する' }).click();
      await expect(page.getByText('パスキーを削除しました。')).toBeVisible(NAVIGATION);
      await expect(page.locator('main ul > li')).toHaveCount(2);
      expect(await keyCounts(staff.userId)).toEqual({ keys: 2, approved: 2 });
      for (const button of await page.getByRole('button', { name: /を削除$/ }).all()) await expect(button).toBeDisabled();
    });

    test(`FR-AUTH-045-AC-05 ${viewport.name}: 5分を過ぎたら、追加は「安全のため、もう一度パスキーでログインしてから追加してください。」と「パスキーでログインし直す」になる`, async ({ page }) => {
      test.setTimeout(180_000);
      const staff = await staffLoggedIn(page, 2);
      cleanup.push(staff.userId);
      // パスキーのログインの印（amr）を6分前にしたセッションを作るのは難しいので、窓口の答えを読み替える部分だけを、画面で確かめる。
      authenticators.push(await addVirtualAuthenticator(page));
      await page.route('**/api/auth/passkey/register/start', (route) =>
        route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'registration_not_allowed', reason: 'reauth_required' }) }),
      );
      await page.goto('/admin/passkeys');
      await expect(page.locator('main ul > li')).toHaveCount(2, NAVIGATION);
      await page.getByRole('button', { name: 'パスキーを追加' }).click();
      await expect(page.getByText('安全のため、もう一度パスキーでログインしてから追加してください。')).toBeVisible(NAVIGATION);
      await expect(page.getByRole('link', { name: 'パスキーでログインし直す' })).toHaveAttribute('href', '/login?next=%2Fadmin%2Fpasskeys');
    });

    test(`FR-AUTH-046-AC-01 ${viewport.name}: 認めた鍵が1本の店員が /auth/verified に来ると、「もう1本」の画面に着き、/auth/verified へは戻らない`, async ({ page }) => {
      test.setTimeout(120_000);
      const staff = await staffLoggedIn(page, 1);
      cleanup.push(staff.userId);
      // 回り続けないことの確かめ: /auth/verified への要求（文書も RSC も）を数える。着いた後に増えないこと。
      const verifiedRequests: string[] = [];
      page.on('request', (req) => {
        if (new URL(req.url()).pathname === '/auth/verified') verifiedRequests.push(req.url());
      });
      await page.goto('/auth/verified');
      await expect(page).toHaveURL(`${ORIGIN}/admin/passkeys?more=1`, NAVIGATION);
      await expect(page.getByRole('heading', { name: 'あと1本、登録してください' })).toBeVisible();
      await page.waitForTimeout(1500);
      expect(page.url()).toBe(`${ORIGIN}/admin/passkeys?more=1`);
      expect(verifiedRequests).toHaveLength(1);
    });

    test(`FR-AUTH-046-AC-02 ${viewport.name}: 「もう1本」の画面で2本目を追加すると /admin に入れる`, async ({ page }) => {
      test.setTimeout(180_000);
      const staff = await staffLoggedIn(page, 1);
      cleanup.push(staff.userId);
      authenticators.push(await addVirtualAuthenticator(page));
      await page.goto('/admin/passkeys?more=1');
      await expect(page.getByRole('heading', { name: 'あと1本、登録してください' })).toBeVisible(NAVIGATION);
      await page.getByRole('button', { name: '2本目を登録' }).click();
      await expect(page).toHaveURL(`${ORIGIN}/admin`, NAVIGATION);
      expect(await keyCounts(staff.userId)).toEqual({ keys: 2, approved: 2 });
      await expect(page.getByRole('navigation', { name: '管理メニュー' })).toBeVisible(NAVIGATION);
      await expect(page.getByRole('link', { name: 'パスキー' })).toHaveAttribute('href', '/admin/passkeys');
    });

    test(`FR-AUTH-046-AC-03 ${viewport.name}: GoTrue を直に叩いて足した鍵は、認めた鍵に数えられず、その鍵では店員として入れず、画面から削除できる`, async ({ page, request }) => {
      test.setTimeout(180_000);
      const staff = await staffLoggedIn(page, 2);
      cleanup.push(staff.userId);
      const direct = await addUnapprovedPasskey({ email: staff.email, authenticator: staff.authenticators[0] });
      expect(await keyCounts(staff.userId)).toEqual({ keys: 3, approved: 2 });

      const entered = await loginViaApp(request, { authenticator: direct.authenticator, ip: uniqueIp() });
      expect(entered.status).toBe(403);

      await page.goto('/admin/passkeys');
      await expect(page.locator('main ul > li')).toHaveCount(3, NAVIGATION);
      await expect(page.getByText('この鍵ではログインできません。心当たりがなければ削除してください。')).toBeVisible();
      // 認めていない鍵だけが消せる（認めた鍵は2本のまま）
      const enabled = page.getByRole('button', { name: /を削除$/ }).and(page.locator(':enabled'));
      await expect(enabled).toHaveCount(1);
      await enabled.click();
      await page.getByRole('button', { name: '削除する' }).click();
      await expect(page.getByText('パスキーを削除しました。')).toBeVisible(NAVIGATION);
      expect(await keyCounts(staff.userId)).toEqual({ keys: 2, approved: 2 });
    });
  });
}
