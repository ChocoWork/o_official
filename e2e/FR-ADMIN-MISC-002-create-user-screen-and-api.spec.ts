/**
 * FR-ADMIN-MISC-002 ユーザー作成の画面と窓口（/admin/create-user・/api/admin/create-user）の守り
 * 対応: SEC-ADMIN-001-AC-04・SEC-ADMIN-008-AC-02・SEC-ADMIN-012-AC-01・SEC-ADMIN-013-AC-01・SEC-ADMIN-013-AC-02
 *
 * 画面（SEC-ADMIN-001-AC-04）は未ログインの本物の画面を3つの viewport で操作する。
 * 窓口の4件は画面を描かない HTTP の試験なので、viewport の繰り返しは無い（1本ずつ）。
 * 店長の aal2 の JWT は手元の Supabase で作り（e2e/admin-session-test-utils.ts）、Authorization ヘッダーに付けて
 * 本番ビルドの窓口へ直に送る（窓口の認可・MFA・Origin の照合は差し替えない。書き込みには許可の Origin を付ける）。
 * 作った利用者は消さない（db reset で消える）。他の試験の店長を巻き込まないため。
 */
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';
import { createAdminSessionActor, bearerHeaders, type AdminSessionActor } from './admin-session-test-utils';
import { withDummyCaptcha } from './captcha-test-utils';
import { withLocalDb } from './order-email-test-utils';

// JWT が Authorization ヘッダーに載るので、通信記録（trace）に残さない。
test.use({ trace: 'off' });

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
] as const;

const CREATE_USER_PATH = '/api/admin/create-user';
const REVOKE_PATH = '/api/admin/revoke-user-sessions';
const COLOR_PRESETS_PATH = '/api/admin/item-color-presets';
const SUCCESS_TEXT = 'ユーザ作成しました';

/**
 * 表示名の長さの上限（100字。SEC-ADMIN-013）。窓口の定数は export していないので、ここに同じ値を置く。
 * 013-AC-01 は「決めた上限より1字長い」表示名を送る。
 */
const DISPLAY_NAME_MAX = 100;

function uniqueEmail(label: string): string {
  return `e2e-misc002-${label}-${randomUUID().slice(0, 12)}@example.com`;
}

/** 16 文字以上の、漏れた一覧には無い使い捨てのパスワード */
function strongPassword(): string {
  return `E2e-Misc002-${randomUUID()}`;
}

function originOf(baseURL: string | undefined): string {
  expect(baseURL, 'baseURL').toBeTruthy();
  return new URL(baseURL as string).origin;
}

// ---- 手元の GoTrue（被害者・重複の材料を作るだけ。管理者の JWT は共有の道具で作る） ----

type LocalAuth = { url: string; anonKey: string; serviceKey: string };

function localAuth(): LocalAuth {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anonKey || !serviceKey) throw new Error('手元の Supabase の住所と鍵が環境に無い');
  if (!isLocalUrl(url)) throw new Error('手元の Supabase 以外には利用者を作らない');
  return { url, anonKey, serviceKey };
}

type GoTrueReply = { status: number; body: Record<string, unknown> };

