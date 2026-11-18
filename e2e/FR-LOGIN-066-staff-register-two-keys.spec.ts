/**
 * FR-LOGIN-066 店員の2本の登録の画面 /staff/register と、役割の有効化（招待 → 押す → 1本目 → 2本目 → 完了 → /login）
 * 対応: FR-AUTH-043-AC-02・04〜08（設計: SCR-AUTH-014、API-AUTH-038、DD-AUTH-080）
 *
 * 手元の Supabase とアプリ（本番ビルド）で、Chromium の仮想の認証器（CDP）を2つ使って通しで確かめる。
 * 招待は DB の窓口 `private.staff_invite_issue_manual`（postgres 専用）で出し、合言葉の URL を画面で開く。
 * 鍵の中身・合言葉は、試験の文面にも出さない。仮想の認証器は試験の終わりで必ず外す。
 * 1本目と2本目は別の認証器（同じ認証器だと、登録の除外の一覧で2本目が断られる）。ログインは2本目の認証器で行う。
 */
import { expect, test, type Page } from '@playwright/test';
import { randomInt } from 'node:crypto';
import { skipPasskeyNotificationsOf, provisionPasskeyUser, provisionStaff } from '../scripts/e2e/passkey-staff';
import { bearerHeaders, createAdminSessionActor, seedVerifiedMfaFactor } from './admin-session-test-utils';
import { mailBodies, withLocalDb } from './order-email-test-utils';
import { addVirtualAuthenticator, type VirtualAuthenticator } from './passkey-virtual-authenticator';

test.use({ trace: 'off' });

const ORIGIN = 'http://localhost:3000';
const NAVIGATION = { timeout: 15_000 };
const DONE_MESSAGE = '登録が終わりました。パスキーでログインしてください。';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

type Invited = { userId: string; email: string; token: string };

/** お客さんの扱いの利用者を作り、DB の窓口で店長の招待を出す。`totp` なら、出す前に検証済みの2要素を持たせる。 */
async function issueInvite(options: { totp?: boolean } = {}): Promise<Invited> {
  return withLocalDb(async (db) => {
    const user = await provisionPasskeyUser(db, { approvedPasskeys: 0 });
    if (options.totp) await seedVerifiedMfaFactor(db, user.userId);
    const result = await db.query('select private.staff_invite_issue_manual($1, $2, $3) as token', [user.email, 'admin', 3600]);
    return { userId: user.userId, email: user.email, token: result.rows[0].token as string };
  });
}

/** メールのリンクを開き、「登録を始める」を押して /staff/register に着く。 */
async function enterRegisterScreen(page: Page, token: string): Promise<void> {
  await page.goto(`/staff/invite#${token}`);
  await page.getByRole('button', { name: '登録を始める' }).click();
  await expect(page).toHaveURL(`${ORIGIN}/staff/register`, NAVIGATION);
  await expect(page.getByRole('heading', { name: 'パスキーを2本登録してください' })).toBeVisible();
}

/** 1本目を登録して、2本目の前のおすすめの文が出るまで。 */
async function registerFirstKey(page: Page): Promise<void> {
  await page.getByRole('button', { name: '1本目を登録' }).click();
  await expect(page.getByText('別の端末か、セキュリティキーでの登録をおすすめします。')).toBeVisible(NAVIGATION);
  await expect(page.getByRole('button', { name: '2本目を登録' })).toBeVisible();
}

/** 招待を開いて、別々の仮想の認証器で2本登録し、完了の文が出るまで。ログインに使う2本目の認証器を返す。 */
async function registerTwoKeys(page: Page, invited: Invited): Promise<VirtualAuthenticator> {
  const first = await addVirtualAuthenticator(page);
  try {
    await enterRegisterScreen(page, invited.token);
    await registerFirstKey(page);
    expect(await first.credentials()).toHaveLength(1);
  } finally {
    await first.remove();
  }
  const second = await addVirtualAuthenticator(page);
  await page.getByRole('button', { name: '2本目を登録' }).click();
  await expect(page.getByText(DONE_MESSAGE)).toBeVisible(NAVIGATION);
  expect(await second.credentials()).toHaveLength(1);
  return second;
}

