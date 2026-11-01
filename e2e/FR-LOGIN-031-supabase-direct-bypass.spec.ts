/**
 * FR-LOGIN-031 Supabase Auth・PostgREST を直接呼ぶ道（アプリの窓口を通らない道）でも、2段階のログイン・DB の権限・登録の決まりが飛ばせない
 * 対応: SEC-AUTH-005-AC-01 / SEC-AUTH-005-AC-02 / SEC-AUTH-010-AC-01 / SEC-AUTH-011-AC-01 / SEC-AUTH-012-AC-01
 *       SEC-AUTH-015-AC-01 / SEC-AUTH-015-AC-02 / SEC-AUTH-015-AC-05 / SEC-AUTH-028-AC-02
 *       SEC-AUTH-005-AC-03 / SEC-AUTH-005-AC-05 / SEC-AUTH-030-AC-03 / SEC-AUTH-031-AC-02 / SEC-AUTH-010-AC-03
 *       SEC-AUTH-015-AC-04 / SEC-AUTH-035-AC-01 / SEC-AUTH-035-AC-02（波 6。手元の Auth の captcha を有効にした設定で通る）
 *
 * 手元の Supabase（GoTrue の /auth/v1、PostgREST の /rest/v1）を anon の鍵と、パスワードだけで得た JWT で直接叩く。
 * アプリの窓口（/api/auth/me・/api/profile・/api/orders・/api/admin/users）は Bearer で叩く。画面は開かない。
 * HTTP の試験なので結果は画面の幅で変わらない。1つの幅（desktop）だけ流す（DB の書き込みと回数の制限の枠を3倍にしない）。
 *
 * 既知の赤: SEC-AUTH-012 は、2026-10-24 時点で文書に載せた「今のコードは満たさない」点（docs/02_Requirements/areas/auth.md）。
 * SEC-AUTH-015-AC-01・AC-02（24 時間を過ぎた session）・AC-04 は、手元の Auth を本番の前提にそろえた設定（波 6。最小長 16・
 * secure_password_change・captcha）で通る。SEC-AUTH-015-AC-05 の「現行パスワード無しは 400」だけは、CLI の config.toml に鍵が無く
 * 手元で設定できないので、ENV の印（test.fail）のまま残す（本番の設定は Management API の GET で確かめる）。
 * SEC-AUTH-005-AC-02・005-AC-03 の PostgREST の側・010-AC-01・010-AC-03 は、DB の移行 M2（波 5。has_permission に aal2 と結び付いた生きた session を求め、
 * profiles・orders・order_items に RESTRICTIVE の方針を足す）を当てた DB で通る（test.fail は外した。M2 を当てていない DB では赤）。
 * SEC-AUTH-005-AC-01・03・05、SEC-AUTH-030-AC-03、SEC-AUTH-031-AC-02 は波 5 でアプリの窓口が満たす（旗 AUTH_REQUIRE_APP_SESSION は E2E で固定の on）。
 * SEC-AUTH-028-AC-02 は満たす。AC ごとに describe を分け、赤を互いに混ぜない。
 * （012 は G-2 の移行 20261024153505 が anon・authenticated の EXECUTE を外すので、その移行を当てた DB では緑になる。
 *  011 は移行 sec_grants_hardening が認証の表の権限を外すので、その移行を当てた DB では緑になる）
 *
 * 前提: 手元の Supabase（npm run db:start）と手元の E2E アプリ。会員・管理者は auth.admin.createUser で既知のパスワードつきで作る。
 * GoTrue のログイン・登録の枠（5 分で 30 回、全部の E2E で共有）を節約するため、読むだけの試験で使う会員・管理者は worker ごとに1回だけ
 * ログインして使い回す。書き換える試験（015-AC-02・028-AC-02）は試験ごとに会員を作る（028-AC-02 はアプリの窓口を通して JWT を得る）。
 * 波 5 の試験（005-AC-03・031-AC-02）は、アプリを通らない「OTP だけの通行証」を anon の鍵で /auth/v1/otp → 受け箱の8桁のコード →
 * /auth/v1/verify の順に直接呼んで得る（amr に otp が付く。パスワードは使わない）。この通行証は GoTrue には本物として通るが、
 * 自前の sessions に結び付いた行が無いので、アプリは断る。攻撃側の通行証は結び付けない。対照の会員・管理者（005-AC-03・010-AC-03）だけは createAdminSessionActor で結び付けて使う（「読めない」が権限の無さのせいでないことの確かめ）。
 * 後始末: 足した注文は消す。利用者は残る（db reset で消える）。役割 admin を付けた利用者は user_roles を無効にする。
 * JWT・パスワードが通信記録に残らないよう trace は切る。失敗の文面にも出さない。
 */
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { Client } from 'pg';
import { expect, test, type APIResponse } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { createAdminSessionActor, elevateAdminSessionToAal2 } from './admin-session-test-utils';
import { withDummyCaptcha } from './captcha-test-utils';
import { createTestMember, loginAsMember, readLatestCode, readMailpitMessages } from './member-session-helpers';

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
  amr?: Array<{ method?: string }>;
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

