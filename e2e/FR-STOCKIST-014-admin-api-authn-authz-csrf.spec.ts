/**
 * FR-STOCKIST-014 管理の取扱店の窓口（/api/admin/stockists と /api/admin/stockists/<id>）の認証・認可・CSRF・回数の制限・監査
 * 対応: SEC-STOCKIST-006-AC-01〜04 / SEC-STOCKIST-004-AC-01・02 / SEC-STOCKIST-005-AC-01 / SEC-STOCKIST-019-AC-03 / SEC-STOCKIST-020-AC-01 / SEC-STOCKIST-021-AC-01〜03
 *
 * 画面を描かない HTTP だけの試験なので、画面幅（390/768/1280）ごとには繰り返さない（FR-ADMIN-123 の本物の HTTP の試験と同じ扱い）。
 * 各 AC に1本。名前の先頭が AC の ID。
 *
 * 本物の管理者のログイン（2段階認証が要る）は E2E の道具に無いので、この spec の中で次の道で作る（手元の Supabase だけ）。
 * 1. service role で利用者を作り（パスワード付き）、役割を DB へ割り当てる（店長 admin・サポーター supporter は既存の役割、
 *    読みだけは試験用の役割 e2e-stk014-ro-* を作って admin.stockists.read だけを付け、終わりに消す）。
 * 2. 本物の GoTrue にパスワードでログインして aal1 の access token を得る。aal2 は、その session の auth.sessions.aal と
 *    auth.mfa_amr_claims（authentication_method = 'totp'）を DB で整えてから refresh し、GoTrue に aal2 の token を発行させる
 *    （TOTP の登録・確認は手元の config で止めてあるので、この道を使う。署名は本物の GoTrue の鍵）。
 * 3. アプリの Cookie の session（sb-access-token・sb-refresh-token）は、public.sessions に refresh token と CSRF token の
 *    sha256 を入れた行を DB で作り、Cookie と x-csrf-token の組を本物のログインと同じ形で揃える。
 * 窓口の認可は token の署名・session の生存・DB の ACL・aal を本物のまま確かめる（差し替えない）。
 *
 * 店舗の行は E2E-STK-<uuid> の名前で pg から作り、終わりに必ず消す。管理者・サポーターの権限の試験は、権限の設定を変える
 * 他の試験（FR-ADMIN-109・123）と同時に流れないよう withPermissionScenario（advisory lock 190520）の中で流す。
 * 回数の制限（送り元 x-real-ip・操作者）は試験ごとに別の送り元・別の利用者で数える。送り元は E2E の固定の環境の CLIENT_IP_HEADER=x-real-ip
 * で信頼される見出し（x-forwarded-for は読まれない。SEC-AUTH-013）。窓は floor(now/600s) の固定なので、
 * 数え始めと数え終わりで窓が変わったら、その結果は捨てて別の送り元でやり直す（Playwright の retry ではなく、窓の境の見張り）。
 *
 * 送り元の枠は認可の前（SEC-STOCKIST-020）、認可で断った要求のうち操作者が分かる物は監査に残し、token の無い 401 は残さない（SEC-STOCKIST-021）。
 * JWT・Cookie が通信記録に残らないよう trace は切る。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { expect, test, type APIRequestContext, type PlaywrightWorkerArgs } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { DUMMY_CAPTCHA_TOKEN } from './captcha-test-utils';
import { withLocalDb } from './order-email-test-utils';
import { withPermissionScenario } from './permission-settings-test-utils';

test.use({ trace: 'off' });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const APP_ORIGIN = 'http://localhost:3000';
const FOREIGN_ORIGIN = 'https://evil.example';
const LIST_PATH = '/api/admin/stockists';
const READ_PERMISSION = 'admin.stockists.read';
const MANAGE_PERMISSION = 'admin.stockists.manage';
const WINDOW_MS = 600 * 1000;
const TEST_TIMEOUT_MS = 120_000;

type Aal = 'aal1' | 'aal2';
type ActorKind = 'admin' | 'supporter' | 'readonly' | 'member';
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

type Actor = { userId: string; accessToken: string; refreshToken: string; csrfToken: string };
type StockistRow = { id: number; name: string; address: string; phone: string };
type Scenario = { db: PgClient; prefix: string; cleanups: Array<() => Promise<void>> };
type Call = { label: string; method: Method; path: string; data?: unknown };
type Reply = { status: number; headers: Record<string, string>; text: string; json: Record<string, unknown> | null };

const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

function requireLocalEnv(): void {
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY || !isLocalUrl(SUPABASE_URL)) {
    throw new Error('手元の Supabase の公開値と service role の鍵が env に無い（この試験は手元の Supabase だけで流す）');
  }
}

function requireBaseUrl(baseURL: string | undefined): string {
  if (!baseURL) throw new Error('baseURL が無い（playwright.config.ts）');
  return baseURL;
}

/** 試験ごとに別の送り元（x-real-ip）。回数の枠を試験どうしで共有しない */
function uniqueForwardedFor(): string {
  const bytes = randomBytes(3);
  return `10.${bytes[0]}.${bytes[1]}.${bytes[2]}`;
}

