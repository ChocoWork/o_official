/**
 * FR-LOGIN-031 Supabase Auth・PostgREST を直接呼ぶ道（アプリの窓口を通らない道）でも、2段階のログイン・DB の権限・登録の決まりが飛ばせない
 * 対応: SEC-AUTH-005-AC-01 / SEC-AUTH-005-AC-02 / SEC-AUTH-010-AC-01 / SEC-AUTH-011-AC-01 / SEC-AUTH-012-AC-01
 *       SEC-AUTH-015-AC-01 / SEC-AUTH-015-AC-02 / SEC-AUTH-028-AC-02
 *
 * 手元の Supabase（GoTrue の /auth/v1、PostgREST の /rest/v1）を anon の鍵と、パスワードだけで得た JWT で直接叩く。
 * アプリの窓口（/api/auth/me・/api/profile・/api/orders・/api/admin/users）は Bearer で叩く。画面は開かない。
 * HTTP の試験なので結果は画面の幅で変わらない。1つの幅（desktop）だけ流す（DB の書き込みと回数の制限の枠を3倍にしない）。
 *
 * 既知の赤: SEC-AUTH-005・010-AC-01・011・012・015 は、2026-10-24 時点で文書に載せた「今のコードは満たさない」点
 * （docs/02_Requirements/areas/auth.md）。SEC-AUTH-028-AC-02 は満たす。AC ごとに describe を分け、赤を互いに混ぜない。
 * （012 は G-2 の移行 20261024153505 が anon・authenticated の EXECUTE を外すので、その移行を当てた DB では緑になる）
 *
 * 前提: 手元の Supabase（npm run db:start）と手元の E2E アプリ。会員・管理者は auth.admin.createUser で既知のパスワードつきで作る。
 * GoTrue のログイン・登録の枠（5 分で 30 回、全部の E2E で共有）を節約するため、読むだけの試験で使う会員・管理者は worker ごとに1回だけ
 * ログインして使い回す。書き換える試験（015-AC-02・028-AC-02）は試験ごとに会員を作る（028-AC-02 はアプリの窓口を通して JWT を得る）。
 * 後始末: 足した注文は消す。利用者は残る（db reset で消える）。役割 admin を付けた利用者は user_roles を無効にする。
 * JWT・パスワードが通信記録に残らないよう trace は切る。失敗の文面にも出さない。
 */
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { Client } from 'pg';
import { expect, test, type APIResponse } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';
import { createTestMember, loginAsMember } from './member-session-helpers';

test.use({ trace: 'off' });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const LOCAL_DB_URL = process.env.E2E_LOCAL_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

// 窓口を HTTP で叩く試験で、画面の幅で結果が変わらない。幅ごとに流すと DB の書き込みと回数の制限の枠が3倍になるので、1つの幅（desktop）だけ流す。
const viewports = [{ name: 'desktop', width: 1280, height: 800 }] as const;

// ---- 手元の環境と DB ----

function requireLocalEnv(): void {
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY || !isLocalUrl(SUPABASE_URL) || !isLocalUrl(LOCAL_DB_URL)) {
    throw new Error('手元の Supabase の公開値と service role の鍵が env に無い（この試験は手元の Supabase だけで流す）');
  }
}

function requireLocalApp(baseURL: string | undefined): void {
  if (!baseURL || !isLocalUrl(baseURL)) {
    throw new Error('手元のアプリの baseURL が無い（この試験は手元のアプリだけを叩く）');
  }
}

async function withDb<T>(run: (db: Client) => Promise<T>, options: { replica?: boolean } = {}): Promise<T> {
  requireLocalEnv();
  const db = new Client({ connectionString: LOCAL_DB_URL });
  try {
    await db.connect();
  } catch {
    await db.end().catch(() => undefined);
    throw new Error('手元の DB へ接続できない');
  }
  try {
    // 注文を足すとき、入金や在庫の触発を通さず行だけを入れる（FR-SEARCH-021 と同じ）
    if (options.replica) await db.query('set session_replication_role = replica');
    return await run(db);
  } finally {
    await db.end().catch(() => undefined);
  }
}

// ---- 利用者と JWT ----

type Actor = {
  userId: string;
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
};