/** 役割 admin を付けた利用者と、対照に使う役割 user の利用者。afterAll で user_roles を無効にする */
const adminUserIds: string[] = [];
type TokenReply = { access_token?: string; refresh_token?: string };

/** 手元の GoTrue のトークンの要求（Node から。JWT を通信記録に載せない） */
async function requestToken(grantType: 'password' | 'refresh_token', body: Record<string, string>): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=${grantType}`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'content-type': 'application/json' },
    // captcha が有効な Auth に anon の鍵で直に叩く password grant にだけダミーのトークンを付ける（refresh_token は captcha が掛からない）
    body: JSON.stringify(grantType === 'password' ? withDummyCaptcha(body) : body),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {
    throw new Error(`手元の Auth の ${grantType} の要求に失敗した`);
  });
  if (!res.ok) throw new Error(`手元の Auth の ${grantType} が通らない: ${res.status}`);
  const reply = (await res.json().catch(() => ({}))) as TokenReply;
  if (!reply.access_token || !reply.refresh_token) throw new Error(`手元の Auth の ${grantType} の応答に token が無い`);
  return { accessToken: reply.access_token, refreshToken: reply.refresh_token };
}

/** 既知のパスワードで利用者を作るだけ（通行証は取らない）。admin なら役割 admin も付ける */
async function createUnsignedActor(label: string, options: { admin?: boolean } = {}): Promise<Omit<Actor, 'accessToken' | 'refreshToken'>> {
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
  return { userId, email, password };
}

/** 既知のパスワードで作った利用者が、パスワードだけで（OTP を通らずに）得た JWT を持つ */
async function createSignedInActor(label: string, options: { admin?: boolean } = {}): Promise<Actor> {
  const created = await createUnsignedActor(label, options);
  const tokens = await requestToken('password', { email: created.email, password: created.password });
  return { ...created, ...tokens };
}

/** GoTrue の送り元の枠（IP ごと）を全部の E2E で使い切らないよう、試験ごとに別の値を付ける */
const uniqueForwardedFor = (): string => `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;

/** アプリの窓口を叩く時の、回数の制限を試験ごとに分ける送り元（手元の E2E サーバーだけで効く。CLIENT_IP_HEADER=x-real-ip） */
const uniqueSourceIp = (): string => `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0] % 253) + 1}`;

/**
 * アプリを通らずに、anon の鍵で /auth/v1/otp → 受け箱の8桁のコード → /auth/v1/verify を直接呼んで得た通行証。
 * パスワードは使わない。amr は otp になる。Node から呼ぶので JWT・コードが通信記録に載らない。
 */
