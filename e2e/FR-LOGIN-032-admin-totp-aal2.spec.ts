/**
 * FR-LOGIN-032 管理者・サポーターの TOTP（aal2）の窓口と、その守り（登録・確認・回数の制限・監査・DB の段・ログアウト）
 * 対応: FR-LOGIN-007-AC-02 / SEC-AUTH-009-AC-01 / SEC-AUTH-009-AC-02 / SEC-AUTH-010-AC-02 / SEC-AUTH-030-AC-01 /
 *       SEC-AUTH-031-AC-01 / FREQ-316-REQ-01-AC-01 / FREQ-316-REQ-02-AC-01 / FREQ-316-REQ-03-AC-01
 *
 * 前提（手元の Supabase だけで流す。本番の鍵は env に無い）:
 * - 管理者・サポーター: createTestMember で作り、役割（auth.users の app_metadata と public.user_roles）を DB でそろえてから
 *   loginAsMemberLegacy（メールの確認コードの本物のログイン）で aal1 の Cookie を得る。
 * - TOTP の本物の登録・確認（enroll-totp → 認証アプリのコード → verify）は、手元の GoTrue の TOTP が有効なときだけ通る
 *   （supabase/config.toml の [auth.mfa.totp] enroll_enabled・verify_enabled）。SEC-AUTH-030-AC-01・FREQ-316-REQ-02-AC-01 は
 *   この本物の流れを通す。無効のままなら登録の段で「TOTP が有効であること」の説明つきで落ちる（隠さない）。
 * - FR-LOGIN-007-AC-02・FREQ-316-REQ-01/03 は、まだ生きている守り（管理の入口・Cookie だけの認証・iss/aud・ログアウトの失効）を
 *   createAdminSessionActor（認めたパスキーの店員）と placeAdminCookies で確かめる。TOTP の材料は使わない。
 * - 残りの試験（SEC-AUTH-009・段4で消す TOTP の窓口）は、段4で消す機能なので test.skip。SEC-AUTH-010-AC-02 も skip だが、理由は「FR-LOGIN-031 の SEC-AUTH-010-AC-03 が同じことを確かめる」。かつては、
 *   auth.mfa_factors に verified の行を足す・auth.mfa_amr_claims に totp の行を足して refresh する、で材料を作る
 *   （FR-ADMIN-MISC-003 と同じ）。aal2 の JWT の aal は GoTrue 自身が出す。
 * - 監査ログ（public.audit_logs）と DB の行は、手元の DB の接続で直に読む。
 * - SEC-AUTH-009・SEC-AUTH-030-AC-01・SEC-AUTH-031 は、今のコードが満たさない（docs の各 AC の「今のコードは満たさない」）。
 *   コードが直るまで赤になるのが正しい。
 * JWT・Cookie が通信記録に残らないよう trace は切る。
 */
import { createHmac, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { expect, test, type APIResponse, type Page } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { createAdminSessionActor, placeAdminCookies } from './admin-session-test-utils';
import { DUMMY_CAPTCHA_TOKEN } from './captcha-test-utils';
import { createTestMember, loginAsMemberLegacy, type TestMember } from './member-session-helpers';
import { createPaidOrder, uniqueEmail, withLocalDb } from './order-email-test-utils';
import { viewports } from './order-fulfillment-test-utils';

test.use({ trace: 'off' });
test.describe.configure({ timeout: 180_000 });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const JWT_SECRET = process.env.JWT_SECRET ?? '';

const ENROLL_ROUTE = '/api/auth/mfa/enroll-totp';
const VERIFY_ROUTE = '/api/auth/mfa/verify';
const LOGOUT_ROUTE = '/api/auth/logout';

type PrivilegedRole = 'admin' | 'supporter';

/** 管理の窓口として要求が通ったかを見る窓口。admin.permissions.manage は管理者に、admin.users.read はサポーターに付く */
const PROBE_ROUTE: Record<PrivilegedRole, string> = {
  admin: '/api/admin/permissions',
  supporter: '/api/admin/users',
};

function requireLocalEnv(): void {
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY || !isLocalUrl(SUPABASE_URL)) {
    throw new Error('手元の Supabase の公開値と service role の鍵が env に無い（この試験は手元の Supabase だけで流す）');
  }
}