type JwtClaims = {
  sub?: string;
  aal?: string;
  session_id?: string;
  app_metadata?: { role?: string };
  user_metadata?: { role?: string };
};

function claimsOf(accessToken: string): JwtClaims {
  const payload = accessToken.split('.')[1];
  if (!payload) throw new Error('JWT の形が正しくない');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as JwtClaims;
}

const newPassword = (): string => `E2e-${randomBytes(12).toString('hex')}!`;
const newEmail = (label: string): string =>
  `e2e-auth031-${label}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}@example.com`;

/** 役割 admin を付けた利用者。afterAll で user_roles を無効にする */
const adminUserIds: string[] = [];
/** 試験が足した注文。afterAll で消す */
const orderIds: string[] = [];

type TokenReply = { access_token?: string; refresh_token?: string };

/** 手元の GoTrue のトークンの要求（Node から。JWT を通信記録に載せない） */
async function requestToken(grantType: 'password' | 'refresh_token', body: Record<string, string>): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=${grantType}`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {
    throw new Error(`手元の Auth の ${grantType} の要求に失敗した`);
  });
  if (!res.ok) throw new Error(`手元の Auth の ${grantType} が通らない: ${res.status}`);
  const reply = (await res.json().catch(() => ({}))) as TokenReply;
  if (!reply.access_token || !reply.refresh_token) throw new Error(`手元の Auth の ${grantType} の応答に token が無い`);
  return { accessToken: reply.access_token, refreshToken: reply.refresh_token };
}

/** 既知のパスワードで作った利用者が、パスワードだけで（OTP を通らずに）得た JWT を持つ */
async function createSignedInActor(label: string, options: { admin?: boolean } = {}): Promise<Actor> {
  requireLocalEnv();
  const email = newEmail(label);
  const password = newPassword();
  const created = await createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
    .auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      ...(options.admin ? { app_metadata: { role: 'admin' } } : {}),
    })
    .catch(() => {
      throw new Error('手元の利用者を作る要求に失敗した');
    });
  if (created.error || !created.data.user) {
    throw new Error(`手元の利用者を作れない（status: ${created.error?.status ?? '不明'}, code: ${created.error?.code ?? '不明'}）`);
  }
  const userId = created.data.user.id;
  if (options.admin) {
    await withDb(async (db) => {
      const assigned = await db.query(
        `insert into public.user_roles (user_id, role_id, active, expires_at)
         select $1::uuid, r.id, true, null from public.roles r where r.code = 'admin'`,
        [userId],
      );
      if (assigned.rowCount !== 1) throw new Error('役割 admin の行が手元の DB に無い');
    });
    adminUserIds.push(userId);
  }
  const tokens = await requestToken('password', { email, password });
  return { userId, email, password, ...tokens };
}

/** 読むだけの試験で使い回す。ログインの枠を使い切らないよう worker ごとに1回だけ作る */
let sharedMemberPromise: Promise<Actor> | null = null;
let sharedAdminPromise: Promise<Actor> | null = null;
const sharedMember = (): Promise<Actor> => (sharedMemberPromise ??= createSignedInActor('member'));
const sharedAdmin = (): Promise<Actor> => (sharedAdminPromise ??= createSignedInActor('admin', { admin: true }));

/** 会員本人の profiles と注文が実在することを保つ（無いと「読めない」が空の表のせいで成り立つ） */
const ownedRowsByUser = new Map<string, Promise<string>>();
function ensureOwnedRows(member: Actor): Promise<string> {
  const existing = ownedRowsByUser.get(member.userId);
  if (existing) return existing;
  const seeded = withDb(
    async (db) => {
      await db.query(
        `insert into public.profiles (user_id, display_name) values ($1::uuid, 'e2e auth031')
         on conflict (user_id) do nothing`,
        [member.userId],
      );
      const suffix = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
      const order = await db.query(
        `insert into public.orders
           (session_id, payment_intent_id, status, subtotal_amount, shipping_amount, total_amount, paid_amount, currency, user_id)
         values ($1, $2, 'paid'::public.order_status, 1000, 0, 1000, 1000, 'jpy', $3::uuid) returning id`,
        [`e2e-auth031-${suffix}`, `pi_e2e_auth031_${suffix}`, member.userId],
      );
      const orderId = order.rows[0].id as string;
      orderIds.push(orderId);
      const counts = await db.query(
        `select (select count(*)::int from public.profiles where user_id = $1::uuid) as profiles,
                (select count(*)::int from public.orders where user_id = $1::uuid) as orders`,
        [member.userId],
      );
      expect(counts.rows[0].profiles, '会員本人の profiles の行（準備）').toBe(1);
      expect(counts.rows[0].orders, '会員本人の注文の行（準備）').toBe(1);
      return orderId;
    },
    { replica: true },
  );
  ownedRowsByUser.set(member.userId, seeded);
  return seeded;
}

test.afterAll(async () => {
  if (orderIds.length === 0 && adminUserIds.length === 0) return;
  await withDb(async (db) => {
    if (orderIds.length > 0) await db.query('delete from public.orders where id = any($1::uuid[])', [orderIds]);
    if (adminUserIds.length > 0) await db.query('update public.user_roles set active = false where user_id = any($1::uuid[])', [adminUserIds]);
  });
});

// ---- HTTP ----

const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

function postgrestHeaders(token: string): Record<string, string> {
  return { apikey: ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function jsonOf(response: APIResponse): Promise<unknown> {
  const text = await response.text();
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** select で返った行（権限の断り 401・403 は行なし）。それ以外の status は一覧でなければ試験を落とす */
async function selectedRows(response: APIResponse, label: string): Promise<Array<Record<string, unknown>>> {
  if ([401, 403].includes(response.status())) return [];
  expect(response.status(), `${label}: select の status`).toBe(200);
  const body = await jsonOf(response);
  if (!Array.isArray(body)) throw new Error(`${label}: 行の一覧ではない応答`);
  return body as Array<Record<string, unknown>>;
}

// ---- SEC-AUTH-005 ----

for (const viewport of viewports) {
  test.describe(`SEC-AUTH-005-AC-01 password grant の JWT ではアプリの会員の窓口が通らない (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`SEC-AUTH-005-AC-01 直接の password grant で得た JWT を Bearer で送ると、/api/auth/me が authenticated: false を返し、会員の窓口が 401 を返す (${viewport.name})`, async ({ request, baseURL }) => {
      test.fail(true, 'SEC-AUTH-005 今のコードは満たさない（docs/02_Requirements/areas/auth.md）');
      requireLocalApp(baseURL);
      const member = await sharedMember();

      // 準備: この JWT は Auth 自身には本物として通る（アプリが断る理由が「壊れた JWT」ではないことの確かめ）
      const direct = await request.get(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON_KEY, ...bearer(member.accessToken) } });
      expect(direct.status(), 'Auth 自身の /auth/v1/user（準備）').toBe(200);

      const me = await request.get('/api/auth/me', { headers: bearer(member.accessToken) });
      expect(await jsonOf(me), '/api/auth/me の応答').toMatchObject({ authenticated: false });

      const profile = await request.get('/api/profile', { headers: bearer(member.accessToken) });
      expect(profile.status(), '会員の窓口 /api/profile の status').toBe(401);
      const orders = await request.get('/api/orders', { headers: bearer(member.accessToken) });
      expect(orders.status(), '会員の窓口 /api/orders の status').toBe(401);
    });
  });
}