async function requestOtpOnlyTokens(email: string): Promise<{ accessToken: string; refreshToken: string }> {
  requireLocalEnv();
  const previousMessageIds = new Set((await readMailpitMessages(email)).map((message) => message.ID));
  const headers = { apikey: ANON_KEY, 'content-type': 'application/json', 'x-forwarded-for': uniqueForwardedFor() };
  const sent = await fetch(`${SUPABASE_URL}/auth/v1/otp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(withDummyCaptcha({ email, create_user: false })),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {
    throw new Error('手元の Auth の /otp の要求に失敗した');
  });
  if (!sent.ok) throw new Error(`手元の Auth の /otp が通らない: ${sent.status}`);
  const code = await readLatestCode(email, previousMessageIds);
  const verified = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
    method: 'POST',
    headers: { ...headers, 'x-forwarded-for': uniqueForwardedFor() },
    body: JSON.stringify({ type: 'email', email, token: code }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {
    throw new Error('手元の Auth の /verify の要求に失敗した');
  });
  if (!verified.ok) throw new Error(`手元の Auth の /verify が通らない: ${verified.status}`);
  const reply = (await verified.json().catch(() => ({}))) as TokenReply;
  if (!reply.access_token || !reply.refresh_token) throw new Error('手元の Auth の /verify の応答に token が無い');
  return { accessToken: reply.access_token, refreshToken: reply.refresh_token };
}

/** 読むだけの試験で使い回す。ログインの枠を使い切らないよう worker ごとに1回だけ作る */
let sharedMemberPromise: Promise<Actor> | null = null;
let sharedAdminPromise: Promise<Actor> | null = null;
const sharedMember = (): Promise<Actor> => (sharedMemberPromise ??= createSignedInActor('member'));
const sharedAdmin = (): Promise<Actor> => (sharedAdminPromise ??= createSignedInActor('admin', { admin: true }));

/** 管理者が DB の ACL で admin.orders.read を持つこと（権限が無くて読めないのでは試験にならない） */
async function expectHoldsOrdersRead(userId: string): Promise<void> {
  await withDb(async (db) => {
    const held = await db.query(
      `select count(*)::int as n
         from public.user_roles ur
         join public.role_permissions rp on rp.role_id = ur.role_id
         join public.permissions p on p.id = rp.permission_id
        where ur.user_id = $1::uuid and ur.active = true and (ur.expires_at is null or ur.expires_at > now())
          and p.code = 'admin.orders.read'`,
      [userId],
    );
    expect(held.rows[0].n, '管理者が持つ admin.orders.read（準備）').toBeGreaterThan(0);
  });
}

/** 会員本人の profiles と注文が実在することを保つ（無いと「読めない」が空の表のせいで成り立つ） */
const ownedRowsByUser = new Map<string, Promise<string>>();
function ensureOwnedRows(member: Pick<Actor, 'userId'>): Promise<string> {
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
  // 注文は法定の削除禁止トリガーで消せない。db reset に任せる。
  if (adminUserIds.length === 0) return;
  await withDb(async (db) => {
    await db.query('update public.user_roles set active = false where user_id = any($1::uuid[])', [adminUserIds]);
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

for (const viewport of viewports) {
  test.describe(`SEC-AUTH-005-AC-03 メール OTP だけで取った通行証でもアプリの会員の窓口が通らない (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`SEC-AUTH-005-AC-03 パスワード無しで /auth/v1/otp と /auth/v1/verify を直接呼んで得た通行証を Bearer か Cookie で送ると、/api/auth/me が authenticated: false を返し、会員の窓口が 401 を返す (${viewport.name})`, async ({ request, baseURL }) => {
      requireLocalApp(baseURL);
      const user = await createUnsignedActor('otponly');
      const tokens = await requestOtpOnlyTokens(user.email);

      // 準備: この通行証は Auth 自身には本物として通り、amr に otp が付く（amr ではアプリのログインを通ったかを区別できない）
      const claims = claimsOf(tokens.accessToken);
      expect(claims.sub, '通行証の利用者（準備）').toBe(user.userId);
      expect(claims.amr?.some((entry) => entry.method === 'otp'), '通行証の amr に otp がある（準備）').toBe(true);
      const direct = await request.get(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON_KEY, ...bearer(tokens.accessToken) } });
      expect(direct.status(), 'Auth 自身の /auth/v1/user（準備）').toBe(200);

      const me = await request.get('/api/auth/me', { headers: bearer(tokens.accessToken) });
      expect(await jsonOf(me), '/api/auth/me の応答').toMatchObject({ authenticated: false });

      const profile = await request.get('/api/profile', { headers: bearer(tokens.accessToken) });
      expect(profile.status(), '会員の窓口 /api/profile の status（Bearer）').toBe(401);
      const orders = await request.get('/api/orders', { headers: bearer(tokens.accessToken) });
      expect(orders.status(), '会員の窓口 /api/orders の status（Bearer）').toBe(401);

      // Cookie で送っても同じ（アプリの Cookie の名前で access token を渡す）
      const viaCookie = await request.get('/api/profile', { headers: { Cookie: `sb-access-token=${tokens.accessToken}` } });
      expect(viaCookie.status(), '会員の窓口 /api/profile の status（Cookie）').toBe(401);
    });
  });
}