function originOf(baseURL: string | undefined): string {
  if (!baseURL) throw new Error('baseURL が無い（playwright.config.ts）');
  return new URL(baseURL).origin;
}

/** 回数の制限を試験ごとに別の送り元で数えるための値（手元の E2E サーバーだけで効く） */
function uniqueSourceIp(): string {
  const bytes = randomBytes(2);
  return `198.18.${bytes[0]}.${(bytes[1] % 253) + 1}`;
}

type Claims = { sub?: string; session_id?: string; aal?: string; iss?: string; aud?: string | string[] };

function claimsOf(jwt: string): Claims {
  return JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as Claims;
}

// ---- DB の材料 ----

/** auth.users の役割（app_metadata）と public.user_roles の割り当てを同じ役割にそろえる */
async function assignRole(db: PgClient, userId: string, role: PrivilegedRole): Promise<void> {
  await db.query(
    `update auth.users
        set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('role', $2::text)
      where id = $1::uuid`,
    [userId, role],
  );
  const assigned = await db.query(
    `insert into public.user_roles (user_id, role_id, active, expires_at)
     select $1::uuid, r.id, true, null from public.roles r where r.code = $2
     on conflict (user_id, role_id) do update set active = true, expires_at = null`,
    [userId, role],
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

/** 2要素の登録（verified の totp）を1つ足す。登録済みの管理者の状態を作る */
async function addVerifiedTotpFactor(db: PgClient, userId: string): Promise<string> {
  const factor = await db.query(
    `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
     values (gen_random_uuid(), $1::uuid, $2, 'totp', 'verified', now(), now(), 'JBSWY3DPEHPK3PXP')
     returning id::text as id`,
    [userId, `e2e-${randomBytes(4).toString('hex')}`],
  );
  return factor.rows[0].id as string;
}

async function factorCountOf(userId: string): Promise<number> {
  return withLocalDb(async (db) => {
    const result = await db.query('select count(*)::int as n from auth.mfa_factors where user_id = $1::uuid', [userId]);
    return result.rows[0].n as number;
  });
}

type AuditRow = { action: string; outcome: string };

/** その利用者が行為者の監査ログのうち、action が pattern（正規表現）に合う行。新しい順ではなく入った順 */
async function auditRowsOf(userId: string, actionPattern: string): Promise<AuditRow[]> {
  return withLocalDb(async (db) => {
    const result = await db.query(
      `select action, outcome from public.audit_logs
        where actor_id::text = $1 and action ~* $2
        order by created_at asc, id asc`,
      [userId, actionPattern],
    );
    return result.rows as AuditRow[];
  });
}

// ---- ログインと aal ----

async function accessTokenCookie(page: Page): Promise<string> {
  const origin = new URL(page.url()).origin;
  const cookie = (await page.context().cookies(origin)).find((c) => c.name === 'sb-access-token');
  if (!cookie?.value) throw new Error('sb-access-token の Cookie が無い（loginAsMemberLegacy の後に呼ぶ）');
  return cookie.value;
}

/** 役割をそろえた会員を、メールの確認コードの本物のログインで aal1 にする */
async function loginPrivilegedAsAal1(
  page: Page,
  label: string,
  role: PrivilegedRole,
): Promise<{ member: TestMember; ip: string }> {
  requireLocalEnv();
  const ip = uniqueSourceIp();
  const member = await createTestMember(label);
  await withLocalDb((db) => assignRole(db, member.userId, role));
  await loginAsMemberLegacy(page, member, ip);
  expect(claimsOf(await accessTokenCookie(page)).aal, 'ログインしただけの JWT は aal1').toBe('aal1');
  return { member, ip };
}

/** ログイン済みの会員の session に totp の印を足し、アプリの refresh を通して aal2 の Cookie にする */
async function elevateCookieToAal2(page: Page, ip: string): Promise<string> {
  const sessionId = claimsOf(await accessTokenCookie(page)).session_id;
  if (!sessionId) throw new Error('JWT に session_id が無い');
  await withLocalDb((db) => addTotpAmrClaim(db, sessionId));
  const origin = new URL(page.url()).origin;
  const refreshed = await page.request.post(new URL('/api/auth/refresh', origin).toString(), {
    headers: { origin, 'x-real-ip': ip },
    maxRedirects: 0,
    failOnStatusCode: false,
  });
  if (!refreshed.ok()) throw new Error(`session を更新できない: ${refreshed.status()}`);
  const accessToken = await accessTokenCookie(page);
  if (claimsOf(accessToken).aal !== 'aal2') {
    throw new Error('JWT が aal2 にならない（手元の GoTrue が amr の行から aal を出す前提が崩れた）');
  }
  return accessToken;
}

/** Authorization の見出しを付けず、ブラウザの Cookie だけで管理の窓口を呼ぶ */
function probeWithCookie(page: Page, role: PrivilegedRole): Promise<APIResponse> {
  return page.request.get(new URL(PROBE_ROUTE[role], new URL(page.url()).origin).toString(), {
    failOnStatusCode: false,
    maxRedirects: 0,
  });
}

// ---- TOTP（RFC 6238。認証アプリの代わり） ----

function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of input.replace(/=+$/, '').toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  return Buffer.from(bytes);
}

/** 30 秒刻み・6 桁・HMAC-SHA1 の TOTP */
function totpCode(secretBase32: string, nowMs = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(nowMs / 1000 / 30)));
  const digest = createHmac('sha1', base32Decode(secretBase32)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % 1_000_000).padStart(6, '0');
}