/** 回数の制限の窓（floor(now/600s)）の番号 */
const windowIndex = (): number => Math.floor(Date.now() / WINDOW_MS);

/**
 * 数え始めから数え終わりまでが同じ 600 秒の窓に収まった結果だけを返す。境をまたいだら捨てて、別の送り元でやり直す。
 * attempt は検証をせず、集めた結果だけを返すこと（境をまたいだ結果で先に落とさないため）。
 */
async function inOneWindow<T>(attempt: (forwardedFor: string) => Promise<T>): Promise<T> {
  for (let tries = 0; tries < 3; tries += 1) {
    const startedIn = windowIndex();
    const result = await attempt(uniqueForwardedFor());
    if (windowIndex() === startedIn) return result;
  }
  throw new Error('回数の制限の窓（600秒）の境を3回続けてまたいだ。時間を置いて流し直す');
}

/** 場面: 手元の DB の接続1本・店舗の名前の印・片づけの一覧 */
async function withScenario(options: { permissionLock: boolean }, run: (scenario: Scenario) => Promise<void>): Promise<void> {
  requireLocalEnv();
  const body = async (db: PgClient): Promise<void> => {
    const scenario: Scenario = { db, prefix: `E2E-STK-${randomUUID()}`, cleanups: [] };
    scenario.cleanups.push(async () => {
      await db.query('delete from public.stockists where name like $1', [`${scenario.prefix}%`]);
    });
    let failure: unknown = null;
    try {
      await run(scenario);
    } catch (error) {
      failure = error;
    }
    let cleanupFailure: unknown = null;
    for (const cleanup of [...scenario.cleanups].reverse()) {
      try {
        await cleanup();
      } catch (error) {
        cleanupFailure ??= error;
      }
    }
    if (failure) throw failure;
    if (cleanupFailure) throw cleanupFailure;
  };
  if (options.permissionLock) {
    await withPermissionScenario(body);
  } else {
    await withLocalDb(body);
  }
}

function decodeClaims(accessToken: string): { aal?: string; session_id?: string } {
  return JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8'));
}