for (const viewport of viewports) {
  test.describe(`SEC-AUTH-005-AC-03 メール OTP だけで取った通行証では PostgREST から profiles と注文が読めない (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`SEC-AUTH-005-AC-03 パスワード無しで /auth/v1/otp と /auth/v1/verify を直接呼んで得た通行証で PostgREST の profiles・orders を select した結果に、本人の profiles と注文の行が含まれない (${viewport.name})`, async ({ request }) => {
      // 対照: アプリのログインと同じ形で結び付けた会員は、同じ表で自分の行が読める（「読めない」が空の表や権限の無さのせいではないことの確かめ）
      const bound = await withDb((db) => createAdminSessionActor(db as unknown as PgClient, 'user', 'aal1'));
      adminUserIds.push(bound.userId);
      await ensureOwnedRows(bound);
      const boundProfiles = await request.get(`${SUPABASE_URL}/rest/v1/profiles?select=user_id&user_id=eq.${bound.userId}`, {
        headers: postgrestHeaders(bound.accessToken),
      });
      expect(await selectedRows(boundProfiles, '結び付いた会員の profiles'), '結び付いた会員の本人の profiles の行').toHaveLength(1);
      const boundOrders = await request.get(`${SUPABASE_URL}/rest/v1/orders?select=id,user_id&user_id=eq.${bound.userId}`, {
        headers: postgrestHeaders(bound.accessToken),
      });
      expect(await selectedRows(boundOrders, '結び付いた会員の orders'), '結び付いた会員の本人の注文の行').toHaveLength(1);

      const user = await createUnsignedActor('otponlydb');
      await ensureOwnedRows(user);
      const tokens = await requestOtpOnlyTokens(user.email);

      // 準備: この通行証は Auth 自身には本物として通り、amr に otp が付く
      const claims = claimsOf(tokens.accessToken);
      expect(claims.sub, '通行証の利用者（準備）').toBe(user.userId);
      expect(claims.amr?.some((entry) => entry.method === 'otp'), '通行証の amr に otp がある（準備）').toBe(true);
      const direct = await request.get(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON_KEY, ...bearer(tokens.accessToken) } });
      expect(direct.status(), 'Auth 自身の /auth/v1/user（準備）').toBe(200);

      const profiles = await request.get(`${SUPABASE_URL}/rest/v1/profiles?select=user_id&user_id=eq.${user.userId}`, {
        headers: postgrestHeaders(tokens.accessToken),
      });
      expect(await selectedRows(profiles, 'OTP だけの通行証の profiles'), 'OTP だけの通行証に見えた本人の profiles の行').toEqual([]);
      const orders = await request.get(`${SUPABASE_URL}/rest/v1/orders?select=id,user_id&user_id=eq.${user.userId}`, {
        headers: postgrestHeaders(tokens.accessToken),
      });
      expect(await selectedRows(orders, 'OTP だけの通行証の orders'), 'OTP だけの通行証に見えた本人の注文の行').toEqual([]);
    });
  });
}

for (const viewport of viewports) {
  test.describe(`SEC-AUTH-005-AC-05 結び付いていない session の refresh token では更新が通らず、結び付いた session に洗えない (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`SEC-AUTH-005-AC-05 password grant の refresh token を sb-refresh-token の Cookie に入れて /api/auth/refresh を叩くと 401 になり、認証の Cookie が消え、その session に結び付いた行ができない (${viewport.name})`, async ({ request, baseURL }) => {
      requireLocalApp(baseURL);
      const origin = new URL(baseURL ?? '').origin;
      // 試験ごとに利用者と session を作る（更新を試みる対象の session を他の試験と分ける）
      const member = await createSignedInActor('washing');
      const authSessionId = claimsOf(member.accessToken).session_id;
      expect(authSessionId, 'password grant の通行証の session_id（準備）').toBeTruthy();

      const refreshed = await request.post(new URL('/api/auth/refresh', origin).toString(), {
        headers: { origin, 'x-real-ip': uniqueSourceIp(), Cookie: `sb-refresh-token=${member.refreshToken}` },
        failOnStatusCode: false,
        maxRedirects: 0,
      });
      expect(refreshed.status(), '/api/auth/refresh の status').toBe(401);
      // 本文は読み切る（読まない呼び手は要求を開いたままにする）。新しい token 対を返していない
      const body = (await jsonOf(refreshed)) as Record<string, unknown> | null;
      expect(body !== null && 'access_token' in body, '応答の本文に access_token が無い').toBe(false);

      // 認証の 3 つの Cookie を消す Set-Cookie（値が空）が付く
      const cleared = new Set(
        refreshed
          .headersArray()
          .filter((header) => header.name.toLowerCase() === 'set-cookie')
          .map((header) => header.value.split(';')[0] ?? '')
          .filter((pair) => pair.endsWith('=') && pair.length > 1)
          .map((pair) => pair.slice(0, -1)),
      );
      for (const name of ['sb-refresh-token', 'sb-access-token', 'sb-csrf-token']) {
        expect(cleared.has(name), `${name} を消す Set-Cookie が付く`).toBe(true);
      }

      // 洗われていれば、この session_id に結び付いた行が自前の sessions にできる
      await withDb(async (db) => {
        const bound = await db.query('select count(*)::int as n from public.sessions where auth_session_id = $1::uuid', [authSessionId]);
        expect(bound.rows[0].n, 'この session に結び付いた sessions の行').toBe(0);
      });
    });
  });
}

// ---- SEC-AUTH-010 ----