for (const viewport of viewports) {
  test.describe(`SEC-AUTH-005-AC-02 password grant の JWT では PostgREST から profiles と注文が読めない (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`SEC-AUTH-005-AC-02 同じ JWT で PostgREST の profiles・orders を select した結果に、本人の profiles と注文の行が含まれない (${viewport.name})`, async ({ request }) => {
      test.fail(true, 'SEC-AUTH-005 今のコードは満たさない（docs/02_Requirements/areas/auth.md）');
      const member = await sharedMember();
      await ensureOwnedRows(member);

      const profiles = await request.get(`${SUPABASE_URL}/rest/v1/profiles?select=user_id&user_id=eq.${member.userId}`, {
        headers: postgrestHeaders(member.accessToken),
      });
      expect(await selectedRows(profiles, 'profiles'), '本人の profiles の行').toEqual([]);

      const orders = await request.get(`${SUPABASE_URL}/rest/v1/orders?select=id,user_id&user_id=eq.${member.userId}`, {
        headers: postgrestHeaders(member.accessToken),
      });
      expect(await selectedRows(orders, 'orders'), '本人の注文の行').toEqual([]);
    });
  });
}

// ---- SEC-AUTH-010 ----

for (const viewport of viewports) {
  test.describe(`SEC-AUTH-010-AC-01 aal1 の管理者の JWT で他人の注文が読めない (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`SEC-AUTH-010-AC-01 admin の役割の利用者の aal1 の JWT で PostgREST の orders を select した結果に、その管理者以外の注文の行が含まれない (${viewport.name})`, async ({ request }) => {
      test.fail(true, 'SEC-AUTH-010 今のコードは満たさない（docs/02_Requirements/areas/auth.md）');
      const admin = await sharedAdmin();
      const member = await sharedMember();
      const foreignOrderId = await ensureOwnedRows(member);

      // 準備: aal1 の JWT であり、この管理者は注文を読む権限を DB の ACL で持つ（権限が無くて読めないのでは試験にならない）
      expect(claimsOf(admin.accessToken).aal, '管理者の JWT の aal').toBe('aal1');
      await withDb(async (db) => {
        const held = await db.query(
          `select count(*)::int as n
             from public.user_roles ur
             join public.role_permissions rp on rp.role_id = ur.role_id
             join public.permissions p on p.id = rp.permission_id
            where ur.user_id = $1::uuid and ur.active = true and (ur.expires_at is null or ur.expires_at > now())
              and p.code = 'admin.orders.read'`,
          [admin.userId],
        );
        expect(held.rows[0].n, '管理者が持つ admin.orders.read（準備）').toBeGreaterThan(0);
      });

      const specific = await request.get(`${SUPABASE_URL}/rest/v1/orders?select=id,user_id&id=eq.${foreignOrderId}`, {
        headers: postgrestHeaders(admin.accessToken),
      });
      expect(await selectedRows(specific, '他人の注文'), 'aal1 の管理者に見えた他人の注文の行').toEqual([]);

      const others = await request.get(
        `${SUPABASE_URL}/rest/v1/orders?select=id,user_id&or=(user_id.is.null,user_id.neq.${admin.userId})&limit=5`,
        { headers: postgrestHeaders(admin.accessToken) },
      );
      expect(await selectedRows(others, '管理者以外の注文'), 'aal1 の管理者に見えた管理者以外の注文の行').toEqual([]);
    });
  });
}