/** 本物の GoTrue のログインで得た token の利用者を作る。片づけ（利用者・試験用の役割）は場面に登録する */
async function createActor(scenario: Scenario, kind: ActorKind, aal: Aal): Promise<Actor> {
  const authOptions = { auth: { persistSession: false, autoRefreshToken: false } };
  const email = `e2e-stk014-${kind}-${randomBytes(6).toString('hex')}@example.com`;
  const password = `E2e-${randomBytes(12).toString('hex')}!`;
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, authOptions);
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    ...(kind === 'admin' || kind === 'supporter' ? { app_metadata: { role: kind } } : {}),
  });
  if (created.error || !created.data.user) {
    throw new Error(`手元の利用者を作れない（status: ${created.error?.status ?? '不明'}）`);
  }
  const userId = created.data.user.id;
  scenario.cleanups.push(async () => {
    // public.sessions と public.user_roles は利用者の削除で連鎖して消える
    const removed = await admin.auth.admin.deleteUser(userId);
    if (removed.error) throw new Error(`手元の利用者を消せない（status: ${removed.error.status ?? '不明'}）`);
  });

  if (kind === 'admin' || kind === 'supporter') {
    const assigned = await scenario.db.query(
      `insert into public.user_roles (user_id, role_id, active, expires_at)
       select $1::uuid, r.id, true, null from public.roles r where r.code = $2`,
      [userId, kind],
    );
    if (assigned.rowCount !== 1) throw new Error(`役割 ${kind} の行が手元の DB に無い`);
  } else if (kind === 'readonly') {
    const role = await scenario.db.query(
      'insert into public.roles (code, name) values ($1, $2) returning id',
      [`e2e-stk014-ro-${randomBytes(6).toString('hex')}`, 'E2E STOCKIST read only'],
    );
    const roleId: number = role.rows[0].id;
    scenario.cleanups.push(async () => {
      await scenario.db.query('delete from public.user_roles where role_id = $1', [roleId]);
      await scenario.db.query('delete from public.role_permissions where role_id = $1', [roleId]);
      await scenario.db.query('delete from public.roles where id = $1', [roleId]);
    });
    const granted = await scenario.db.query(
      `insert into public.role_permissions (role_id, permission_id)
       select $1, p.id from public.permissions p where p.code = $2`,
      [roleId, READ_PERMISSION],
    );
    if (granted.rowCount !== 1) throw new Error(`権限 ${READ_PERMISSION} の行が手元の DB に無い`);
    await scenario.db.query(
      'insert into public.user_roles (user_id, role_id, active, expires_at) values ($1::uuid, $2, true, null)',
      [userId, roleId],
    );
  }

  const gotrue = createClient(SUPABASE_URL, ANON_KEY, authOptions);
  const signedIn = await gotrue.auth.signInWithPassword({ email, password, options: { captchaToken: DUMMY_CAPTCHA_TOKEN } });
  if (signedIn.error || !signedIn.data.session) {
    throw new Error(`手元の利用者でログインできない（status: ${signedIn.error?.status ?? '不明'}）`);
  }
  let session = signedIn.data.session;
  if (aal === 'aal2') {
    const sessionId = decodeClaims(session.access_token).session_id;
    if (!sessionId) throw new Error('access token に session_id が無い');
    await scenario.db.query(`update auth.sessions set aal = 'aal2' where id = $1::uuid`, [sessionId]);
    await scenario.db.query(
      `insert into auth.mfa_amr_claims (session_id, created_at, updated_at, authentication_method, id)
       values ($1::uuid, now(), now(), 'totp', gen_random_uuid())`,
      [sessionId],
    );
    const refreshed = await gotrue.auth.refreshSession({ refresh_token: session.refresh_token });
    if (refreshed.error || !refreshed.data.session) {
      throw new Error(`aal2 の token を発行させられない（status: ${refreshed.error?.status ?? '不明'}）`);
    }
    session = refreshed.data.session;
  }
  const authSessionId = decodeClaims(session.access_token).session_id;
  if (!authSessionId) throw new Error('access token に session_id が無い');
  const issuedAal = decodeClaims(session.access_token).aal;
  if (issuedAal !== aal) throw new Error(`token の aal が ${aal} でない（${issuedAal ?? '不明'}）`);

  // アプリの Cookie の session。refresh token と CSRF token は、それぞれの sha256 を行に持つ（requireCsrfOrDeny が突き合わせる）
  const refreshToken = randomBytes(32).toString('hex');
  const csrfToken = randomBytes(32).toString('hex');
  await scenario.db.query(
    `insert into public.sessions (user_id, refresh_token_hash, csrf_token_hash, auth_session_id, expires_at)
     values ($1::uuid, $2, $3, $4::uuid, now() + interval '1 hour')`,
    [userId, sha256Hex(refreshToken), sha256Hex(csrfToken), authSessionId],
  );
  return { userId, accessToken: session.access_token, refreshToken, csrfToken };
}

async function insertStockist(scenario: Scenario, label: string, status: 'private' | 'published'): Promise<StockistRow> {
  const row = {
    name: `${scenario.prefix}-${label}`,
    address: `東京都E2E区${randomBytes(2).toString('hex')}`,
    phone: '03-0000-0000',
  };
  const inserted = await scenario.db.query(
    `insert into public.stockists (type, name, address, phone, time, holiday, status)
     values ('STORE', $1, $2, $3, '10:00-19:00', '水曜', $4) returning id`,
    [row.name, row.address, row.phone, status],
  );
  return { id: Number(inserted.rows[0].id), ...row };
}

/** この試験の店舗の行を、id 順に全部読む（件数・中身・updated_at まで比べて「行が変わらない」を確かめる） */
async function snapshotRows(scenario: Scenario): Promise<unknown[]> {
  const result = await scenario.db.query(
    `select id, name, address, phone, time, holiday, status, updated_at
       from public.stockists where name like $1 order by id`,
    [`${scenario.prefix}%`],
  );
  return result.rows;
}

async function readStatus(scenario: Scenario, id: number): Promise<string> {
  const result = await scenario.db.query('select status from public.stockists where id = $1', [id]);
  return result.rows[0].status;
}