function postJson(page: Page, route: string, ip: string, data: unknown): Promise<APIResponse> {
  const origin = new URL(page.url()).origin;
  return page.request.post(new URL(route, origin).toString(), {
    headers: { origin, 'x-real-ip': ip },
    data,
    failOnStatusCode: false,
    maxRedirects: 0,
  });
}

/** 本物の TOTP の登録（enroll-totp）。手元の GoTrue の TOTP が無効だとここで落ちる */
async function enrollTotp(page: Page): Promise<{ factorId: string; secret: string }> {
  const response = await postJson(page, ENROLL_ROUTE, uniqueSourceIp(), {});
  expect(
    response.status(),
    'enroll-totp が 200（手元の GoTrue の TOTP が有効であること。supabase/config.toml の [auth.mfa.totp]）',
  ).toBe(200);
  const body = (await response.json()) as { data?: { factorId?: string; secret?: string } };
  if (!body.data?.factorId || !body.data.secret) throw new Error('enroll-totp の応答に factorId と secret が無い');
  return { factorId: body.data.factorId, secret: body.data.secret };
}

function verifyTotp(page: Page, factorId: string, code: string, ip = uniqueSourceIp()): Promise<APIResponse> {
  return postJson(page, VERIFY_ROUTE, ip, { factorId, code });
}

// ---- JWT の作り直し（iss・aud の確かめ用。手元の JWT_SECRET の HS256） ----

const base64Json = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

