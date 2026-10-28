/**
 * FR-ADMIN-MISC-003 強制失効と MFA のリセットの守り（監査ログの水増し・平文・IP、役割の決め方、session の失効）
 * 対応: SEC-ADMIN-007-AC-01 / SEC-ADMIN-008-AC-01 / SEC-ADMIN-009-AC-01 / SEC-ADMIN-014-AC-01 / SEC-ADMIN-014-AC-02 /
 *       SEC-ADMIN-015-AC-01 / SEC-ADMIN-015-AC-02 / SEC-ADMIN-016-AC-01
 *
 * 本物の窓口（POST /api/admin/revoke-user-sessions・POST /api/admin/users/mfa/reset）を、本物の JWT で HTTP から叩く。
 * - 管理者: 共有の道具（e2e/admin-session-test-utils.ts）で作る。GoTrue が署名した本物の aal2 の JWT を出す。
 *   サポーター側の aal2 は、本物のログインの session に amr の行（手元の Supabase は TOTP の登録・確認が使えないため DB へ直に足す）を足して
 *   refresh して作る。役割は auth.users の app_metadata と public.user_roles（有効な割り当て）を同じ役割にそろえる。
 * - 画面を描かない HTTP の試験なので、viewport の繰り返しは無い（1本ずつ）。
 * - 対象のサポーター: createTestMember で作り、loginAsMember（確認コードの本物のログイン）で auth.sessions と public.sessions の行を作る。
 *   2要素の登録は auth.mfa_factors に verified の行を直に足す（GoTrue の管理 API が一覧・削除できる形）。
 * - 監査ログ（public.audit_logs）は手元の DB の接続で直に読む。
 * JWT が通信記録に残らないよう trace は切る。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Browser, type Page } from '@playwright/test';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { createAdminSessionActor } from './admin-session-test-utils';
import { createTestMember, loginAsMember, type TestMember } from './member-session-helpers';
import { withLocalDb } from './order-email-test-utils';
import { withPermissionScenario } from './permission-settings-test-utils';

test.use({ trace: 'off' });
test.describe.configure({ timeout: 180_000 });

const REVOKE_ROUTE = '/api/admin/revoke-user-sessions';
const MFA_RESET_ROUTE = '/api/admin/users/mfa/reset';
/** 管理者として要求が通ったかを見る窓口。admin.permissions.manage は管理者に固定で付く（権限の設定の試験に左右されない） */
const ADMIN_PROBE_ROUTE = '/api/admin/permissions';
/** サポーターとして要求が通ったかを見る窓口。admin.users.read はサポーターの最初の権限に入る */
const SUPPORTER_PROBE_ROUTE = '/api/admin/users';

/**
 * SEC-ADMIN-007 の「決めた上限」（ADR-0460）。認可に失敗した要求の監査は、全体で10分に20行まで。
 * 21回目はまとめの1行（outcome が unauthorized_burst）なので、outcome が unauthorized の行は20以下で数える。
 * 10分の窓の境目をまたぐと数え直すので、要求の途中で窓が変わると最大で倍になりうる（揺れたら窓の頭まで待つ）。
 */
const UNAUTHORIZED_AUDIT_ROW_LIMIT = 20;
const UNAUTHORIZED_REQUEST_COUNT = UNAUTHORIZED_AUDIT_ROW_LIMIT + 30;

const SPOOFED_IP = '203.0.113.7';

type AdminActor = { userId: string; email: string; accessToken: string };

function claimsOf(jwt: string): { sub?: string; session_id?: string; aal?: string } {
  return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')) as { sub?: string; session_id?: string; aal?: string };
}

/** 確認コードと refresh の回数の制限を、試験ごとに別の送り元で数えるための値（手元の E2E サーバーだけで効く） */
function uniqueSourceIp(): string {
  const bytes = randomBytes(2);
  return `198.18.${bytes[0]}.${(bytes[1] % 253) + 1}`;
}

/** auth.users の役割（app_metadata）と public.user_roles の割り当てを同じ役割にそろえる。active=false なら「役割を外した人」 */
async function assignRole(db: PgClient, userId: string, role: 'admin' | 'supporter', active: boolean): Promise<void> {
  await db.query(
    `update auth.users
        set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('role', $2::text)
      where id = $1::uuid`,
    [userId, role],
  );
  const assigned = await db.query(
    `insert into public.user_roles (user_id, role_id, active, expires_at)
     select $1::uuid, r.id, $3::boolean, null from public.roles r where r.code = $2
     on conflict (user_id, role_id) do update set active = excluded.active, expires_at = null`,
    [userId, role, active],
  );
  if (assigned.rowCount !== 1) throw new Error(`役割 ${role} の行が手元の DB に無い`);
}