/** 管理の窓口の6つの呼び出し（GET 一覧・POST・GET 1件・PUT・PATCH・DELETE）。変更の本文は通れば行が変わる中身にする */
function sixCalls(scenario: Scenario, row: StockistRow): Call[] {
  const one = `${LIST_PATH}/${row.id}`;
  const changing = {
    name: `${scenario.prefix}-attempt`,
    address: '東京都変更後',
    phone: '03-9999-9999',
    time: '00:00-01:00',
    holiday: '無休',
    status: 'published',
  };
  return [
    { label: 'GET 一覧', method: 'GET', path: LIST_PATH },
    { label: 'POST 作成', method: 'POST', path: LIST_PATH, data: changing },
    { label: 'GET 1件', method: 'GET', path: one },
    { label: 'PUT 更新', method: 'PUT', path: one, data: changing },
    { label: 'PATCH 公開状態', method: 'PATCH', path: one, data: { status: 'published' } },
    { label: 'DELETE 削除', method: 'DELETE', path: one },
  ];
}

const requiredPermission = (call: Call): string => (call.method === 'GET' ? READ_PERMISSION : MANAGE_PERMISSION);

/** 利用者の Cookie（あれば）と送り元の見出しを持つ request context */
async function openApi(
  playwright: PlaywrightWorkerArgs['playwright'],
  baseURL: string | undefined,
  forwardedFor: string,
  actor: Actor | null,
): Promise<APIRequestContext> {
  const cookie = (name: string, value: string) => ({
    name,
    value,
    domain: 'localhost',
    path: '/',
    expires: -1,
    httpOnly: true,
    secure: false,
    sameSite: 'Lax' as const,
  });
  return playwright.request.newContext({
    baseURL: requireBaseUrl(baseURL),
    extraHTTPHeaders: { 'x-real-ip': forwardedFor },
    storageState: {
      cookies: actor ? [cookie('sb-access-token', actor.accessToken), cookie('sb-refresh-token', actor.refreshToken)] : [],
      origins: [],
    },
  });
}

/**
 * 1回呼ぶ。変更の要求（POST・PUT・PATCH・DELETE）は、origin を渡さなければ許可のオリジンを付ける（付けないと proxy が窓口より前に
 * 403 Forbidden origin を返す）。null なら付けない。csrf を渡せば x-csrf-token を付ける。
 */
async function send(
  api: APIRequestContext,
  call: Call,
  options: { origin?: string | null; csrf?: string | null } = {},
): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (call.method !== 'GET') {
    const origin = options.origin === undefined ? APP_ORIGIN : options.origin;
    if (origin !== null) headers.origin = origin;
    if (options.csrf) headers['x-csrf-token'] = options.csrf;
  }
  const response = await api.fetch(call.path, {
    method: call.method,
    headers,
    ...(call.data === undefined ? {} : { data: call.data }),
    failOnStatusCode: false,
    maxRedirects: 0,
  });
  const text = await response.text();
  let json: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    json = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    json = null;
  }
  return { status: response.status(), headers: response.headers(), text, json };
}

test('SEC-STOCKIST-006-AC-01 未ログインの要求は、管理の取扱店の6つの窓口のどれも 401 になり、店舗の中身が応答に出ない', async ({ playwright, baseURL }) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  await withScenario({ permissionLock: false }, async (scenario) => {
    const row = await insertStockist(scenario, 'target', 'private');
    const before = await snapshotRows(scenario);
    const api = await openApi(playwright, baseURL, uniqueForwardedFor(), null);
    try {
      for (const call of sixCalls(scenario, row)) {
        // 変更の要求は許可のオリジンを付ける（付けないと proxy が窓口より前に 403 を返し、認可まで届かない）
        const reply = await send(api, call);
        expect(reply.status, `${call.label} は 401`).toBe(401);
        expect(reply.json, `${call.label} の本文`).toEqual({ error: 'Unauthorized' });
        for (const content of [row.name, row.address, row.phone]) {
          expect(reply.text, `${call.label} の応答に店舗の中身が出ない`).not.toContain(content);
        }
      }
    } finally {
      await api.dispose();
    }
    expect(await snapshotRows(scenario)).toEqual(before);
  });
});