async function roleOf(userId: string): Promise<string[]> {
  return withLocalDb(async (db) =>
    (
      await db.query(
        'select r.code from public.user_roles ur join public.roles r on r.id = ur.role_id where ur.user_id = $1::uuid and ur.active order by r.code',
        [userId],
      )
    ).rows.map((row: { code: string }) => row.code),
  );
}

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-066 staff register two keys (${viewport.name})`, () => {
    let authenticators: VirtualAuthenticator[] = [];

    test.beforeEach(async ({ page, browserName }) => {
      test.skip(browserName !== 'chromium', '仮想の認証器は Chromium だけ');
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test.afterEach(async () => {
      for (const authenticator of authenticators) await authenticator.remove();
      authenticators = [];
    });

    test(`FR-AUTH-043-AC-04 ${viewport.name}: 招待 → 押す → 1本目 → 2本目 → 完了で、役割が有効・鍵2本が window で認められ・招待が使用済みになり、/login へ送られる`, async ({ page }) => {
      test.setTimeout(180_000);
      const invited = await issueInvite();
      expect(await roleOf(invited.userId)).toEqual([]);

      authenticators.push(await registerTwoKeys(page, invited));

      expect(await roleOf(invited.userId)).toEqual(['admin']);
      const approved = await withLocalDb(async (db) =>
        (await db.query('select approved_via from private.approved_passkeys where user_id = $1::uuid', [invited.userId])).rows.map(
          (row: { approved_via: string }) => row.approved_via,
        ),
      );
      expect(approved).toEqual(['window', 'window']);
      const invite = await withLocalDb(async (db) =>
        (await db.query('select activated_at, cancelled_at from private.staff_invites where user_id = $1::uuid', [invited.userId])).rows[0],
      );
      expect(invite.activated_at).not.toBeNull();
      expect(invite.cancelled_at).toBeNull();
      // 完了の窓口が全ログインを終わらせ、Cookie を消している
      const me = await page.request.get('/api/auth/me');
      expect(((await me.json()) as { authenticated?: boolean }).authenticated).toBe(false);

      await page.getByRole('button', { name: 'ログインへ' }).click();
      await expect(page).toHaveURL(`${ORIGIN}/login`, NAVIGATION);
      await withLocalDb((db) => skipPasskeyNotificationsOf(db, invited.userId));
    });

    test(`FR-AUTH-043-AC-01 ${viewport.name}: 1本だけで「登録を完了する」を押すと「あと1本、登録してください。」が出て、役割は有効にならない`, async ({ page }) => {
      test.setTimeout(120_000);
      const invited = await issueInvite();
      authenticators.push(await addVirtualAuthenticator(page));
      await enterRegisterScreen(page, invited.token);
      await registerFirstKey(page);

      const complete = page.waitForResponse((response) => response.url().endsWith('/api/auth/staff/register/complete'));
      await page.getByRole('button', { name: '登録を完了する' }).click();
      expect((await complete).status()).toBe(409);
      await expect(page.getByText('あと1本、登録してください。')).toBeVisible(NAVIGATION);
      await expect(page.getByRole('button', { name: '2本目を登録' })).toBeVisible();
      expect(await roleOf(invited.userId)).toEqual([]);
      // ログインは終わっておらず、そのまま2本目に進める
      const me = await page.request.get('/api/auth/me');
      expect(((await me.json()) as { authenticated?: boolean }).authenticated).toBe(true);
      await withLocalDb((db) => skipPasskeyNotificationsOf(db, invited.userId));
    });

    test(`FR-AUTH-043-AC-03 ${viewport.name}: 完了の応答が認証の Cookie を消し、それまでのアクセストークンはもう使えない`, async ({ page }) => {
      test.setTimeout(180_000);
      const invited = await issueInvite();
      const first = await addVirtualAuthenticator(page);
      await enterRegisterScreen(page, invited.token);
      await registerFirstKey(page);
      await first.remove();
      const accessToken = (await page.context().cookies(ORIGIN)).find((cookie) => cookie.name === 'sb-access-token')?.value;
      expect(accessToken).toBeTruthy();
      authenticators.push(await addVirtualAuthenticator(page));

      const complete = page.waitForResponse((response) => response.url().endsWith('/api/auth/staff/register/complete'));
      await page.getByRole('button', { name: '2本目を登録' }).click();
      const response = await complete;
      expect(response.status()).toBe(200);
      expect(response.headers()['cache-control']).toContain('no-store');
      const setCookies = (await response.headersArray()).filter((header) => header.name.toLowerCase() === 'set-cookie').map((header) => header.value);
      for (const name of ['sb-access-token', 'sb-refresh-token', 'sb-csrf-token']) {
        expect(setCookies.some((value) => value.startsWith(`${name}=;`))).toBe(true);
      }
      await expect(page.getByText(DONE_MESSAGE)).toBeVisible(NAVIGATION);

      const stale = await page.request.get('/api/auth/passkey', {
        headers: { Authorization: `Bearer ${accessToken}` },
        failOnStatusCode: false,
      });
      expect(stale.status()).toBe(401);
      // 役割が有効になった後でも、招待のセッションのトークンでは管理の窓口に入れない
      const staleAdmin = await page.request.get('/api/admin/users', {
        headers: { Authorization: `Bearer ${accessToken}` },
        failOnStatusCode: false,
      });
      expect(staleAdmin.status()).not.toBe(200);
      expect([401, 403]).toContain(staleAdmin.status());
      await withLocalDb((db) => skipPasskeyNotificationsOf(db, invited.userId));
    });

    test(`FR-AUTH-043-AC-05 ${viewport.name}: 登録した認証器で /login からパスキーでログインでき、/admin に入れる`, async ({ page }) => {
      test.setTimeout(180_000);
      const invited = await issueInvite();
      authenticators.push(await registerTwoKeys(page, invited));
      await withLocalDb((db) => skipPasskeyNotificationsOf(db, invited.userId));

      await page.getByRole('button', { name: 'ログインへ' }).click();
      await expect(page).toHaveURL(`${ORIGIN}/login`, NAVIGATION);
      await page.getByRole('button', { name: 'パスキーでログイン' }).click();
      await expect(page).toHaveURL(new RegExp(`^${ORIGIN}/admin`), NAVIGATION);

      const me = await page.request.get('/api/auth/me');
      const body = (await me.json()) as { authenticated?: boolean; user?: { id?: string; role?: string } };
      expect(body.authenticated).toBe(true);
      expect(body.user?.id).toBe(invited.userId);
      expect(body.user?.role).toBe('admin');
      const admin = await page.request.get('/api/admin/users');
      expect(admin.status()).toBe(200);
    });

    test(`FR-AUTH-043-AC-06 ${viewport.name}: 認証アプリ（TOTP）を持つ店長を店長がやり直すと、古い鍵・認めた行・要素が消え、2本の登録が通って役割が有効になる`, async ({ page, request }) => {
      test.setTimeout(180_000);
      const owner = await withLocalDb((db) => createAdminSessionActor(db, 'admin', 'aal2'));
      const target = await withLocalDb(async (db) => {
        const staff = await provisionStaff(db, { role: 'admin', approvedPasskeys: 2 });
        await seedVerifiedMfaFactor(db, staff.userId);
        return staff;
      });
      const count = (table: string) =>
        withLocalDb(async (db) => {
          const sql: Record<string, string> = {
            keys: 'select count(*)::int as n from auth.webauthn_credentials where user_id = $1::uuid',
            approved: 'select count(*)::int as n from private.approved_passkeys where user_id = $1::uuid',
            factors: 'select count(*)::int as n from auth.mfa_factors where user_id = $1::uuid',
            inactiveRoles: 'select count(*)::int as n from public.user_roles where user_id = $1::uuid and active = false',
          };
          return Number((await db.query(sql[table], [target.userId])).rows[0].n);
        });
      // 出発点: 有効な店長で、鍵2本・認めた行2本・認証アプリ1つ
      expect(await roleOf(target.userId)).toEqual(['admin']);
      expect(await count('keys')).toBe(2);
      expect(await count('approved')).toBe(2);
      expect(await count('factors')).toBe(1);

      const redo = await request.post(`/api/admin/staff/${target.userId}/redo`, {
        headers: { ...bearerHeaders(owner), origin: ORIGIN, 'x-real-ip': `198.19.${randomInt(0, 256)}.${randomInt(1, 255)}` },
        data: { confirm: 'やり直し', reason: '認証アプリの端末を失くしたため、やり直します' },
        failOnStatusCode: false,
      });
      expect(redo.status()).toBe(200);
      // 登録の直前: 古い鍵・認めた行・要素は無く、役割の行は残るが有効ではない
      expect(await count('keys')).toBe(0);
      expect(await count('approved')).toBe(0);
      expect(await count('factors')).toBe(0);
      expect(await roleOf(target.userId)).toEqual([]);
      expect(await count('inactiveRoles')).toBe(1);

      let token = '';
      await expect
        .poll(
          async () => {
            const bodies = await mailBodies(request, target.email, '店員のアカウントの登録のご案内');
            token = /\/staff\/invite#([A-Za-z0-9_-]{43})/.exec(bodies[0]?.Text ?? '')?.[1] ?? '';
            return token !== '';
          },
          { timeout: 15_000, message: 'やり直しのメールのリンクが届く' },
        )
        .toBe(true);

      authenticators.push(await registerTwoKeys(page, { userId: target.userId, email: target.email, token }));

      expect(await roleOf(target.userId)).toEqual(['admin']);
      expect(await count('keys')).toBe(2);
      const approved = await withLocalDb(async (db) =>
        (await db.query('select approved_via from private.approved_passkeys where user_id = $1::uuid', [target.userId])).rows.map(
          (row: { approved_via: string }) => row.approved_via,
        ),
      );
      expect(approved).toEqual(['window', 'window']);
      await withLocalDb((db) => skipPasskeyNotificationsOf(db, target.userId));
    });

    test(`FR-AUTH-043-AC-07 ${viewport.name}: 招待のセッションのトークンで /api/admin/* を叩くと 403`, async ({ page }) => {
      test.setTimeout(120_000);
      const invited = await issueInvite();
      await enterRegisterScreen(page, invited.token);

      const users = await page.request.get('/api/admin/users');
      expect(users.status()).toBe(403);
      const staff = await page.request.post('/api/admin/staff/invites', {
        headers: { origin: ORIGIN },
        data: { email: 'someone@example.com', role: 'supporter' },
        failOnStatusCode: false,
      });
      expect(staff.status()).toBe(403);
      expect(await roleOf(invited.userId)).toEqual([]);
    });

    test(`FR-AUTH-043-AC-08 ${viewport.name}: 招待の窓の中で足した鍵の知らせは subject_is_staff = true で積まれる`, async ({ page }) => {
      test.setTimeout(120_000);
      const invited = await issueInvite();
      const first = await addVirtualAuthenticator(page);
      authenticators.push(first);
      await enterRegisterScreen(page, invited.token);
      await registerFirstKey(page);

      const rows = await withLocalDb(async (db) =>
        (
          await db.query(
            'select kind, subject_is_staff from private.passkey_notification_outbox where user_id = $1::uuid order by seq',
            [invited.userId],
          )
        ).rows as Array<{ kind: string; subject_is_staff: boolean }>,
      );
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows.every((row) => row.kind === 'passkey_added' && row.subject_is_staff === true)).toBe(true);
      await withLocalDb((db) => skipPasskeyNotificationsOf(db, invited.userId));
    });

    test(`FR-AUTH-043-AC-02 ${viewport.name}: 窓が閉じたら /staff/register は /login へ送り、鍵は登録できず、完了も 403`, async ({ page }) => {
      test.setTimeout(120_000);
      const invited = await issueInvite();
      await enterRegisterScreen(page, invited.token);
      const csrf = (await page.context().cookies(ORIGIN)).find((cookie) => cookie.name === 'sb-csrf-token')?.value;
      expect(csrf).toBeTruthy();

      await withLocalDb((db) =>
        db.query(
          'select public.passkey_window_close(w.session_id) from private.passkey_registration_windows w where w.user_id = $1::uuid and w.closed_at is null',
          [invited.userId],
        ),
      );

      const start = await page.request.post('/api/auth/passkey/register/start', {
        headers: { origin: ORIGIN, 'x-csrf-token': csrf! },
        failOnStatusCode: false,
      });
      expect(start.status()).toBe(403);
      expect(await start.json()).toEqual({ error: 'registration_not_allowed', reason: 'window_closed' });
      const keys = await withLocalDb(async (db) =>
        Number((await db.query('select count(*)::int as n from auth.webauthn_credentials where user_id = $1::uuid', [invited.userId])).rows[0].n),
      );
      expect(keys).toBe(0);

      const complete = await page.request.post('/api/auth/staff/register/complete', {
        headers: { origin: ORIGIN, 'x-csrf-token': csrf! },
        failOnStatusCode: false,
      });
      expect(complete.status()).toBe(403);
      expect(await complete.json()).toEqual({ error: 'window_closed' });
      expect(await roleOf(invited.userId)).toEqual([]);

      await page.goto('/staff/register');
      await expect(page).toHaveURL(`${ORIGIN}/login`, NAVIGATION);
    });
  });
}