/** その session が totp で確かめ済みだという印（GoTrue は次の refresh で aal2 の JWT を出す） */
async function addTotpAmrClaim(db: PgClient, sessionId: string): Promise<void> {
  await db.query(
    `insert into auth.mfa_amr_claims (id, session_id, created_at, updated_at, authentication_method)
     values (gen_random_uuid(), $1::uuid, now(), now(), 'totp')`,
    [sessionId],
  );
}

/** 2要素の登録（verified の totp）を1つ足す。GoTrue の管理 API の一覧と削除が扱う行 */
async function addTotpFactor(db: PgClient, userId: string): Promise<string> {
  const factor = await db.query(
    `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
     values (gen_random_uuid(), $1::uuid, $2, 'totp', 'verified', now(), now(), 'JBSWY3DPEHPK3PXP')
     returning id::text as id`,
    [userId, `e2e-${randomBytes(4).toString('hex')}`],
  );
  return factor.rows[0].id as string;
}

async function factorCount(db: PgClient, userId: string): Promise<number> {
  const result = await db.query('select count(*)::int as n from auth.mfa_factors where user_id = $1::uuid', [userId]);
  return result.rows[0].n as number;
}

/** aal2 の管理者を作る（共有の道具。GoTrue が署名した本物の aal2 の JWT を出す） */
async function createAal2Admin(): Promise<AdminActor> {
  const actor = await withLocalDb((db) => createAdminSessionActor(db, 'admin', 'aal2'));
  return { userId: actor.userId, email: actor.email, accessToken: actor.accessToken };
}

// 管理者は worker ごとに1回だけ作る（パスワードのログインの回数の制限を使い切らない）。
// 自分自身を失効させる試験（SEC-ADMIN-015-AC-01）だけは専用の管理者を作り、共有の管理者の session を巻き込まない。
let sharedAdminPromise: Promise<AdminActor> | null = null;
function sharedAdmin(): Promise<AdminActor> {
  sharedAdminPromise ??= createAal2Admin();
  return sharedAdminPromise;
}