async function goTrue(path: string, init: { method: string; key: string; json?: unknown }): Promise<GoTrueReply> {
  const { url } = localAuth();
  const response = await fetch(`${url}/auth/v1${path}`, {
    method: init.method,
    headers: { apikey: init.key, authorization: `Bearer ${init.key}`, 'content-type': 'application/json' },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try { body = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { body = { raw: text }; }
  return { status: response.status, body };
}

/** 利用者を GoTrue の管理の窓口で作る（メール確認済み）。番号を返す */
async function createAuthUser(email: string, password: string): Promise<string> {
  const { serviceKey } = localAuth();
  const reply = await goTrue('/admin/users', { method: 'POST', key: serviceKey, json: { email, password, email_confirm: true } });
  if (reply.status !== 200 || typeof reply.body.id !== 'string') {
    throw new Error(`前提: 手元の GoTrue で利用者を作れること（status ${reply.status}）`);
  }
  return reply.body.id;
}

async function passwordLogin(email: string, password: string): Promise<void> {
  const { anonKey } = localAuth();
  const reply = await goTrue('/token?grant_type=password', { method: 'POST', key: anonKey, json: withDummyCaptcha({ email, password }) });
  if (reply.status !== 200) throw new Error(`前提: パスワードでログインできること（status ${reply.status}）`);
}

// ---- 手元の DB の読み取り ----

async function authUserCount(email: string): Promise<number> {
  return withLocalDb(async (db) =>
    Number((await db.query('select count(*)::int as n from auth.users where lower(email) = lower($1)', [email])).rows[0].n),
  );
}

async function sessionCount(userId: string): Promise<number> {
  return withLocalDb(async (db) =>
    Number((await db.query('select count(*)::int as n from auth.sessions where user_id = $1::uuid', [userId])).rows[0].n),
  );
}

/** そのアクターの admin_create_user の最新の1行 */
async function latestCreateUserAudit(actorId: string): Promise<{ outcome: string; detail: string | null }> {
  return withLocalDb(async (db) => {
    const rows = (await db.query(
      `select outcome, detail from public.audit_logs
        where action = 'admin_create_user' and actor_id = $1::uuid
        order by created_at desc, id desc limit 1`,
      [actorId],
    )).rows;
    if (rows.length !== 1) throw new Error('前提: admin_create_user の監査の行があること');
    return { outcome: rows[0].outcome as string, detail: (rows[0].detail as string | null) ?? null };
  });
}

function adminHeaders(admin: AdminSessionActor, origin: string): Record<string, string> {
  return { ...bearerHeaders(admin), origin, 'content-type': 'application/json' };
}

// ---- 画面: 未ログインでは作れない ----

for (const viewport of VIEWPORTS) {
  test.describe(`FR-ADMIN-MISC-002 create-user screen (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`SEC-ADMIN-001-AC-04 ${viewport.name}: 未ログインで /admin/create-user から16文字以上のパスワードで送っても、成功の表示が出ず利用者が作られない`, async ({ page }) => {
      const email = uniqueEmail('screen');

      await page.goto('/admin/create-user');
      await page.getByLabel('EMAIL', { exact: true }).fill(email);
      await page.getByLabel('PASSWORD', { exact: true }).fill(strongPassword());

      const submitted = page.waitForResponse(
        (response) => new URL(response.url()).pathname === CREATE_USER_PATH && response.request().method() === 'POST',
      );
      await page.getByRole('button', { name: '作成' }).click();
      const response = await submitted;

      expect(response.status(), '未ログインの送信は作成に成功しない').not.toBe(201);
      await expect(page.getByText(SUCCESS_TEXT)).toHaveCount(0);
      await expect(page.getByText(/作成に失敗しました|Unauthorized|権限|ログイン/).first()).toBeVisible();
      expect(await authUserCount(email), '手元の Supabase にその利用者が作られない').toBe(0);
    });
  });
}

// ---- 窓口: 店長の aal2（画面を描かない HTTP の試験。viewport の繰り返しは無い） ----

test.describe('FR-ADMIN-MISC-002 create-user api', () => {
  let admin: AdminSessionActor;

  test.beforeAll(async () => {
    admin = await withLocalDb((db) => createAdminSessionActor(db, 'admin', 'aal2'));
  });

  test('SEC-ADMIN-008-AC-02 登録済みのメールで 409 が返った後、admin_create_user の行の detail が決まった短い文で Supabase の誤りの文を含まない', async ({ request, baseURL }) => {
    const origin = originOf(baseURL);
    const details: string[] = [];
    for (const label of ['dup-a', 'dup-b']) {
      const email = uniqueEmail(label);
      await createAuthUser(email, strongPassword());

      // Supabase が同じメールの作成に返す誤りの文を、管理の窓口へ直に送って手に入れる
      const supabaseReply = await goTrue('/admin/users', {
        method: 'POST',
        key: localAuth().serviceKey,
        json: { email, password: strongPassword(), email_confirm: true },
      });
      expect(supabaseReply.status, '前提: Supabase が重複を断ること').toBeGreaterThanOrEqual(400);
      const supabaseMessage = String(supabaseReply.body.msg ?? supabaseReply.body.message ?? '');
      expect(supabaseMessage, '前提: Supabase の誤りの文を取れること').not.toBe('');

      const response = await request.post(CREATE_USER_PATH, {
        headers: adminHeaders(admin, origin),
        data: { email, password: strongPassword() },
      });
      expect(response.status(), await response.text()).toBe(409);

      const audit = await latestCreateUserAudit(admin.userId);
      const detail = audit.detail;
      expect(detail, 'detail が決まった文で入っている').not.toBeNull();
      expect(detail!.trim()).not.toBe('');
      expect(detail!.toLowerCase(), 'Supabase の誤りの文を含まない').not.toContain(supabaseMessage.toLowerCase());
      expect(detail!.toLowerCase(), 'メールの住所を含まない').not.toContain(email.toLowerCase());
      details.push(detail!);
    }
    expect(details[1], '別のメールでも同じ決まった文').toBe(details[0]);
  });

  test('SEC-ADMIN-022-AC-03 ユーザーを作った後の監査の行（成功・形の誤り）に、行為者のメールと x-real-ip の値の IP とブラウザの名乗りが入り、偽の x-forwarded-for は入らない', async ({ request, baseURL }) => {
    const origin = originOf(baseURL);
    const email = uniqueEmail('audit-context');
    const userAgent = `e2e-sec-admin-022-${randomUUID()}`;
    // 試験ごとの送り元（手元の E2E の固定の環境の CLIENT_IP_HEADER=x-real-ip が x-real-ip を信頼する）。偽の x-forwarded-for は付けたままにする
    const bytes = randomUUID().replace(/-/g, '');
    const realIp = `198.18.${parseInt(bytes.slice(0, 2), 16)}.${(parseInt(bytes.slice(2, 4), 16) % 253) + 1}`;
    const spoofedIp = '203.0.113.88';
    const headers = { ...adminHeaders(admin, origin), 'x-real-ip': realIp, 'x-forwarded-for': spoofedIp, 'user-agent': userAgent };

    const invalid = await request.post(CREATE_USER_PATH, { headers, data: { email: 'not-an-email', password: strongPassword() } });
    expect(invalid.status(), await invalid.text()).toBe(400);
    const created = await request.post(CREATE_USER_PATH, { headers, data: { email, password: strongPassword() } });
    expect(created.status(), await created.text()).toBe(201);

    const rows = await withLocalDb(async (db) =>
      (await db.query(
        `select outcome, actor_email, ip, user_agent from public.audit_logs
          where action = 'admin_create_user' and actor_id = $1::uuid and user_agent = $2 order by created_at, id`,
        [admin.userId, userAgent],
      )).rows as Array<{ outcome: string; actor_email: string | null; ip: string | null; user_agent: string | null }>,
    );
    // 行が無ければ「欠けていない」が空振りになるので、2 行（形の誤り・成功）あることを先に確かめる
    expect(rows.map((row) => row.outcome)).toEqual(['failure', 'success']);
    for (const row of rows) {
      expect(row.actor_email, `${row.outcome} の actor_email`).toBe(admin.email);
      expect(row.ip, `${row.outcome} の ip が x-real-ip の値でない`).toBe(realIp);
      expect(row.ip).not.toContain(spoofedIp);
    }
  });

  test('SEC-ADMIN-012-AC-01 店長の aal2 で15文字のパスワードを送ると 400 が返り、その利用者が作られない', async ({ request, baseURL }) => {
    const email = uniqueEmail('short-password');
    const password = `a${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    expect(password).toHaveLength(15);

    const response = await request.post(CREATE_USER_PATH, { headers: adminHeaders(admin, originOf(baseURL)), data: { email, password } });

    expect(response.status(), await response.text()).toBe(400);
    expect(await authUserCount(email), '利用者が作られない').toBe(0);
  });

  test('SEC-ADMIN-013-AC-01 上限より1字長い表示名で送ると 400 が返り、利用者が作られない', async ({ request, baseURL }) => {
    const email = uniqueEmail('long-name');

    const response = await request.post(CREATE_USER_PATH, {
      headers: adminHeaders(admin, originOf(baseURL)),
      data: { email, password: strongPassword(), display_name: 'あ'.repeat(DISPLAY_NAME_MAX + 1) },
    });

    expect(response.status(), await response.text()).toBe(400);
    expect(await authUserCount(email), '利用者が作られない').toBe(0);
  });

  test('SEC-ADMIN-013-AC-02 壊れた JSON は create-user・revoke-user-sessions・item-color-presets の POST で 400', async ({ request, baseURL }) => {
    const headers = adminHeaders(admin, originOf(baseURL));
    const brokenJson = '{"email": "broken@example.com", ';
    for (const path of [CREATE_USER_PATH, REVOKE_PATH, COLOR_PRESETS_PATH]) {
      const response = await request.post(path, { headers, data: brokenJson });
      expect(response.status(), `${path} ${await response.text()}`).toBe(400);
    }
  });

  test('SEC-ADMIN-013-AC-02 UUID でない user_id の強制失効は 400 で session が変わらない', async ({ request, baseURL }) => {
    const headers = adminHeaders(admin, originOf(baseURL));

    const victimEmail = uniqueEmail('victim');
    const victimPassword = strongPassword();
    const victimId = await createAuthUser(victimEmail, victimPassword);
    await passwordLogin(victimEmail, victimPassword);
    const victimBefore = await sessionCount(victimId);
    const adminBefore = await sessionCount(admin.userId);
    expect(victimBefore, '前提: 対象の利用者に session があること').toBeGreaterThan(0);

    const response = await request.post(REVOKE_PATH, { headers, data: { user_id: 'not-a-uuid' } });

    expect(response.status(), await response.text()).toBe(400);
    expect(await sessionCount(victimId), '対象の session が変わらない').toBe(victimBefore);
    expect(await sessionCount(admin.userId), '実行者の session が変わらない').toBe(adminBefore);
  });
});