test('SEC-STOCKIST-006-AC-02 取扱店の権限を持たないサポーターの aal2 の利用者は、6つの窓口のどれも 403 になり、店舗の行が変わらない', async ({ playwright, baseURL }) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  await withScenario({ permissionLock: true }, async (scenario) => {
    const row = await insertStockist(scenario, 'target', 'private');
    const before = await snapshotRows(scenario);
    const supporter = await createActor(scenario, 'supporter', 'aal2');
    const api = await openApi(playwright, baseURL, uniqueForwardedFor(), supporter);
    try {
      for (const call of sixCalls(scenario, row)) {
        const reply = await send(api, call, { csrf: supporter.csrfToken });
        expect(reply.status, `${call.label} は 403`).toBe(403);
        // 権限が足りない 403 であって、MFA の 403 ではない
        expect(reply.json, `${call.label} の本文`).toMatchObject({ error: 'Forbidden', permission: requiredPermission(call), role: 'supporter' });
        expect(reply.json?.reason, `${call.label} は MFA の拒否ではない`).toBeUndefined();
        expect(reply.text, `${call.label} の応答に店舗の中身が出ない`).not.toContain(row.name);
      }
    } finally {
      await api.dispose();
    }
    expect(await snapshotRows(scenario)).toEqual(before);
  });
});

test('SEC-STOCKIST-006-AC-03 店長の役割で aal1 の session の利用者は、6つの窓口のどれも 403（MFA required）になり、店舗の行が変わらない', async ({ playwright, baseURL }) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  await withScenario({ permissionLock: true }, async (scenario) => {
    const row = await insertStockist(scenario, 'target', 'private');
    const before = await snapshotRows(scenario);
    const manager = await createActor(scenario, 'admin', 'aal1');
    const api = await openApi(playwright, baseURL, uniqueForwardedFor(), manager);
    try {
      for (const call of sixCalls(scenario, row)) {
        const reply = await send(api, call, { csrf: manager.csrfToken });
        expect(reply.status, `${call.label} は 403`).toBe(403);
        expect(reply.json, `${call.label} の本文`).toMatchObject({
          error: 'Forbidden',
          reason: 'MFA required',
          permission: requiredPermission(call),
        });
        expect(reply.text, `${call.label} の応答に店舗の中身が出ない`).not.toContain(row.name);
      }
    } finally {
      await api.dispose();
    }
    expect(await snapshotRows(scenario)).toEqual(before);
  });
});

test('SEC-STOCKIST-006-AC-04 admin.stockists.read だけを持つ役割の aal2 の利用者は、GET の2つが 200 になり、POST・PUT・PATCH・DELETE は 403 で店舗の行が変わらない', async ({ playwright, baseURL }) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  await withScenario({ permissionLock: false }, async (scenario) => {
    const row = await insertStockist(scenario, 'target', 'private');
    const before = await snapshotRows(scenario);
    const reader = await createActor(scenario, 'readonly', 'aal2');
    const api = await openApi(playwright, baseURL, uniqueForwardedFor(), reader);
    try {
      for (const call of sixCalls(scenario, row)) {
        const reply = await send(api, call, { csrf: reader.csrfToken });
        if (call.method === 'GET') {
          expect(reply.status, `${call.label} は 200`).toBe(200);
          const data = reply.json?.data;
          if (call.path === LIST_PATH) {
            expect(Array.isArray(data), `${call.label} の data は配列`).toBe(true);
            expect((data as Array<{ id: number }>).map((stockist) => stockist.id), `${call.label} に試験の行が入る`).toContain(row.id);
          } else {
            expect(data, `${call.label} の data`).toMatchObject({ id: row.id, name: row.name });
          }
        } else {
          expect(reply.status, `${call.label} は 403`).toBe(403);
          expect(reply.json, `${call.label} の本文`).toMatchObject({ error: 'Forbidden', permission: MANAGE_PERMISSION });
          expect(reply.json?.reason, `${call.label} は MFA の拒否ではない`).toBeUndefined();
        }
      }
    } finally {
      await api.dispose();
    }
    expect(await snapshotRows(scenario)).toEqual(before);
  });
});