// ---- SEC-AUTH-011 ----

const AUTH_TABLES = ['sessions', 'password_reset_tokens', 'rate_limit_counters', 'audit_logs'] as const;

for (const viewport of viewports) {
  test.describe(`SEC-AUTH-011-AC-01 anon・会員の JWT で認証の表を読むと権限の誤りになる (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`SEC-AUTH-011-AC-01 anon の鍵と会員の JWT で sessions・password_reset_tokens・rate_limit_counters・audit_logs を select すると、0件ではなく権限の誤り（401 か 403）になる (${viewport.name})`, async ({ request }) => {
      test.fail(true, 'SEC-AUTH-011 今のコードは満たさない（docs/02_Requirements/areas/auth.md）');
      const member = await sharedMember();
      const credentials = [
        { name: 'anon の鍵', token: ANON_KEY },
        { name: '会員の JWT', token: member.accessToken },
      ];
      const statuses: Record<string, number> = {};
      for (const credential of credentials) {
        for (const table of AUTH_TABLES) {
          const response = await request.get(`${SUPABASE_URL}/rest/v1/${table}?select=*&limit=1`, {
            headers: postgrestHeaders(credential.token),
          });
          statuses[`${credential.name} ${table}`] = response.status();
        }
      }
      const notRefused = Object.entries(statuses).filter(([, status]) => ![401, 403].includes(status));
      expect(notRefused, '権限の誤り（401 か 403）にならなかった select（名前と status）').toEqual([]);
    });
  });
}

// ---- SEC-AUTH-012 ----

const AUTH_RPCS: ReadonlyArray<{ name: string; args: Record<string, unknown> }> = [
  { name: 'find_auth_user_id_by_email', args: { p_email: 'e2e-auth031-nobody@example.com' } },
  { name: 'revoke_auth_session', args: { p_session_id: '00000000-0000-4000-8000-000000000031' } },
  { name: 'revoke_auth_sessions_for_user', args: { p_user_id: '00000000-0000-4000-8000-000000000031' } },
  { name: 'is_auth_session_active', args: { p_session_id: '00000000-0000-4000-8000-000000000031' } },
  // 2つの形（3引数・4引数）とも呼ぶ。通ってしまっても数を1動かすだけの、使われない送り元と窓口
  { name: 'increment_rate_limit_counter', args: { _ip: '203.0.113.31', _endpoint: 'e2e-auth031-rpc', _bucket: '2026-01-01T00:00:00Z' } },
  { name: 'increment_rate_limit_counter', args: { _ip: '203.0.113.31', _endpoint: 'e2e-auth031-rpc', _bucket: '2026-01-01T00:00:00Z', _increment: 1 } },
  // 通ってしまっても、100 年より古い再設定の印しか消さない
  { name: 'cleanup_password_reset_tokens', args: { p_retain_days: 36500 } },
];

for (const viewport of viewports) {
  test.describe(`SEC-AUTH-012-AC-01 anon・会員の JWT で認証の関数を呼ぶと権限の誤りになる (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`SEC-AUTH-012-AC-01 anon の鍵と会員の JWT で認証の6つの関数を rpc で呼ぶと、どれも権限の誤り（401 か 403）になる (${viewport.name})`, async ({ request }) => {
      const member = await sharedMember();
      const credentials = [
        { name: 'anon の鍵', token: ANON_KEY },
        { name: '会員の JWT', token: member.accessToken },
      ];
      const statuses: Record<string, number> = {};
      for (const credential of credentials) {
        for (const rpc of AUTH_RPCS) {
          const response = await request.post(`${SUPABASE_URL}/rest/v1/rpc/${rpc.name}`, {
            headers: postgrestHeaders(credential.token),
            data: rpc.args,
          });
          statuses[`${credential.name} ${rpc.name}(${Object.keys(rpc.args).join(',')})`] = response.status();
        }
      }
      const notRefused = Object.entries(statuses).filter(([, status]) => ![401, 403].includes(status));
      expect(notRefused, '権限の誤り（401 か 403）にならなかった呼び出し（名前と status）').toEqual([]);
    });
  });
}

