/**
 * FR-PRIVACY-007 追跡の設定の関数と表は、PostgREST からも設定の窓口からも、権限の無い鍵では読めず・切り替えられない
 * 対応: SEC-PRIVACY-001-AC-01 / SEC-PRIVACY-001-AC-02 / SEC-PRIVACY-010-AC-01 / SEC-PRIVACY-010-AC-02
 *
 * 手元の Supabase に、アプリを通さず anon の鍵・一般会員の JWT・aal1 の管理者（admin.settings.manage を持つがパスワードだけの session）の
 * JWT で直接 PostgREST を叩き、設定の保存の窓口（PUT /api/admin/settings/shop）も叩く。
 * 切り替えの試験は withDeliveryScenario（DB の pg_advisory_lock(940488)）で他の追跡の試験と直列にし、追跡の印をオフの基準にして、
 * 叩いた後に DB の印と /privacy の「5. 個人情報の取扱いの委託」の一覧が変わっていないことを確かめる。
 * JWT が通信記録に残らないよう trace は切る。
 */
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { bindAppSession } from './admin-session-test-utils';
import { deliveryViewports, setTrackingFlagDirect, withDeliveryScenario } from './delivery-tracking-test-utils';

test.use({ trace: 'off' });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const SETTINGS_ROUTE = '/api/admin/settings/shop';
const TRACKING_OUTSOURCING_ITEM = '17TRACK';
// 追跡がオフの間の /privacy の委託の一覧（src/app/privacy/page.tsx）
const OUTSOURCING_WHEN_OFF = [
  '商品の配送業務（配送事業者）',
  '決済処理業務（Stripe, Inc.）',
  'サーバー及びシステムの運用・保守業務',
];

type Credential = { name: string; headers: Record<string, string>; bearer: string | null; userId: string | null };

function requireLocalEnv(): void {
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY || !isLocalUrl(SUPABASE_URL)) {
    throw new Error('手元の Supabase の公開値と service role の鍵が env に無い（この試験は手元の Supabase だけで流す）');
  }
}

function postgrestHeaders(bearer: string | null): Record<string, string> {
  return { apikey: ANON_KEY, Authorization: `Bearer ${bearer ?? ANON_KEY}`, 'Content-Type': 'application/json' };
}

const createdUserIds: string[] = [];

async function signedInUser(kind: 'member' | 'admin'): Promise<{ userId: string; accessToken: string; refreshToken: string }> {
  requireLocalEnv();
  const email = `e2e-privacy007-${kind}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}@example.com`;
  const password = `E2e-${randomBytes(12).toString('hex')}!`;
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, options);
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    ...(kind === 'admin' ? { app_metadata: { role: 'admin' } } : {}),
  });
  if (created.error || !created.data.user) {
    throw new Error(`手元の利用者を作れない（status: ${created.error?.status ?? '不明'}）`);
  }
  // パスワードだけのログイン。JWT の aal は aal1 になる（2段階認証は済ませない）
  const signedIn = await createClient(SUPABASE_URL, ANON_KEY, options).auth.signInWithPassword({ email, password });
  if (signedIn.error || !signedIn.data.session) {
    throw new Error(`手元の利用者でログインできない（status: ${signedIn.error?.status ?? '不明'}）`);
  }
  createdUserIds.push(created.data.user.id);
  return { userId: created.data.user.id, accessToken: signedIn.data.session.access_token, refreshToken: signedIn.data.session.refresh_token };
}

// 利用者は worker ごとに1回だけ作る（ログインの回数の制限を使い切らない）
let memberPromise: ReturnType<typeof signedInUser> | null = null;
let adminPromise: Promise<{ userId: string; accessToken: string; refreshToken: string }> | null = null;

function memberCredential(): Promise<Credential> {
  memberPromise ??= signedInUser('member');
  return memberPromise.then((user) => ({
    name: '一般会員の JWT',
    headers: postgrestHeaders(user.accessToken),
    bearer: user.accessToken,
    userId: user.userId,
  }));
}

const anonCredential = (): Credential => ({ name: 'anon の鍵', headers: postgrestHeaders(null), bearer: null, userId: null });

/**
 * admin.settings.manage を持つ役割（admin）を有効に割り当てた、aal1 の管理者。割り当てと結び付けは場面の DB 接続で行う。
 * アプリの sessions に結び付ける（wave 5: 結び付かない通行証は窓口が 401 で断る）ので、窓口の 403 が「aal1 だから断る」ことを示す。
 */