test('SEC-STOCKIST-004-AC-01 aal2 の管理者の Cookie でも、別のオリジンからの POST・PUT・PATCH・DELETE は 403 になり、店舗の行が変わらない', async ({ playwright, baseURL }) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  await withScenario({ permissionLock: true }, async (scenario) => {
    const row = await insertStockist(scenario, 'target', 'private');
    const before = await snapshotRows(scenario);
    const manager = await createActor(scenario, 'admin', 'aal2');
    const api = await openApi(playwright, baseURL, uniqueForwardedFor(), manager);
    try {
      const mutations = sixCalls(scenario, row).filter((call) => call.method !== 'GET');
      expect(mutations.map((call) => call.method)).toEqual(['POST', 'PUT', 'PATCH', 'DELETE']);
      for (const call of mutations) {
        // CSRF の token は正しい値を付け、断られる理由を Origin だけにする
        const reply = await send(api, call, { origin: FOREIGN_ORIGIN, csrf: manager.csrfToken });
        expect(reply.status, `${call.label} は 403`).toBe(403);
        expect(reply.json, `${call.label} の本文`).toEqual({ error: 'Forbidden origin' });
      }
    } finally {
      await api.dispose();
    }
    expect(await snapshotRows(scenario)).toEqual(before);
  });
});

test('SEC-STOCKIST-004-AC-02 正しい Origin でも、x-csrf-token が無い・違う PATCH は 403 になり、店舗の公開状態が変わらない', async ({ playwright, baseURL }) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  await withScenario({ permissionLock: true }, async (scenario) => {
    const row = await insertStockist(scenario, 'target', 'private');
    const before = await snapshotRows(scenario);
    const manager = await createActor(scenario, 'admin', 'aal2');
    const api = await openApi(playwright, baseURL, uniqueForwardedFor(), manager);
    const patch: Call = { label: 'PATCH 公開状態', method: 'PATCH', path: `${LIST_PATH}/${row.id}`, data: { status: 'published' } };
    try {
      const missing = await send(api, patch, { origin: APP_ORIGIN, csrf: null });
      expect(missing.status, 'token が無い PATCH は 403').toBe(403);
      expect(missing.json).toEqual({ error: 'Forbidden', reason: 'CSRF validation failed' });

      const wrong = await send(api, patch, { origin: APP_ORIGIN, csrf: randomBytes(32).toString('hex') });
      expect(wrong.status, 'token が違う PATCH は 403').toBe(403);
      expect(wrong.json).toEqual({ error: 'Forbidden', reason: 'CSRF validation failed' });

      expect(await readStatus(scenario, row.id), '店舗の公開状態が変わらない').toBe('private');
      expect(await snapshotRows(scenario)).toEqual(before);

      // 対照: 正しい token の同じ PATCH は通る（上の403が session の不備でなく、token の確かめによることの確かめ）
      const valid = await send(api, patch, { origin: APP_ORIGIN, csrf: manager.csrfToken });
      expect(valid.status, '正しい token の PATCH は 200').toBe(200);
      expect(await readStatus(scenario, row.id)).toBe('published');
    } finally {
      await api.dispose();
    }
  });
});

test('SEC-STOCKIST-005-AC-01 別のオリジンの PATCH を21回続けて送っても、そのあとの正しい Origin と token の PATCH は 200 になり 429 にならない', async ({ playwright, baseURL }) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  await withScenario({ permissionLock: true }, async (scenario) => {
    const row = await insertStockist(scenario, 'target', 'private');
    const manager = await createActor(scenario, 'admin', 'aal2');
    const patch: Call = { label: 'PATCH 公開状態', method: 'PATCH', path: `${LIST_PATH}/${row.id}`, data: { status: 'published' } };

    const outcome = await inOneWindow(async (forwardedFor) => {
      await scenario.db.query(`update public.stockists set status = 'private' where id = $1`, [row.id]);
      const api = await openApi(playwright, baseURL, forwardedFor, manager);
      try {
        const foreign: Reply[] = [];
        for (let count = 0; count < 21; count += 1) {
          foreign.push(await send(api, patch, { origin: FOREIGN_ORIGIN, csrf: manager.csrfToken }));
        }
        const last = await send(api, patch, { origin: APP_ORIGIN, csrf: manager.csrfToken });
        return { foreign, last };
      } finally {
        await api.dispose();
      }
    });

    expect(outcome.foreign).toHaveLength(21);
    for (const [index, reply] of outcome.foreign.entries()) {
      expect(reply.status, `別のオリジンの ${index + 1} 回目は 403`).toBe(403);
      expect(reply.json).toEqual({ error: 'Forbidden origin' });
    }
    expect(outcome.last.status, '最後の正しい PATCH は 200（429 にならない）').toBe(200);
    expect(outcome.last.json).toMatchObject({ success: true });
    expect(await readStatus(scenario, row.id)).toBe('published');
  });
});