// ---- SEC-AUTH-015 ----

for (const viewport of viewports) {
  test.describe(`SEC-AUTH-015-AC-01 直接の /auth/v1/signup で 15 文字のパスワードの登録ができない (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`SEC-AUTH-015-AC-01 anon の鍵で /auth/v1/signup を直接呼び 15 文字のパスワードで登録すると、誤りになり、利用者ができない (${viewport.name})`, async ({ request }) => {
      test.fail(true, 'ENV minimum_password_length=6 と captcha 無効（15 文字でも直接の登録が通る） — 手元の supabase/config.toml が本番と違う');
      requireLocalEnv();
      const email = newEmail('signup15');
      const password = 'Abcdefgh1234!xy';
      expect(password, '送るパスワードの長さ（準備）').toHaveLength(15);

      const response = await request.post(`${SUPABASE_URL}/auth/v1/signup`, {
        headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
        data: { email, password },
      });
      // 429（枠切れ）は決まりで断られたのではない
      expect(response.status(), '直接の登録の status').toBeGreaterThanOrEqual(400);
      expect(response.status(), '直接の登録の status').toBeLessThan(500);
      expect(response.status(), '直接の登録が枠切れ（429）で断られていない').not.toBe(429);
      const body = (await jsonOf(response)) as Record<string, unknown> | null;
      expect(body?.access_token, '登録の応答の access_token').toBeUndefined();
      expect(body?.id, '登録の応答の利用者').toBeUndefined();

      await withDb(async (db) => {
        const found = await db.query('select count(*)::int as n from auth.users where email = $1', [email]);
        expect(found.rows[0].n, '登録した宛先の利用者の行').toBe(0);
      });
    });
  });
}

for (const viewport of viewports) {
  test.describe(`SEC-AUTH-015-AC-02 直接の /auth/v1/user で再認証なしにパスワードを変えられない (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`SEC-AUTH-015-AC-02 会員の access token だけで /auth/v1/user にパスワードの変更を送ると、再認証を求める誤りになり、パスワードが変わらない (${viewport.name})`, async ({ request }) => {
      test.fail(true, 'ENV secure_password_change=false（再認証なしでパスワードを変えられる） — 手元の supabase/config.toml が本番と違う');
      // パスワードを書き換える試験なので、試験ごとに会員を作る
      const member = await createSignedInActor('pwchange');
      const readHash = (): Promise<string> =>
        withDb(async (db) => {
          const row = await db.query('select encrypted_password from auth.users where id = $1::uuid', [member.userId]);
          return row.rows[0].encrypted_password as string;
        });
      const before = await readHash();

      const response = await request.put(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: ANON_KEY, ...bearer(member.accessToken), 'Content-Type': 'application/json' },
        data: { password: newPassword() },
      });
      expect(response.status(), '直接のパスワード変更の status').toBeGreaterThanOrEqual(400);
      expect(response.status(), '直接のパスワード変更の status').toBeLessThan(500);
      expect(JSON.stringify(await jsonOf(response)), '再認証を求める誤りの文面').toMatch(/reauthentication/i);
      expect(await readHash(), '変更後のパスワードのハッシュ').toBe(before);
    });
  });
}