for (const viewport of viewports) {
  test.describe(`SEC-AUTH-010-AC-01 aal1 の管理者の JWT で他人の注文が読めない (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`SEC-AUTH-010-AC-01 admin の役割の利用者の aal1 の JWT で PostgREST の orders を select した結果に、その管理者以外の注文の行が含まれない (${viewport.name})`, async ({ request }) => {
      const admin = await sharedAdmin();
      const member = await sharedMember();
      const foreignOrderId = await ensureOwnedRows(member);

      // 準備: aal1 の JWT であり、この管理者は注文を読む権限を DB の ACL で持つ（権限が無くて読めないのでは試験にならない）
      expect(claimsOf(admin.accessToken).aal, '管理者の JWT の aal').toBe('aal1');
      await expectHoldsOrdersRead(admin.userId);

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

for (const viewport of viewports) {
  test.describe(`SEC-AUTH-010-AC-03 結び付いた admin でも aal1 の JWT では他人の注文が読めず、同じ人の aal2 の JWT では読める (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`SEC-AUTH-010-AC-03 アプリのログインと同じ形で結び付けた admin の aal1 の JWT で PostgREST の orders を select した結果に他人の注文の行が含まれず、同じ session を aal2 に上げた JWT では含まれる (${viewport.name})`, async ({ request }) => {
      const member = await sharedMember();
      const foreignOrderId = await ensureOwnedRows(member);
      // 結び付けた（生きた session がある）admin。aal1 の JWT と、同じ session を上げた aal2 の JWT。違いは aal だけ
      const aal1Admin = await withDb((db) => createAdminSessionActor(db as unknown as PgClient, 'admin', 'aal1'));
      adminUserIds.push(aal1Admin.userId);
      const aal2Admin = await withDb((db) => elevateAdminSessionToAal2(db as unknown as PgClient, aal1Admin));
      expect(aal1Admin.appBound, '管理者の通行証が結び付いている（準備）').toBe(true);
      expect(claimsOf(aal1Admin.accessToken).aal, '一方の JWT の aal').toBe('aal1');
      expect(claimsOf(aal2Admin.accessToken).aal, 'もう一方の JWT の aal').toBe('aal2');
      expect(claimsOf(aal1Admin.accessToken).session_id, '二つの JWT は同じ session').toBe(claimsOf(aal2Admin.accessToken).session_id);
      await expectHoldsOrdersRead(aal1Admin.userId);

      // 対照: aal2 の JWT では他人の注文が読める（権限・結び付き・生存は揃っている。止めているのは aal だけ）
      const viaAal2 = await request.get(`${SUPABASE_URL}/rest/v1/orders?select=id,user_id&id=eq.${foreignOrderId}`, {
        headers: postgrestHeaders(aal2Admin.accessToken),
      });
      expect((await selectedRows(viaAal2, 'aal2 の管理者の他人の注文')).map((row) => row.id), 'aal2 の管理者に見えた他人の注文').toEqual([foreignOrderId]);

      const viaAal1 = await request.get(`${SUPABASE_URL}/rest/v1/orders?select=id,user_id&id=eq.${foreignOrderId}`, {
        headers: postgrestHeaders(aal1Admin.accessToken),
      });
      expect(await selectedRows(viaAal1, 'aal1 の管理者の他人の注文'), 'aal1 の管理者に見えた他人の注文の行').toEqual([]);
      const others = await request.get(
        `${SUPABASE_URL}/rest/v1/orders?select=id,user_id&or=(user_id.is.null,user_id.neq.${aal1Admin.userId})&limit=5`,
        { headers: postgrestHeaders(aal1Admin.accessToken) },
      );
      expect(await selectedRows(others, 'aal1 の管理者の他人の注文（絞らない）'), 'aal1 の管理者に見えた管理者以外の注文の行').toEqual([]);
    });
  });
}

// ---- SEC-AUTH-011 ----

const AUTH_TABLES = ['sessions', 'password_reset_tokens', 'rate_limit_counters', 'audit_logs', 'audit_logs_backups'] as const;