function bearerHeaders(accessToken: string, origin: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}`, origin, ...extra };
}

function originOf(baseURL: string | undefined): string {
  if (!baseURL) throw new Error('baseURL が無い（playwright.config.ts）');
  return new URL(baseURL).origin;
}

function revoke(request: APIRequestContext, origin: string, accessToken: string | null, body: unknown, extra: Record<string, string> = {}): Promise<APIResponse> {
  return request.post(REVOKE_ROUTE, {
    headers: accessToken ? bearerHeaders(accessToken, origin, extra) : { origin, ...extra },
    data: body,
    failOnStatusCode: false,
    maxRedirects: 0,
  });
}

function resetMfa(request: APIRequestContext, origin: string, accessToken: string, userId: string, reason: string): Promise<APIResponse> {
  return request.post(MFA_RESET_ROUTE, {
    headers: bearerHeaders(accessToken, origin),
    data: { userId, reason, confirm: 'RESET_MFA' },
    failOnStatusCode: false,
    maxRedirects: 0,
  });
}

function probe(request: APIRequestContext, route: string, accessToken: string): Promise<APIResponse> {
  return request.get(route, { headers: { Authorization: `Bearer ${accessToken}` }, failOnStatusCode: false, maxRedirects: 0 });
}

async function accessTokenCookie(page: Page): Promise<string> {
  const origin = new URL(page.url()).origin;
  const cookie = (await page.context().cookies(origin)).find((c) => c.name === 'sb-access-token');
  if (!cookie?.value) throw new Error('sb-access-token の Cookie が無い（loginAsMember の後に呼ぶ）');
  return cookie.value;
}

/**
 * 本物のログイン済みの会員（サポーター）を aal2 の JWT にする。役割をそろえ、その session に amr の行を足し、アプリの refresh を通す。
 * 戻り値は aal2 の access token（Cookie にも同じ値が入る）。
 */
async function loginSupporterAsAal2(page: Page, db: PgClient, member: TestMember, forwardedFor: string): Promise<string> {
  await loginAsMember(page, member, forwardedFor);
  await assignRole(db, member.userId, 'supporter', true);
  const sessionId = claimsOf(await accessTokenCookie(page)).session_id;
  if (!sessionId) throw new Error('サポーターの JWT に session_id が無い');
  await addTotpAmrClaim(db, sessionId);
  const origin = new URL(page.url()).origin;
  const refreshed = await page.request.post(new URL('/api/auth/refresh', origin).toString(), {
    headers: { origin, 'x-real-ip': forwardedFor },
    maxRedirects: 0,
    failOnStatusCode: false,
  });
  if (!refreshed.ok()) throw new Error(`サポーターの session を更新できない: ${refreshed.status()}`);
  const accessToken = await accessTokenCookie(page);
  if (claimsOf(accessToken).aal !== 'aal2') {
    throw new Error('サポーターの JWT が aal2 にならない（手元の GoTrue が amr の行から aal を出す前提が崩れた）');
  }
  return accessToken;
}

async function auditRows(
  db: PgClient,
  sql: string,
  params: unknown[],
): Promise<
  Array<{
    action: string;
    outcome: string;
    actor_email: string | null;
    ip: string | null;
    user_agent: string | null;
    detail: string | null;
    metadata: unknown;
  }>
> {
  const result = await db.query(
    `select action, outcome, actor_email, ip, user_agent, detail, metadata from public.audit_logs ${sql}`,
    params,
  );
  return result.rows;
}

async function newMemberPage(browser: Browser, baseURL: string | undefined): Promise<Page> {
  const context = await browser.newContext({ baseURL });
  return context.newPage();
}

test.describe('FR-ADMIN-MISC-003 強制失効と MFA のリセットの守り', () => {
  // SEC-ADMIN-007-AC-01: 画面を描かない HTTP の試験なので viewport の繰り返しは無い。
  // 数える行は、この試験だけの user-agent の印で絞る（他の試験が足す unauthorized の行を数えない）。
  test('SEC-ADMIN-007-AC-01 JWT の無い強制失効の要求を繰り返しても監査ログが際限なく増えない', async ({ request, baseURL }) => {
    const origin = originOf(baseURL);
    const userAgent = `e2e-sec-admin-007-${randomUUID()}`;
    const unauthorizedRows = () =>
      withLocalDb(async (db) => {
        const result = await db.query(
          `select count(*)::int as n from public.audit_logs
            where action = 'admin_revoke_user_sessions' and outcome = 'unauthorized' and user_agent = $1`,
          [userAgent],
        );
        return result.rows[0].n as number;
      });

    const before = await unauthorizedRows();
    const statuses: number[] = [];
    for (let sent = 0; sent < UNAUTHORIZED_REQUEST_COUNT; sent += 10) {
      const batch = Math.min(10, UNAUTHORIZED_REQUEST_COUNT - sent);
      const responses = await Promise.all(
        Array.from({ length: batch }, () => revoke(request, origin, null, { user_id: randomUUID() }, { 'user-agent': userAgent })),
      );
      statuses.push(...responses.map((response) => response.status()));
    }
    // JWT が無いので、どの要求も通らない（401。回数の制限を足したなら 429 もありうる）
    expect(statuses.filter((status) => status !== 401 && status !== 429)).toEqual([]);
    expect(statuses).toHaveLength(UNAUTHORIZED_REQUEST_COUNT);

    // 上限より多く要求した後の、unauthorized の行の増えた数が上限以下
    const after = await unauthorizedRows();
    expect(after - before).toBeLessThanOrEqual(UNAUTHORIZED_AUDIT_ROW_LIMIT);
  });

  test(`SEC-ADMIN-008-AC-01 MFA のリセットの記録に対象のメールと理由の文が平文で出ない`, async ({ request, baseURL }) => {
    const origin = originOf(baseURL);
    const admin = await sharedAdmin();
    const target = await createTestMember('misc003-008');
    await withLocalDb(async (db) => {
      await assignRole(db, target.userId, 'supporter', true);
      await addTotpFactor(db, target.userId);
    });
    const reason = `e2e-reason-${randomUUID()}`;

    const response = await resetMfa(request, origin, admin.accessToken, target.userId, reason);
    expect(response.status()).toBe(200);

    const rows = await withLocalDb((db) =>
      auditRows(db, `where action = 'admin.users.mfa.reset' and resource_id = $1 and outcome = 'success'`, [target.userId]),
    );
    expect(rows).toHaveLength(1);
    const metadataText = JSON.stringify(rows[0].metadata ?? {});
    expect(metadataText).not.toContain(target.email);
    expect(metadataText).not.toContain(reason);
  });

  test(`SEC-ADMIN-009-AC-01 送る側が足した IP が監査ログに残らず、信頼する見出し（x-real-ip）の値が残る`, async ({ request, baseURL }) => {
    const origin = originOf(baseURL);
    const admin = await sharedAdmin();
    const target = await createTestMember('misc003-009');
    await withLocalDb((db) => assignRole(db, target.userId, 'supporter', true));
    const userAgent = `e2e-sec-admin-009-${randomUUID()}`;
    // 偽の x-forwarded-for は付けたまま、信頼する x-real-ip を別に付ける（手元の E2E の固定の環境が x-real-ip を信頼する）
    const realIp = uniqueSourceIp();
    const spoofed = { 'x-forwarded-for': `${SPOOFED_IP}, 10.0.0.1`, 'x-real-ip': realIp, 'user-agent': userAgent };

    // 強制失効の要求を、x-forwarded-for の左端に足した値と x-real-ip を付けて送る。IP を書く行（JWT 無し・本文の誤り・成功）を全部通す
    const unauthorized = await revoke(request, origin, null, { user_id: target.userId }, spoofed);
    expect(unauthorized.status()).toBe(401);
    const invalid = await revoke(request, origin, admin.accessToken, { user_id: '' }, spoofed);
    expect(invalid.status()).toBe(400);
    const revoked = await revoke(request, origin, admin.accessToken, { user_id: target.userId }, spoofed);
    expect(revoked.status()).toBe(200);

    const rows = await withLocalDb((db) =>
      auditRows(
        db,
        `where action = 'admin_revoke_user_sessions' and (user_agent = $1 or resource_id = $2)`,
        [userAgent, target.userId],
      ),
    );
    // 行が無ければ「ip が足した値でない」が空振りになるので、行があることを先に確かめる
    // 認可に失敗した行は全体の上限（10分に20行）で書かれないことがあるので、行為者が分かる 2 行（本文の誤り・成功）を最低にする
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.map((row) => row.ip)).not.toContain(SPOOFED_IP);
    expect(rows.map((row) => row.ip)).not.toContainEqual(expect.stringContaining(SPOOFED_IP));
    // 行（JWT 無し・本文の誤り・成功）の IP が全部 x-real-ip の値。成功の行は閉包で書く（IP が欠けやすい行）
    expect(rows.every((row) => row.ip === realIp)).toBe(true);
    expect(rows.some((row) => row.outcome === 'success')).toBe(true);
    // 行為者のメールは、行為者が分かる行（本文の誤り・成功）に入る
    const actorRows = rows.filter((row) => row.outcome !== 'unauthorized');
    expect(actorRows.length).toBeGreaterThanOrEqual(2);
    expect(actorRows.every((row) => row.actor_email === admin.email)).toBe(true);
  });

  test(`SEC-ADMIN-014-AC-01 ACL で特権を外した人の MFA はリセットしない`, async ({ request, baseURL }) => {
    const origin = originOf(baseURL);
    const admin = await sharedAdmin();
    const target = await createTestMember('misc003-014a');
    // app_metadata.role は supporter のまま、user_roles の割り当ては無効（役割を外した人）
    await withLocalDb(async (db) => {
      await assignRole(db, target.userId, 'supporter', false);
      await addTotpFactor(db, target.userId);
      const active = await db.query(
        `select count(*)::int as n from public.user_roles ur join public.roles r on r.id = ur.role_id
          where ur.user_id = $1::uuid and ur.active and r.code in ('admin', 'supporter')`,
        [target.userId],
      );
      expect(active.rows[0].n).toBe(0);
    });

    const response = await resetMfa(request, origin, admin.accessToken, target.userId, `e2e-reason-${randomUUID()}`);
    expect(response.status()).toBe(400);

    expect(await withLocalDb((db) => factorCount(db, target.userId))).toBe(1);
  });

  test(`SEC-ADMIN-014-AC-02 リセットの後、対象の session が全部失効する`, async ({ page, request, baseURL }) => {
    const origin = originOf(baseURL);
    const admin = await sharedAdmin();
    await withPermissionScenario(async (db) => {
      const target = await createTestMember('misc003-014b');
      const supporterJwt = await loginSupporterAsAal2(page, db, target, uniqueSourceIp());
      await addTotpFactor(db, target.userId);
      // リセット前の JWT は管理 API に通る（比べる基準）
      expect((await probe(request, SUPPORTER_PROBE_ROUTE, supporterJwt)).status()).toBe(200);

      const response = await resetMfa(request, origin, admin.accessToken, target.userId, `e2e-reason-${randomUUID()}`);
      expect(response.status()).toBe(200);

      // 要素の削除だけでも GoTrue がログアウトさせうるので、新しい失効を通ったことは session の行でも確かめる
      const sessions = await db.query(
        `select (select count(*)::int from public.sessions where user_id = $1::uuid and revoked_at is null) as live,
                (select count(*)::int from auth.sessions where user_id = $1::uuid) as auth`,
        [target.userId],
      );
      expect(sessions.rows[0].live).toBe(0);
      expect(sessions.rows[0].auth).toBe(0);
      expect((await probe(request, SUPPORTER_PROBE_ROUTE, supporterJwt)).status()).toBe(401);
    });
  });

  test(`SEC-ADMIN-015-AC-01 自分自身の失効を断る`, async ({ request, baseURL }) => {
    const origin = originOf(baseURL);
    // 断られなかった時に自分の session が消えるので、共有ではなくこの試験だけの管理者を使う
    const admin = await createAal2Admin();
    expect((await probe(request, ADMIN_PROBE_ROUTE, admin.accessToken)).status()).toBe(200);

    const response = await revoke(request, origin, admin.accessToken, { user_id: admin.userId });
    expect(response.status()).toBe(400);

    // その店長の session が残って、次の管理 API の要求が通る
    const authSessions = await withLocalDb(async (db) => {
      const result = await db.query('select count(*)::int as n from auth.sessions where user_id = $1::uuid', [admin.userId]);
      return result.rows[0].n as number;
    });
    expect(authSessions).toBeGreaterThanOrEqual(1);
    expect((await probe(request, ADMIN_PROBE_ROUTE, admin.accessToken)).status()).toBe(200);
  });

  test(`SEC-ADMIN-015-AC-02 存在しない利用者の失効を 404 で断る`, async ({ request, baseURL }) => {
    const origin = originOf(baseURL);
    const admin = await sharedAdmin();
    const missingUserId = randomUUID();
    const successRows = () =>
      withLocalDb(async (db) => {
        const result = await db.query(
          `select count(*)::int as n from public.audit_logs
            where action = 'admin_revoke_user_sessions' and outcome = 'success' and resource_id = $1`,
          [missingUserId],
        );
        return result.rows[0].n as number;
      });

    const before = await successRows();
    const response = await revoke(request, origin, admin.accessToken, { user_id: missingUserId });
    expect(response.status()).toBe(404);
    expect(await successRows()).toBe(before);
  });

  test(`SEC-ADMIN-016-AC-01 失効の後、自前と Auth の session が全部止まる`, async ({ page, browser, request, baseURL }) => {
    const origin = originOf(baseURL);
    const admin = await sharedAdmin();
    const secondPage = await newMemberPage(browser, baseURL);
    try {
      await withPermissionScenario(async (db) => {
        const target = await createTestMember('misc003-016');
        // 別のブラウザでも同じサポーターでログインして、session を2つ作る（「全部」を確かめる）
        await loginAsMember(secondPage, target, uniqueSourceIp());
        const secondJwt = await accessTokenCookie(secondPage);
        // 同じ利用者への確認コードの送信は GoTrue が最小の間隔（手元は auth.email.max_frequency = 1s）を空けないと断る。断られると 500 になるので、間隔を空けてから2回目のログインをする
        await page.waitForTimeout(2_000);
        const firstJwt = await loginSupporterAsAal2(page, db, target, uniqueSourceIp());

        const sessionsOf = async () => {
          const own = await db.query(
            `select count(*)::int as total, count(*) filter (where revoked_at is null)::int as live
               from public.sessions where user_id = $1::uuid`,
            [target.userId],
          );
          const auth = await db.query('select count(*)::int as n from auth.sessions where user_id = $1::uuid', [target.userId]);
          return { total: own.rows[0].total as number, live: own.rows[0].live as number, auth: auth.rows[0].n as number };
        };
        const beforeSessions = await sessionsOf();
        expect(beforeSessions.live).toBeGreaterThanOrEqual(1);
        expect(beforeSessions.auth).toBeGreaterThanOrEqual(1);
        expect((await probe(request, SUPPORTER_PROBE_ROUTE, firstJwt)).status()).toBe(200);

        const response = await revoke(request, origin, admin.accessToken, { user_id: target.userId });
        expect(response.status()).toBe(200);

        const afterSessions = await sessionsOf();
        // sessions の行の revoked_at が全部埋まり（行は残る）、auth.sessions の行は0件
        expect(afterSessions.total).toBeGreaterThanOrEqual(1);
        expect(afterSessions.live).toBe(0);
        expect(afterSessions.auth).toBe(0);
        // 失効前の JWT での管理 API の要求は 401
        expect((await probe(request, SUPPORTER_PROBE_ROUTE, firstJwt)).status()).toBe(401);
        expect((await probe(request, SUPPORTER_PROBE_ROUTE, secondJwt)).status()).toBe(401);
      });
    } finally {
      await secondPage.context().close();
    }
  });
});