// ---- SEC-AUTH-028 ----

for (const viewport of viewports) {
  test.describe(`SEC-AUTH-028-AC-02 user_metadata に admin を書いた会員は管理の窓口が 403 (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`SEC-AUTH-028-AC-02 会員の JWT で /auth/v1/user に data.role=admin を送ってから、更新した JWT で /api/auth/me と管理の窓口を叩くと、役割が user のままで、管理の窓口が 403 になる (${viewport.name})`, async ({ page, baseURL }) => {
      requireLocalApp(baseURL);
      const origin = new URL(baseURL ?? '').origin;
      const source = `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
      // user_metadata を書き換える試験なので、試験ごとに会員を作る。
      // JWT はアプリの窓口（メールの確認コード）を通して得る。GoTrue のパスワード grant で直に得た JWT は
      // SEC-AUTH-005-AC-01 が拒否する対象なので、この試験の前提にしない。
      const member = await createTestMember('metarole');
      await loginAsMember(page, member, source);
      const cookieValue = async (name: string) =>
        (await page.context().cookies(origin)).find((cookie) => cookie.name === name)?.value;
      const accessToken = await cookieValue('sb-access-token');
      expect(accessToken, 'アプリが発行したアクセストークン（準備）').toBeTruthy();

      const written = await page.request.put(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: ANON_KEY, ...bearer(accessToken as string), 'Content-Type': 'application/json' },
        data: { data: { role: 'admin' } },
      });
      expect(written.status(), 'user_metadata の書き込み（準備）').toBe(200);

      // 書いた値が入った JWT を、アプリの窓口で作り直す（Cookie が更新される）
      const refreshed = await page.request.post('/api/auth/refresh', {
        headers: { origin, 'x-forwarded-for': source },
        maxRedirects: 0,
      });
      expect(refreshed.status(), '/api/auth/refresh（準備）').toBe(200);
      const newAccessToken = await cookieValue('sb-access-token');
      expect(newAccessToken, '更新したアクセストークン（準備）').toBeTruthy();
      const claims = claimsOf(newAccessToken as string);
      expect(claims.user_metadata?.role, '更新した JWT の user_metadata.role（準備）').toBe('admin');
      expect(claims.app_metadata?.role, '更新した JWT の app_metadata.role').not.toBe('admin');

      const me = await page.request.get('/api/auth/me');
      expect(await jsonOf(me), '/api/auth/me の応答').toMatchObject({
        authenticated: true,
        user: { id: member.userId, role: 'user' },
      });

      const adminWindow = await page.request.get('/api/admin/users');
      expect(adminWindow.status(), '管理の窓口 /api/admin/users の status').toBe(403);
    });
  });
}