for (const viewport of viewports) {
  test.describe(`SEC-AUTH-011-AC-01 anon・会員の JWT で認証の表を読むと権限の誤りになる (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`SEC-AUTH-011-AC-01 anon の鍵と会員の JWT で sessions・password_reset_tokens・rate_limit_counters・audit_logs・audit_logs_backups を select すると、0件ではなく権限の誤り（401 か 403）になる (${viewport.name})`, async ({ request }) => {
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

    test(`SEC-AUTH-015-AC-01 anon の鍵で /auth/v1/signup をダミーの captcha トークン付きで直接呼び 15 文字のパスワードで登録すると、弱いパスワードの誤りになり、利用者ができない (${viewport.name})`, async ({ request }) => {
      // captcha で断られたのではなく、長さの決まり（minimum_password_length = 16）で断られることを見るため、ダミーのトークンを付ける。
      // トークン無しで断られることは SEC-AUTH-015-AC-04 が受け持つ。
      requireLocalEnv();
      const email = newEmail('signup15');
      const password = 'Abcdefgh1234!xy';
      expect(password, '送るパスワードの長さ（準備）').toHaveLength(15);

      const response = await request.post(`${SUPABASE_URL}/auth/v1/signup`, {
        headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
        data: withDummyCaptcha({ email, password }),
      });
      // 429（枠切れ）・captcha の 400 は長さの決まりで断られたのではない
      expect(response.status(), '直接の登録が枠切れ（429）で断られていない').not.toBe(429);
      expect(response.status(), '直接の登録の status（弱いパスワード）').toBe(422);
      const body = (await jsonOf(response)) as Record<string, unknown> | null;
      expect(body?.error_code, '直接の登録の誤りの符号').toBe('weak_password');
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

    test(`SEC-AUTH-015-AC-05 会員の access token だけで /auth/v1/user に現行パスワード無しでパスワードの変更を送ると、現行パスワードを求める誤りになり、パスワードが変わらない (${viewport.name})`, async ({ request }) => {
      test.fail(true, 'ENV security_update_password_require_current_password は CLI の config.toml に鍵が無く手元で設定できない（本番は Management API の GET で確かめる。SEC-AUTH-015-AC-05）');
      // パスワードを書き換える試験なので、試験ごとに会員を作る
      const member = await createSignedInActor('pwchange-current');
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
      expect(response.status(), '現行パスワード無しの直接のパスワード変更の status').toBe(400);
      expect(JSON.stringify(await jsonOf(response)), '現行パスワードを求める誤りの文面').toMatch(/current_password_required/i);
      expect(await readHash(), '変更後のパスワードのハッシュ').toBe(before);
    });

    test(`SEC-AUTH-015-AC-02 作ってから 24 時間を過ぎた session の access token だけで /auth/v1/user にパスワードの変更を送ると、再認証を求める誤りになり、パスワードが変わらない (${viewport.name})`, async ({ request }) => {
      // secure_password_change = true は、作ってから 24 時間以内の session には再認証を求めない（設定で変えられない窓）。
      // 古い session の側を見るため、session の作成時刻を 25 時間前に戻す。
      const member = await createSignedInActor('pwchange-reauth');
      const sessionId = claimsOf(member.accessToken).session_id;
      expect(sessionId, 'access token の session_id（準備）').toBeTruthy();
      const readHash = (): Promise<string> =>
        withDb(async (db) => {
          const row = await db.query('select encrypted_password from auth.users where id = $1::uuid', [member.userId]);
          return row.rows[0].encrypted_password as string;
        });
      const before = await readHash();
      await withDb(async (db) => {
        const moved = await db.query("update auth.sessions set created_at = now() - interval '25 hours' where id = $1::uuid and user_id = $2::uuid", [
          sessionId,
          member.userId,
        ]);
        expect(moved.rowCount, '作成時刻を戻した session の数（準備）').toBe(1);
      });

      const response = await request.put(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: ANON_KEY, ...bearer(member.accessToken), 'Content-Type': 'application/json' },
        data: { password: newPassword() },
      });
      expect(response.status(), '直接のパスワード変更の status').toBe(400);
      expect(await jsonOf(response), '再認証を求める誤りの error_code').toMatchObject({ error_code: 'reauthentication_needed' });
      expect(await readHash(), '変更後のパスワードのハッシュ').toBe(before);
    });
  });
}

// ---- SEC-AUTH-015-AC-04・SEC-AUTH-035-AC-01（波 6: Supabase の captcha） ----
// 手元の Auth の captcha を有効にした設定（2026-11-01 の波 6 の切り替えで supabase/config.toml に入れた）で通る。

for (const viewport of viewports) {
  test.describe(`SEC-AUTH-015-AC-04 トークン無しの直接の /signup・/token・/otp が captcha で断られる (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`SEC-AUTH-015-AC-04 anon の鍵で /auth/v1/signup・/auth/v1/token（password）・/auth/v1/otp を captcha のトークン無しで直接呼ぶと、どれも 400 で本文に captcha を含み、通行証も利用者もメールも出ない (${viewport.name})`, async ({ request }) => {
      requireLocalEnv();
      // 実在する会員（既知のパスワード）を使う。400 が「資格情報の誤り」でなく captcha の断りであることを見せるため
      const existing = await createUnsignedActor('captcha');
      const signupEmail = newEmail('captcha-signup');
      const previousExistingIds = new Set((await readMailpitMessages(existing.email)).map((message) => message.ID));
      const calls = [
        { path: '/auth/v1/signup', data: { email: signupEmail, password: newPassword() } },
        { path: '/auth/v1/token?grant_type=password', data: { email: existing.email, password: existing.password } },
        { path: '/auth/v1/otp', data: { email: existing.email, create_user: false } },
      ] as const;

      for (const call of calls) {
        const response = await request.post(`${SUPABASE_URL}${call.path}`, {
          headers: { apikey: ANON_KEY, 'Content-Type': 'application/json', 'x-forwarded-for': uniqueForwardedFor() },
          data: call.data,
        });
        expect(response.status(), `${call.path} の status`).toBe(400);
        const text = await response.text();
        expect(text, `${call.path} の本文が captcha の断り`).toMatch(/captcha/i);
        const body = (await jsonOf(response)) as Record<string, unknown> | null;
        expect(body?.access_token, `${call.path} の応答の access_token`).toBeUndefined();
        expect(body?.id, `${call.path} の応答の利用者`).toBeUndefined();
      }

      await withDb(async (db) => {
        const found = await db.query('select count(*)::int as n from auth.users where email = $1', [signupEmail]);
        expect(found.rows[0].n, '直接の登録の宛先の利用者の行').toBe(0);
      });
      // 断られた /otp と /signup は確認コードも確認のメールも出さない
      const newExistingMails = (await readMailpitMessages(existing.email)).filter((message) => !previousExistingIds.has(message.ID));
      expect(newExistingMails, '直接の /otp で会員に届いたメール').toHaveLength(0);
      expect(await readMailpitMessages(signupEmail), '直接の /signup の宛先に届いたメール').toHaveLength(0);
    });
  });
}