async function aal1AdminCredential(db: PgClient): Promise<Credential> {
  adminPromise ??= (async () => {
    const user = await signedInUser('admin');
    const assigned = await db.query(
      `insert into public.user_roles (user_id, role_id, active, expires_at)
       select $1::uuid, r.id, true, null from public.roles as r where r.code = 'admin'`,
      [user.userId],
    );
    if (assigned.rowCount !== 1) throw new Error('役割 admin の行が手元の DB に無い');
    await bindAppSession(db, user);
    return user;
  })();
  const user = await adminPromise;
  return { name: 'aal1 の管理者の JWT', headers: postgrestHeaders(user.accessToken), bearer: user.accessToken, userId: user.userId };
}

// この worker が作った利用者を片付ける。有効な admin の役割が手元の DB に溜まらないよう、役割を外してから利用者を消す
// afterAll は組の終わりごとに走る。消した利用者の JWT を同じ worker の次の組で使い回さないよう、作り置きも捨てる
test.afterAll(async () => {
  memberPromise = null;
  adminPromise = null;
  if (createdUserIds.length === 0) return;
  const userIds = createdUserIds.splice(0);
  await withDeliveryScenario(async ({ client }) => {
    await client.query('update public.user_roles set active = false where user_id = any($1::uuid[])', [userIds]);
  });
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  for (const userId of userIds) await admin.auth.admin.deleteUser(userId);
});

async function readOutsourcingList(page: Page): Promise<string[]> {
  await page.goto('/privacy');
  const section = page.locator('section').filter({ has: page.getByRole('heading', { name: '5. 個人情報の取扱いの委託' }) });
  await expect(section.getByRole('listitem').first()).toBeVisible();
  return (await section.getByRole('listitem').allTextContents()).map((text) => text.trim());
}

/** 権限の無い呼び出しの断り。PostgREST は実行できない関数を 401/403 で断るほか、見えない関数として 404（PGRST202）や 42501 で返すことがある */
async function expectRpcRefused(response: { status(): number; text(): Promise<string> }, label: string): Promise<void> {
  const text = await response.text();
  const code = (() => {
    try {
      return (JSON.parse(text) as { code?: string }).code ?? '';
    } catch {
      return '';
    }
  })();
  expect([401, 403, 404].includes(response.status()) || ['42501', 'PGRST202'].includes(code), `${label} (status ${response.status()}, ${text})`).toBe(true);
}

/** 三つの道（切り替えの関数・表の更新・設定の保存の窓口）を叩き、どれも断られることを確かめる */
async function expectAllTogglePathsRefused(request: APIRequestContext, credential: Credential, origin: string): Promise<void> {
  const rpc = await request.post(`${SUPABASE_URL}/rest/v1/rpc/admin_set_delivery_tracking`, {
    headers: credential.headers,
    data: { _enabled: true, _actor_id: credential.userId ?? '00000000-0000-0000-0000-000000000000' },
    failOnStatusCode: false,
  });
  await expectRpcRefused(rpc, `${credential.name}: rpc/admin_set_delivery_tracking`);

  const patch = await request.patch(`${SUPABASE_URL}/rest/v1/shop_settings?id=eq.1`, {
    headers: { ...credential.headers, Prefer: 'return=representation' },
    data: { delivery_tracking_enabled: true },
    failOnStatusCode: false,
  });
  expect([401, 403], `${credential.name}: PATCH shop_settings (${await patch.text()})`).toContain(patch.status());

  const route = await request.put(SETTINGS_ROUTE, {
    // Origin が無い状態変更は src/proxy.ts が 'Forbidden origin' で先に断る。権限の断りを確かめるため、アプリ自身の Origin を付ける
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      ...(credential.bearer ? { Authorization: `Bearer ${credential.bearer}` } : {}),
    },
    data: { autoRefundCancelledOrderPayment: false, autoCancelAmountMismatch: false, deliveryTracking: { enabled: true } },
    failOnStatusCode: false,
  });
  expect([401, 403], `${credential.name}: PUT ${SETTINGS_ROUTE}`).toContain(route.status());
}