test('SEC-STOCKIST-020-AC-01 取扱店の権限を持たない一般会員の token で、同じ600秒の窓の中で GET を121回送ると、121回目が 403 でなく 429 になり Retry-After が付く', async ({ playwright, baseURL }) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  await withScenario({ permissionLock: false }, async (scenario) => {
    const member = await createActor(scenario, 'member', 'aal1');

    const replies = await inOneWindow(async (forwardedFor) => {
      const api = await openApi(playwright, baseURL, forwardedFor, member);
      try {
        const collected: Reply[] = [];
        // 窓の中の順番が AC の主題なので、並べて1つずつ送る
        for (let count = 0; count < 121; count += 1) {
          collected.push(await send(api, { label: 'GET 一覧', method: 'GET', path: LIST_PATH }));
        }
        return collected;
      } finally {
        await api.dispose();
      }
    });

    expect(replies).toHaveLength(121);
    // 権限の無い token なので、枠の中の120回は 403（認可で断られる）
    expect(replies.slice(0, 120).map((reply) => reply.status)).toEqual(Array.from({ length: 120 }, () => 403));
    const last = replies[120];
    expect(last.status, '121回目の GET は 403 でなく 429').toBe(429);
    expect(last.headers['retry-after'], 'Retry-After の見出しが付く').toBeDefined();
    expect(Number(last.headers['retry-after']), 'Retry-After は秒数').toBeGreaterThan(0);
  });
});

test('SEC-STOCKIST-021-AC-01 サポーターの aal2 の利用者の PATCH /api/admin/stockists/<id> は 403 になり、audit_logs にその利用者の id・権限 admin.stockists.manage・失敗の結果を持つ行が1つ増える', async ({ playwright, baseURL }) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  await withScenario({ permissionLock: true }, async (scenario) => {
    const row = await insertStockist(scenario, 'target', 'private');
    const supporter = await createActor(scenario, 'supporter', 'aal2');
    const api = await openApi(playwright, baseURL, uniqueForwardedFor(), supporter);
    try {
      const reply = await send(
        api,
        { label: 'PATCH 公開状態', method: 'PATCH', path: `${LIST_PATH}/${row.id}`, data: { status: 'published' } },
        { csrf: supporter.csrfToken },
      );
      expect(reply.status, '権限の無い PATCH は 403').toBe(403);
    } finally {
      await api.dispose();
    }

    // 利用者は試験のために作った新しい人で、ほかの操作は無いので、その id の行がそのまま「増えた行」になる
    await expect
      .poll(
        async () => {
          const counted = await scenario.db.query('select count(*)::int as n from public.audit_logs where actor_id = $1::uuid', [supporter.userId]);
          return counted.rows[0].n as number;
        },
        { message: '認可で断った要求の監査の行が1つ増える', timeout: 10_000 },
      )
      .toBe(1);
    const logged = await scenario.db.query(
      'select actor_id, action, resource, resource_id, outcome, detail, metadata from public.audit_logs where actor_id = $1::uuid',
      [supporter.userId],
    );
    const entry = logged.rows[0];
    expect(entry.actor_id, '利用者の id').toBe(supporter.userId);
    expect(entry.outcome, '失敗の結果').toBe('failure');
    const recorded = [entry.action, entry.resource, entry.resource_id, entry.detail, JSON.stringify(entry.metadata ?? null)].join('\n');
    expect(recorded, '要求した権限').toContain(MANAGE_PERMISSION);
  });
});

test('SEC-STOCKIST-021-AC-02 token を付けない PATCH /api/admin/stockists/<id> は 401 になり、その送り元の audit_logs（resource が stockists）の行が増えない', async ({ playwright, baseURL }) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  await withScenario({ permissionLock: true }, async (scenario) => {
    const row = await insertStockist(scenario, 'target', 'private');
    const sourceIp = uniqueForwardedFor();
    const countRows = async (): Promise<number> => {
      // 並列の実行では audit_logs 全体の件数が揺れるので全体は数えず、この試験の固定の送り元で絞る
      const counted = await scenario.db.query(
        "select count(*)::int as n from public.audit_logs where ip = $1 and resource = 'stockists'",
        [sourceIp],
      );
      return counted.rows[0].n as number;
    };

    const anonymous = await openApi(playwright, baseURL, sourceIp, null);
    try {
      const reply = await send(anonymous, { label: 'PATCH 公開状態', method: 'PATCH', path: `${LIST_PATH}/${row.id}`, data: { status: 'published' } });
      expect(reply.status, 'token の無い PATCH は 401').toBe(401);
    } finally {
      await anonymous.dispose();
    }
    expect(await countRows(), 'token の無い 401 では監査の行が増えない').toBe(0);

    // 数える検索が空振りでないことの対照: 同じ送り元で操作者が分かる 403 を 1 回送ると、行が 1 つに増える
    const supporter = await createActor(scenario, 'supporter', 'aal2');
    const known = await openApi(playwright, baseURL, sourceIp, supporter);
    try {
      const reply = await send(
        known,
        { label: 'PATCH 公開状態', method: 'PATCH', path: `${LIST_PATH}/${row.id}`, data: { status: 'published' } },
        { csrf: supporter.csrfToken },
      );
      expect(reply.status, '権限の無い PATCH は 403').toBe(403);
    } finally {
      await known.dispose();
    }
    await expect.poll(countRows, { message: '操作者が分かる 403 では行が 1 つ増える', timeout: 10_000 }).toBe(1);
  });
});