for (const viewport of viewports) {
  test.describe(`SEC-AUTH-035-AC-01 captcha が有効でもアプリのログインと会員登録が通る (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`SEC-AUTH-035-AC-01 直接の password grant が captcha で断られる会員でも、アプリの /api/auth/login は 200（確認コードの段）になり、/api/auth/register は 202 で利用者ができる (${viewport.name})`, async ({ request, baseURL }) => {
      requireLocalApp(baseURL);
      const origin = new URL(baseURL ?? '').origin;
      const turnstileToken = 'test-turnstile-token';
      const member = await createUnsignedActor('app-login');
      // 対照: 同じ資格情報の直接の password grant は captcha で断られる（アプリの窓口が管理者資格で通っていることの裏）
      const direct = await request.post(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        headers: { apikey: ANON_KEY, 'Content-Type': 'application/json', 'x-forwarded-for': uniqueForwardedFor() },
        data: { email: member.email, password: member.password },
      });
      expect(direct.status(), '直接の password grant の status（準備）').toBe(400);

      const login = await request.post(new URL('/api/auth/login', origin).toString(), {
        headers: { origin, 'x-real-ip': uniqueSourceIp() },
        data: { email: member.email, password: member.password, turnstileToken },
        maxRedirects: 0,
      });
      expect(login.status(), 'アプリのログインの status').toBe(200);
      expect(await jsonOf(login), 'アプリのログインの本文').toMatchObject({ step: 'otp' });

      const registerEmail = newEmail('app-register');
      try {
        const register = await request.post(new URL('/api/auth/register', origin).toString(), {
          headers: { origin, 'x-real-ip': uniqueSourceIp() },
          data: { email: registerEmail, password: newPassword(), turnstileToken },
          maxRedirects: 0,
        });
        expect(register.status(), 'アプリの会員登録の status').toBe(202);
        await withDb(async (db) => {
          const found = await db.query('select count(*)::int as n from auth.users where email = $1', [registerEmail]);
          expect(found.rows[0].n, '登録した宛先の利用者の行').toBe(1);
        });
      } finally {
        await withDb(async (db) => {
          await db.query('delete from auth.users where email = $1', [registerEmail]);
        });
      }
    });
  });
}

for (const viewport of viewports) {
  test.describe(`SEC-AUTH-035-AC-02 資格情報の誤りは captcha の拒否に丸められず 401 のまま (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    // captcha の拒否を 5xx と supabase_captcha_rejected にする側は、免除が効かない環境を手元に作れないので単体テストが受け持つ（DD-AUTH-040）。
    // ここでは captcha が有効な環境で、普通のパスワードの誤りが誤って 5xx や captcha の拒否にならないこと（見分けが逆向きに崩れないこと）を見る。
    test(`SEC-AUTH-035-AC-02 captcha が有効でも、アプリのログインに誤ったパスワードを送ると 401 で、監査は login・failure のまま supabase_captcha_rejected にならない (${viewport.name})`, async ({ request, baseURL }) => {
      requireLocalApp(baseURL);
      const origin = new URL(baseURL ?? '').origin;
      const member = await createUnsignedActor('captcha-wrong-pw');
      const wrong = `Wrong-${randomBytes(10).toString('hex')}-Pw!`;

      const login = await request.post(new URL('/api/auth/login', origin).toString(), {
        headers: { origin, 'x-real-ip': uniqueSourceIp() },
        data: { email: member.email, password: wrong, turnstileToken: 'test-turnstile-token' },
        maxRedirects: 0,
      });
      expect(login.status(), '誤ったパスワードのログインの status').toBe(401);
      expect(await login.json(), '誤ったパスワードのログインの本文').toEqual({ error: 'メールアドレスまたはパスワードが正しくありません。' });

      await withDb(async (db) => {
        const outcomes = await db.query(`select a.outcome from public.audit_logs a where a.actor_email = $1 and a.action = 'login'`, [member.email]);
        expect(
          outcomes.rows.map((row) => row.outcome as string),
          'ログインの監査の outcome（failure の行があり、error の道に落ちていない）',
        ).toContain('failure');
        const rows = await auditRowTexts(db, `a.actor_email = $1 and a.action = 'login'`, [member.email]);
        expect(rows.length, 'ログインの監査の行').toBeGreaterThan(0);
        expect(rows.some((row) => row.includes('supabase_captcha_rejected')), 'captcha の拒否の符号が無い').toBe(false);
        expect(rows.some((row) => row.includes(wrong)), '監査の行に送ったパスワードが無い').toBe(false);
      });
    });
  });
}

// ---- SEC-AUTH-030・031（波 5: 結び付けの拒否と、初めての TOTP の登録） ----

/** 監査の行を文字列にした物。トークン・session_id の値が入っていないかを、値そのものを出さずに真偽で比べるため */
const auditRowTexts = (db: Client, where: string, params: unknown[]): Promise<string[]> =>
  db
    .query(`select to_jsonb(a)::text as row_text from public.audit_logs a where ${where}`, params)
    .then((result) => result.rows.map((row) => row.row_text as string));