for (const viewport of deliveryViewports) {
  test.describe(`FR-PRIVACY-007 settings access over PostgREST (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test(`SEC-PRIVACY-001-AC-01 anon の鍵と一般会員の JWT で設定の関数を呼べず、updated_by_email が表示されない (${viewport.name})`, async ({ page }) => {
      const request = page.request;
      // 関数は service role では担当者のメールの欄を返す。欄の無さが「関数が空だから」でないことの確かめ
      const service = await request.post(`${SUPABASE_URL}/rest/v1/rpc/get_delivery_tracking_settings`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        data: {},
        failOnStatusCode: false,
      });
      expect(service.status()).toBe(200);
      expect(await service.text()).toContain('updated_by_email');

      for (const credential of [anonCredential(), await memberCredential()]) {
        const response = await request.post(`${SUPABASE_URL}/rest/v1/rpc/get_delivery_tracking_settings`, {
          headers: credential.headers,
          data: {},
          failOnStatusCode: false,
        });
        const text = await response.text();
        await expectRpcRefused(response, `${credential.name} で呼んだ応答`);
        expect(text, `${credential.name} の応答に担当者のメールの欄が出ない`).not.toContain('updated_by_email');
        expect(text).not.toContain('@example.com');
      }
    });

    test(`SEC-PRIVACY-001-AC-02 anon の鍵と一般会員の JWT の shop_settings の select が断られるか、0件で返る (${viewport.name})`, async ({ page }) => {
      const request = page.request;
      for (const credential of [anonCredential(), await memberCredential()]) {
        const response = await request.get(`${SUPABASE_URL}/rest/v1/shop_settings?select=*`, {
          headers: credential.headers,
          failOnStatusCode: false,
        });
        const text = await response.text();
        const denied = [401, 403].includes(response.status());
        const emptyRows = response.status() === 200 && JSON.stringify(JSON.parse(text)) === '[]';
        expect(denied || emptyRows, `${credential.name} の select は断られるか0件 (status ${response.status()})`).toBe(true);
        expect(text, `${credential.name} の応答に配送の追跡の設定の列が出ない`).not.toContain('delivery_tracking');
      }
    });

    test(`SEC-PRIVACY-010-AC-01 aal1 の管理者は関数・表の update・設定の窓口のどれからも切り替えられず、/privacy の委託の一覧が変わらない (${viewport.name})`, async ({ page, baseURL }) => {
      if (!baseURL) throw new Error('baseURL が無い（playwright.config.ts）');
      const origin = new URL(baseURL).origin;
      test.setTimeout(420_000);
      await withDeliveryScenario(async ({ client }) => {
        await setTrackingFlagDirect(client, false);
        const settingsBefore = (
          await client.query(
            'select delivery_tracking_enabled, delivery_tracking_updated_at, delivery_tracking_updated_by from public.shop_settings where id = 1',
          )
        ).rows[0];
        expect(settingsBefore.delivery_tracking_enabled).toBe(false);
        const listBefore = await readOutsourcingList(page);
        expect(listBefore).toEqual(OUTSOURCING_WHEN_OFF);

        const admin = await aal1AdminCredential(client);
        await expectAllTogglePathsRefused(page.request, admin, origin);
        // 窓口は権限を持つ管理者にも、パスワードだけの session では MFA を求めて断る
        const route = await page.request.put(SETTINGS_ROUTE, {
          headers: { 'Content-Type': 'application/json', Origin: origin, Authorization: `Bearer ${admin.bearer}` },
          data: { autoRefundCancelledOrderPayment: false, autoCancelAmountMismatch: false, deliveryTracking: { enabled: true } },
          failOnStatusCode: false,
        });
        expect(route.status()).toBe(403);
        expect(await route.json()).toMatchObject({ reason: 'MFA required', permission: 'admin.settings.manage' });

        const settingsAfter = (
          await client.query(
            'select delivery_tracking_enabled, delivery_tracking_updated_at, delivery_tracking_updated_by from public.shop_settings where id = 1',
          )
        ).rows[0];
        expect(settingsAfter).toEqual(settingsBefore);
        const listAfter = await readOutsourcingList(page);
        expect(listAfter).toEqual(listBefore);
        expect(listAfter.some((item) => item.includes(TRACKING_OUTSOURCING_ITEM))).toBe(false);
      });
    });

    test(`SEC-PRIVACY-010-AC-02 anon の鍵と一般会員の JWT は同じ3つの道のどれからも切り替えられず、/privacy の委託の一覧が変わらない (${viewport.name})`, async ({ page, baseURL }) => {
      if (!baseURL) throw new Error('baseURL が無い（playwright.config.ts）');
      const origin = new URL(baseURL).origin;
      test.setTimeout(420_000);
      await withDeliveryScenario(async ({ client }) => {
        await setTrackingFlagDirect(client, false);
        const settingsBefore = (
          await client.query(
            'select delivery_tracking_enabled, delivery_tracking_updated_at, delivery_tracking_updated_by from public.shop_settings where id = 1',
          )
        ).rows[0];
        expect(settingsBefore.delivery_tracking_enabled).toBe(false);
        const listBefore = await readOutsourcingList(page);
        expect(listBefore).toEqual(OUTSOURCING_WHEN_OFF);

        for (const credential of [anonCredential(), await memberCredential()]) {
          await expectAllTogglePathsRefused(page.request, credential, origin);
        }

        const settingsAfter = (
          await client.query(
            'select delivery_tracking_enabled, delivery_tracking_updated_at, delivery_tracking_updated_by from public.shop_settings where id = 1',
          )
        ).rows[0];
        expect(settingsAfter).toEqual(settingsBefore);
        const listAfter = await readOutsourcingList(page);
        expect(listAfter).toEqual(listBefore);
        expect(listAfter.some((item) => item.includes(TRACKING_OUTSOURCING_ITEM))).toBe(false);
      });
    });
  });
}