/** 本物の JWT のクレームを写し、mutate で一部を変えて、手元の JWT_SECRET（HS256）で署名し直す。署名は常に正しい */
function resignedToken(realToken: string, mutate: (claims: Record<string, unknown>) => void): string {
  const claims = JSON.parse(Buffer.from(realToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
  mutate(claims);
  const head = base64Json({ alg: 'HS256', typ: 'JWT' });
  const body = base64Json(claims);
  const signature = createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${signature}`;
}

// ======================================================================================

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-032 (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`FR-LOGIN-007-AC-02 管理者とサポーターは入口の条件（認めたパスキー2本）を満たすまで管理画面へ進めない (${viewport.name})`, async ({ page }) => {
      // 古い版は TOTP を通るまでの門を見ていた。今の門（SR-AUTH-014: パスキーのログイン＋認めたパスキー2本）が同じ守りを担うので、
      // 認めたパスキー1本の店員（古い名前の aal1）が画面でも窓口でも断られ、2本の店員（aal2）は通る、で確かめる。
      requireLocalEnv();
      for (const role of ['admin', 'supporter'] as const) {
        const oneKey = await withLocalDb((db) => createAdminSessionActor(db, role, 'aal1'));
        await placeAdminCookies(page, oneKey, uniqueSourceIp());

        // 入口の条件を満たさないので、管理画面は「2要素認証が必要です」で止まり、管理の窓口も 403（MFA required）
        await page.goto('/admin');
        await expect(page.getByRole('heading', { name: '2要素認証が必要です' }), `${role}（1本）の管理画面`).toBeVisible({ timeout: 15_000 });
        const probe = await probeWithCookie(page, role);
        expect(probe.status(), `${role}（1本）では管理の窓口が 403`).toBe(403);
        expect(((await probe.json()) as { reason?: string }).reason).toBe('MFA required');

        // 対照: 認めたパスキー2本の店員は同じ窓口が通る
        const twoKeys = await withLocalDb((db) => createAdminSessionActor(db, role, 'aal2'));
        await placeAdminCookies(page, twoKeys, uniqueSourceIp());
        expect((await probeWithCookie(page, role)).status(), `${role}（2本）では管理の窓口が 200`).toBe(200);
        // 画面でも入口を通る: 止める見出しが出ず、管理画面の中身の列（admin-content-column）が出る
        await page.goto('/admin');
        await expect(page.getByTestId('admin-content-column'), `${role}（2本）の管理画面`).toBeVisible({ timeout: 15_000 });
        await expect(page.getByRole('heading', { name: '2要素認証が必要です' })).toHaveCount(0);
        await expect(page.getByRole('heading', { name: 'アクセス権限がありません' })).toHaveCount(0);

        await page.context().clearCookies();
      }
    });

    test(`SEC-AUTH-009-AC-01 同じ利用者の6回目の TOTP の確認が 429 (${viewport.name})`, async ({ page }) => {
      test.skip(true, '段4で消す機能: 店員のパスワード＋確認コード＋TOTP のログインと TOTP の窓口（段4で消す）。手元では店員がアプリの画面から入れない（GoTrue のフックが拒否。SEC-AUTH-040）');
      // 利用者単位の枠（5 回 / 600 秒）は challenge より前に数えるので、TOTP を有効にする ENV に関係なく 6 回目は 429 になる。
      const { member } = await loginPrivilegedAsAal1(page, 'login032-009a', 'admin');
      const factorId = await withLocalDb((db) => addVerifiedTotpFactor(db, member.userId));

      // 送り元（IP）を毎回変えて、IP 単位の上限に当たらないようにする。同じ利用者で誤ったコードを6回送る
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const response = await verifyTotp(page, factorId, '000000', uniqueSourceIp());
        statuses.push(response.status());
      }

      expect(statuses.slice(0, 5), '1〜5回目は上限の手前（429 ではない）').not.toContain(429);
      expect(statuses[5], `6回目が 429（実際の並び: ${statuses.join(',')}）`).toBe(429);
    });

    test(`SEC-AUTH-009-AC-02 TOTP の失敗が監査に残る (${viewport.name})`, async ({ page }) => {
      test.skip(true, '段4で消す機能: 店員のパスワード＋確認コード＋TOTP のログインと TOTP の窓口（段4で消す）。手元では店員がアプリの画面から入れない（GoTrue のフックが拒否。SEC-AUTH-040）');
      // 手元で TOTP が無効（challenge が 400）でも、challenge の失敗の分岐が failure の行を 1 つ書く。
      const { member } = await loginPrivilegedAsAal1(page, 'login032-009b', 'admin');
      const factorId = await withLocalDb((db) => addVerifiedTotpFactor(db, member.userId));
      const failuresBefore = (await auditRowsOf(member.userId, 'mfa')).filter((row) => row.outcome === 'failure');

      const response = await verifyTotp(page, factorId, '000000');
      expect(response.status(), '誤ったコードは通らない').toBeGreaterThanOrEqual(400);

      // 誤ったコードを送った後に、利用者の ID と失敗の行が1つ増える
      const failuresAfter = (await auditRowsOf(member.userId, 'mfa')).filter((row) => row.outcome === 'failure');
      expect(failuresAfter.length - failuresBefore.length).toBe(1);
    });

    test(`SEC-AUTH-010-AC-02 aal2 の管理者の JWT では今どおり他人の注文が読める (${viewport.name})`, async ({ page, request }) => {
      test.skip(true, 'AC-03 が同じことを確かめる: 認めたパスキー2本の店員が他人の注文を RLS で読める（FR-LOGIN-031 の SEC-AUTH-010-AC-03）。パスワード＋TOTP の入り方は段4で消す（手元では店員がアプリの画面から入れない。SEC-AUTH-040）');
      const { ip } = await loginPrivilegedAsAal1(page, 'login032-010b', 'admin');
      const aal2Token = await elevateCookieToAal2(page, ip);
      const admin = claimsOf(aal2Token);
      expect(admin.aal).toBe('aal2');

      // その管理者の注文ではない注文（ゲストの入金済みの注文）を作る
      const orderId = await withLocalDb((db) => createPaidOrder(db, uniqueEmail('login032-010b')));

      const response = await request.get(
        `${SUPABASE_URL}/rest/v1/orders?select=id,user_id&id=eq.${encodeURIComponent(orderId)}`,
        { headers: { apikey: ANON_KEY, Authorization: `Bearer ${aal2Token}` }, failOnStatusCode: false },
      );
      expect(response.status()).toBe(200);
      const rows = (await response.json()) as Array<{ id: string; user_id: string | null }>;
      // aal2 の管理者の JWT の select の結果に、他人の注文の行が含まれる
      expect(rows.map((row) => row.id)).toContain(orderId);
      expect(rows.find((row) => row.id === orderId)?.user_id).not.toBe(admin.sub);
    });

    test(`SEC-AUTH-030-AC-01 TOTP の登録と確認の成功が監査に残る (${viewport.name})`, async ({ page }) => {
      test.skip(true, '段4で消す機能: 店員のパスワード＋確認コード＋TOTP のログインと TOTP の窓口（段4で消す）。手元では店員がアプリの画面から入れない（GoTrue のフックが拒否。SEC-AUTH-040）');
      const { member } = await loginPrivilegedAsAal1(page, 'login032-030a', 'admin');
      const before = (await auditRowsOf(member.userId, 'mfa')).filter((row) => row.outcome === 'success');

      const { factorId, secret } = await enrollTotp(page);
      const verified = await verifyTotp(page, factorId, totpCode(secret));
      expect(verified.status(), '正しいコードの確認が 200').toBe(200);

      // 登録と確認の後に、利用者の ID と成功の行がそれぞれ1つずつ増える
      const after = (await auditRowsOf(member.userId, 'mfa')).filter((row) => row.outcome === 'success');
      const added = after.slice(before.length);
      expect(added, '成功の行が2つ（登録と確認）増える').toHaveLength(2);
      expect(added.filter((row) => /enroll/i.test(row.action))).toHaveLength(1);
      expect(added.filter((row) => /verify/i.test(row.action))).toHaveLength(1);
    });

    test(`SEC-AUTH-031-AC-01 メール OTP を通っていない aal1 の session では初めての TOTP を登録できない (${viewport.name})`, async ({ request, baseURL }) => {
      test.skip(true, '段4で消す機能: 店員のパスワード＋確認コード＋TOTP のログインと TOTP の窓口（段4で消す）。手元では店員がアプリの画面から入れない（GoTrue のフックが拒否。SEC-AUTH-040）');
      // 2 段目の確かめは listFactors より前（amr が password だけなら 403）なので、TOTP を有効にする ENV に関係なく断られる。
      requireLocalEnv();
      const origin = originOf(baseURL);
      // TOTP をまだ登録していない管理者を、メールの確認コードを通さずにパスワードのログインだけで aal1 にする
      const email = `e2e-login032-031-${Date.now().toString(36)}${randomBytes(3).toString('hex')}@example.com`;
      const password = `E2e-${randomBytes(12).toString('hex')}!`;
      const options = { auth: { persistSession: false, autoRefreshToken: false } };
      const created = await createClient(SUPABASE_URL, SERVICE_KEY, options).auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        app_metadata: { role: 'admin' },
      });
      if (created.error || !created.data.user) {
        throw new Error(`手元の管理者を作れない（status: ${created.error?.status ?? '不明'}）`);
      }
      const userId = created.data.user.id;
      await withLocalDb((db) => assignRole(db, userId, 'admin'));
      const signedIn = await createClient(SUPABASE_URL, ANON_KEY, options).auth.signInWithPassword({ email, password, options: { captchaToken: DUMMY_CAPTCHA_TOKEN } });
      if (signedIn.error || !signedIn.data.session) {
        throw new Error(`手元の管理者でパスワードのログインができない（status: ${signedIn.error?.status ?? '不明'}）`);
      }
      const accessToken = signedIn.data.session.access_token;
      expect(claimsOf(accessToken).aal).toBe('aal1');
      expect(await factorCountOf(userId), '登録の前は要素が無い').toBe(0);

      const response = await request.post(new URL(ENROLL_ROUTE, origin).toString(), {
        headers: { Authorization: `Bearer ${accessToken}`, origin, 'x-real-ip': uniqueSourceIp() },
        data: {},
        failOnStatusCode: false,
        maxRedirects: 0,
      });

      // 断られ、要素が作られない
      expect([401, 403], `登録が断られる（実際: ${response.status()}）`).toContain(response.status());
      expect(await factorCountOf(userId), '要素が作られない').toBe(0);
      // 断りが監査に残る（成功ではない行が、この利用者で1つ以上）
      const denied = (await auditRowsOf(userId, 'enroll')).filter((row) => row.outcome !== 'success');
      expect(denied.length, '登録の断りが監査に残る').toBeGreaterThanOrEqual(1);
    });

    test(`FREQ-316-REQ-01-AC-01 Cookie の access token だけで管理の窓口が通り、iss か aud の違うトークンは断られる (${viewport.name})`, async ({ page, request }) => {
      requireLocalEnv();
      if (!JWT_SECRET) throw new Error('JWT_SECRET が env に無い（署名し直した JWT の確かめに要る）');
      // 認めたパスキー2本の店長（古い名前の aal2）の JWT を Cookie に置く。TOTP は使わない
      const actor = await withLocalDb((db) => createAdminSessionActor(db, 'admin', 'aal2'));
      const aal2Token = actor.accessToken;
      await placeAdminCookies(page, actor, uniqueSourceIp());

      // Authorization の見出しが無く Cookie の access token だけを持つ管理者の要求が、管理の窓口を通る
      const viaCookie = await probeWithCookie(page, 'admin');
      expect(viaCookie.status()).toBe(200);

      // 署名が正しい（手元の JWT_SECRET で署名し直した）JWT。対照: クレームを変えなければ通る
      const probeUrl = new URL(PROBE_ROUTE.admin, originOf(page.url())).toString();
      const probeWith = async (token: string) =>
        (await request.get(probeUrl, { headers: { Authorization: `Bearer ${token}` }, failOnStatusCode: false, maxRedirects: 0 })).status();
      expect(await probeWith(resignedToken(aal2Token, () => undefined)), '対照: クレームを変えない署名し直しは通る').toBe(200);

      // 署名が正しくても iss か aud が違うトークンは 401
      expect(
        await probeWith(resignedToken(aal2Token, (claims) => { claims.iss = 'https://issuer.invalid/auth/v1'; })),
        'iss が違うトークン',
      ).toBe(401);
      expect(
        await probeWith(resignedToken(aal2Token, (claims) => { claims.aud = 'not-authenticated'; })),
        'aud が違うトークン',
      ).toBe(401);
    });

    test(`FREQ-316-REQ-02-AC-01 TOTP の確認の後の Cookie の access token が aal2 になり、aal1 のトークンでは管理の窓口が 403 になる (${viewport.name})`, async ({ page }) => {
      test.skip(true, '段4で消す機能: 店員のパスワード＋確認コード＋TOTP のログインと TOTP の窓口（段4で消す）。手元では店員がアプリの画面から入れない（GoTrue のフックが拒否。SEC-AUTH-040）');
      await loginPrivilegedAsAal1(page, 'login032-316b', 'admin');

      // aal1 のトークンで管理の窓口を呼ぶと 403（MFA required）
      const beforeVerify = await probeWithCookie(page, 'admin');
      expect(beforeVerify.status()).toBe(403);
      expect(((await beforeVerify.json()) as { reason?: string }).reason).toBe('MFA required');

      const { factorId, secret } = await enrollTotp(page);
      const verified = await verifyTotp(page, factorId, totpCode(secret));
      expect(verified.status(), '正しいコードの確認が 200').toBe(200);

      // /api/auth/mfa/verify が通った後の応答の Cookie の access token の aal が aal2
      const setCookies = verified.headersArray().filter((header) => header.name.toLowerCase() === 'set-cookie');
      const accessCookie = setCookies.find((header) => header.value.startsWith('sb-access-token='));
      expect(accessCookie, '応答に access token の Cookie が付く').toBeDefined();
      const token = decodeURIComponent((accessCookie?.value ?? '').split(';')[0].slice('sb-access-token='.length));
      expect(claimsOf(token).aal).toBe('aal2');

      // その Cookie で、管理の窓口が通る
      const afterVerify = await probeWithCookie(page, 'admin');
      expect(afterVerify.status()).toBe(200);
    });

    test(`FREQ-316-REQ-03-AC-01 ログアウトの後、その前の access token で管理の窓口が 401 になる (${viewport.name})`, async ({ page, request }) => {
      const actor = await withLocalDb((db) => createAdminSessionActor(db, 'admin', 'aal2'));
      const aal2Token = actor.accessToken;
      const ip = uniqueSourceIp();
      const { origin, csrfToken } = await placeAdminCookies(page, actor, ip);
      const probeUrl = new URL(PROBE_ROUTE.admin, origin).toString();
      const probeBearer = async () =>
        (await request.get(probeUrl, { headers: { Authorization: `Bearer ${aal2Token}` }, failOnStatusCode: false, maxRedirects: 0 })).status();

      // ログアウトの前は、期限内の access token で通る
      expect(await probeBearer()).toBe(200);

      const logout = await page.request.post(new URL(LOGOUT_ROUTE, origin).toString(), {
        headers: { origin, 'x-csrf-token': csrfToken, 'x-real-ip': ip },
        failOnStatusCode: false,
        maxRedirects: 0,
      });
      expect(logout.status()).toBe(200);

      // ログアウトの前の access token（期限内）で管理の窓口を呼ぶと 401
      expect(claimsOf(aal2Token).sub, '期限内の access token は同じ店長のもの').toBe(actor.userId);
      expect(await probeBearer()).toBe(401);
    });
  });
}