for (const viewport of viewports) {
  test.describe(`SEC-AUTH-030-AC-03 結び付けで断った更新が固定の符号だけで監査に残る (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`SEC-AUTH-030-AC-03 結び付いていない refresh token での更新を断ると、audit_logs に refresh・failure・unbound_session の行が増え、その行にトークンと session_id の値が無い (${viewport.name})`, async ({ request, baseURL }) => {
      requireLocalApp(baseURL);
      const origin = new URL(baseURL ?? '').origin;
      const member = await createSignedInActor('unbound-audit');
      const authSessionId = claimsOf(member.accessToken).session_id ?? '';
      expect(authSessionId, 'password grant の通行証の session_id（準備）').not.toBe('');
      const startedAt = await withDb(async (db) => (await db.query('select now() as t')).rows[0].t as Date);

      const refreshed = await request.post(new URL('/api/auth/refresh', origin).toString(), {
        headers: { origin, 'x-real-ip': uniqueSourceIp(), Cookie: `sb-refresh-token=${member.refreshToken}` },
        failOnStatusCode: false,
        maxRedirects: 0,
      });
      expect(refreshed.status(), '/api/auth/refresh の status').toBe(401);
      await jsonOf(refreshed); // 本文は読み切る

      const texts = await withDb((db) =>
        auditRowTexts(db, `action = 'refresh' and outcome = 'failure' and detail = 'unbound_session' and created_at >= $1`, [startedAt]),
      );
      expect(texts.length, '断りの監査の行（refresh・failure・unbound_session）').toBeGreaterThanOrEqual(1);
      for (const text of texts) {
        expect.soft(text.includes(member.refreshToken), '監査の行に refresh token の値が無い').toBe(false);
        expect.soft(text.includes(member.accessToken), '監査の行に access token の値が無い').toBe(false);
        expect.soft(text.includes(authSessionId), '監査の行に session_id の値が無い').toBe(false);
      }
    });
  });
}

for (const viewport of viewports) {
  test.describe(`SEC-AUTH-031-AC-02 メール OTP だけで取った通行証では初めての TOTP の登録が 401 で断られる (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`SEC-AUTH-031-AC-02 TOTP の無い管理者が /auth/v1/otp と /auth/v1/verify を直接呼んで得た通行証で /api/auth/mfa/enroll-totp を叩くと、401 になり、要素が作られず、mfa_enroll・denied・app_session_required の行が監査に 1 つ増える (${viewport.name})`, async ({ request, baseURL }) => {
      requireLocalApp(baseURL);
      const origin = new URL(baseURL ?? '').origin;
      // 役割 admin を付けた利用者（afterAll で user_roles を無効にする）。TOTP は登録しない
      const admin = await createUnsignedActor('otpadmin', { admin: true });
      const tokens = await requestOtpOnlyTokens(admin.email);
      const claims = claimsOf(tokens.accessToken);
      const authSessionId = claims.session_id ?? '';
      expect(authSessionId, '通行証の session_id（準備）').not.toBe('');
      expect(claims.aal, '通行証の aal（準備）').toBe('aal1');
      expect(claims.amr?.some((entry) => entry.method === 'otp'), '通行証の amr に otp がある（準備。amr の確かめでは断れない通行証）').toBe(true);
      const factorCount = (): Promise<number> =>
        withDb(async (db) => {
          const result = await db.query('select count(*)::int as n from auth.mfa_factors where user_id = $1::uuid', [admin.userId]);
          return result.rows[0].n as number;
        });
      expect(await factorCount(), '登録の前は要素が無い（準備）').toBe(0);

      const response = await request.post(new URL('/api/auth/mfa/enroll-totp', origin).toString(), {
        headers: { ...bearer(tokens.accessToken), origin, 'x-real-ip': uniqueSourceIp() },
        data: {},
        failOnStatusCode: false,
        maxRedirects: 0,
      });
      expect(response.status(), '/api/auth/mfa/enroll-totp の status（403 ではなく、結び付けの断りの 401）').toBe(401);
      await jsonOf(response); // 本文は読み切る
      expect(await factorCount(), '要素が作られない').toBe(0);

      const texts = await withDb((db) =>
        auditRowTexts(db, `actor_id::text = $1 and action = 'mfa_enroll' and outcome = 'denied' and detail = 'app_session_required'`, [admin.userId]),
      );
      expect(texts.length, '断りの監査の行（mfa_enroll・denied・app_session_required）が 1 つ').toBe(1);
      expect.soft(texts[0]?.includes(tokens.accessToken), '監査の行に access token の値が無い').toBe(false);
      expect.soft(texts[0]?.includes(tokens.refreshToken), '監査の行に refresh token の値が無い').toBe(false);
      expect.soft(texts[0]?.includes(authSessionId), '監査の行に session_id の値が無い').toBe(false);
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
        headers: { origin, 'x-real-ip': source },
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