test('SEC-STOCKIST-021-AC-03 取扱店の権限を持たない同じ利用者の GET を25回送ると、拒否の監査は20行（失敗）とまとめの1行（denied_burst）で止まる', async ({ playwright, baseURL }) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  await withScenario({ permissionLock: false }, async (scenario) => {
    // 数えの窓（600 秒）の境をまたぐと数えが 0 に戻るので、同じ窓に収まった結果だけを使い、境をまたいだら新しい利用者でやり直す
    const outcome = await inOneWindow(async (forwardedFor) => {
      const member = await createActor(scenario, 'member', 'aal1');
      const api = await openApi(playwright, baseURL, forwardedFor, member);
      try {
        const statuses: number[] = [];
        for (let count = 0; count < 25; count += 1) {
          statuses.push((await send(api, { label: 'GET 一覧', method: 'GET', path: LIST_PATH })).status);
        }
        return { userId: member.userId, statuses };
      } finally {
        await api.dispose();
      }
    });

    expect(outcome.statuses, '権限の無い GET は全部 403').toEqual(Array.from({ length: 25 }, () => 403));
    const grouped = await scenario.db.query(
      'select outcome, count(*)::int as n from public.audit_logs where actor_id = $1::uuid group by outcome',
      [outcome.userId],
    );
    const byOutcome = Object.fromEntries(grouped.rows.map((entry: { outcome: string; n: number }) => [entry.outcome, entry.n]));
    expect(byOutcome, '失敗 20 行 + まとめ 1 行だけ').toEqual({ failure: 20, denied_burst: 1 });
  });
});

test('SEC-STOCKIST-019-AC-03 GET /api/admin/stockists/access は、店長の aal2 に 204、サポーターの aal2 に 403、未ログインに 401 を返し、どれも Cache-Control に no-store が含まれる', async ({ playwright, baseURL }) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  await withScenario({ permissionLock: true }, async (scenario) => {
    const manager = await createActor(scenario, 'admin', 'aal2');
    const supporter = await createActor(scenario, 'supporter', 'aal2');
    const access = { label: 'GET 作成の頁の入口', method: 'GET' as const, path: `${LIST_PATH}/access` };

    const anonymousApi = await openApi(playwright, baseURL, uniqueForwardedFor(), null);
    const managerApi = await openApi(playwright, baseURL, uniqueForwardedFor(), manager);
    const supporterApi = await openApi(playwright, baseURL, uniqueForwardedFor(), supporter);
    try {
      const allowed = await send(managerApi, access);
      expect(allowed.status, '店長は 204').toBe(204);
      expect(allowed.text, '204 に本文は無い').toBe('');
      expect(allowed.headers['cache-control'] ?? '', '204 の Cache-Control').toContain('no-store');

      const denied = await send(supporterApi, access);
      expect(denied.status, 'サポーターは 403').toBe(403);
      expect(denied.json, '権限の足りない 403').toMatchObject({ error: 'Forbidden', permission: MANAGE_PERMISSION });
      expect(denied.headers['cache-control'] ?? '', '403 の Cache-Control').toContain('no-store');

      const anonymous = await send(anonymousApi, access);
      expect(anonymous.status, '未ログインは 401').toBe(401);
      expect(anonymous.headers['cache-control'] ?? '', '401 の Cache-Control').toContain('no-store');
    } finally {
      await anonymousApi.dispose();
      await managerApi.dispose();
      await supporterApi.dispose();
    }
  });
});
