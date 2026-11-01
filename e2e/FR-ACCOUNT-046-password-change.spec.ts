/**
 * FR-ACCOUNT-046 ログイン中の会員が自分でパスワードを変えられる（現行パスワード → メールの8桁のコード → 新しいパスワード）
 * 対応: FR-AUTH-006-AC-01〜07 / SEC-AUTH-034-AC-01〜04
 *
 * この spec は波 6 の切り替え（2026-11-01）まで supabase/pending-wave6/e2e/ に拡張子 .pending で置いていた。移行 M3（password_change_challenges、
 * supabase/migrations/20261101120000_sec_password_change_challenges.sql）が手元の DB に当たり、新しい窓口と画面を載せた本番ビルドが立つ必要がある。
 *
 * 道具立て
 * - 会員は auth.admin.createUser で既知のパスワードつきで作り（email_confirm）、アプリのログイン（再送の窓口 → メールの8桁のコード → /api/auth/otp/verify）
 *   で入る（member-session-helpers の loginAsMember）。パスワード変更の窓口・画面はこのログインで得た Cookie と CSRF の印で叩く。
 * - メールは手元の Mailpit を Node から読む（コード入りの応答をブラウザの通信記録に載せないため。trace も切る）。
 *   コードのメールは件名「パスワード変更の確認コード」、変更の通知は件名「パスワードを変更しました」で拾う。
 *   GoTrue 側の変更通知（件名「パスワードの変更を受け付けました」）は別の件名なので数えない。
 * - 画面を開く試験（FR-AUTH-006-AC-01・AC-02 の画面の道・AC-07 の案内）は mobile（390）／tablet（768）／desktop（1280）の3幅で流す。
 *   窓口を HTTP で叩く試験は結果が幅で変わらない。幅ごとに会員とログインを作ると、全部の E2E で共有する GoTrue のログイン・確認コードの枠
 *   （5 分で 30 回）と本物のメールが3倍になるので、1つの幅（desktop）だけ流す（FR-LOGIN-030・035 と同じ理由）。
 * - 回数の制限は送り元（x-real-ip）ごと・本人ごとに数える。試験ごとに別の送り元を使い、10分の枠の切れ目が近い時は次の枠に入るのを待つ。
 * - 確認コードの「5回で使えなくなる」は、本人ごとの枠（confirm は10分に5回）と同じ回数なので、5回間違えた後の6回目は枠で 429 になる。
 *   使えなくなったこと自体を見るため、5回間違えた後に手元の DB でこの会員の枠の行だけを消してから正しいコードを送る。
 * - 漏洩の照合（FR-AUTH-006-AC-05）は本物の HaveIBeenPwned（api.pwnedpasswords.com）へ出る（FR-SIGNUP-002 と同じ。外部が使えない環境では
 *   照合は fail-open で変更が通るので、その1本の「漏洩した値で 400」は赤になる）。15文字の断りは外部に頼らない。
 * - 監査（public.audit_logs）と sessions は手元の DB の接続で直に読む。会員は終わりに消す。
 * - パスワード・確認コード・JWT・session_id は失敗の文面に出さない。
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { expect, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';
import { loginAsMember } from './member-session-helpers';
import { withLocalDb } from './order-email-test-utils';

// 確認コード・Cookie・JWT が通信記録に残らないよう、記録は取らない。
test.use({ trace: 'off', locale: 'ja-JP' });

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;
const apiOnlyViewports = [viewports[2]] as const;

const START_PATH = '/api/auth/password/change/start';
const CONFIRM_PATH = '/api/auth/password/change/confirm';
const LOGIN_PATH = '/api/auth/login';
const ME_PATH = '/api/auth/me';
const REFRESH_PATH = '/api/auth/refresh';
const VALID_TURNSTILE_TOKEN = 'test-turnstile-token';

const CODE_MAIL_SUBJECT = 'パスワード変更の確認コード';
const NOTICE_MAIL_SUBJECT = 'パスワードを変更しました';
const CURRENT_INVALID_MESSAGE = '現行のパスワードが正しくありません。';
const CODE_UNUSABLE_MESSAGE = '確認コードが正しくないか、期限が切れています。もう一度コードを送ってください。';
/** lib/pwned-password.ts の PWNED_PASSWORD_MESSAGE と同じ文 */
const PWNED_MESSAGE = 'このパスワードは過去の情報流出で公開されています。別のパスワードを設定してください。';
/** HaveIBeenPwned に載っている16文字の固定の文字列（FR-SIGNUP-002 の LEAKED_PASSWORD_B と同じ） */
const LEAKED_PASSWORD = 'passwordpassword';
/** 15文字（アプリの最小は16）。漏洩の照合より前の形の検査で断られる */
const SHORT_PASSWORD = 'Abcdefgh1234!xy';
const CSRF_COOKIE = 'sb-csrf-token';
const AUTH_COOKIES = ['sb-access-token', 'sb-refresh-token', 'sb-csrf-token'] as const;

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
/** 枠の切れ目までこれより短いと、数回の送信の途中で枠が切り替わりうるので、切り替わるのを待つ */
const MIN_ROOM_IN_WINDOW_MS = 30_000;

// ---- 準備 ----

type Member = { userId: string; email: string; password: string };

const createdUserIds: string[] = [];

function localAuthAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !isLocalUrl(url)) throw new Error('会員を作れるのは手元の Supabase だけ');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function localMailUrl(): string {
  const url = process.env.MAIL_LOCAL_URL;
  if (!url || !isLocalUrl(url)) throw new Error('手元のメール受け（MAIL_LOCAL_URL）が無い');
  return url;
}

function originOf(baseURL: string | undefined): string {
  const origin = new URL(baseURL ?? 'http://localhost:3000').origin;
  if (!isLocalUrl(origin)) throw new Error('この試験は手元のアプリだけを叩く');
  return origin;
}

const newPassword = (): string => `E2e-${randomBytes(12).toString('hex')}!`;
const newEmail = (label: string): string =>
  `e2e-pwchange-${label}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}@example.com`;

/** 試験ごと・要求ごとに別の送り元として数えさせる（x-real-ip。E2E のアプリは CLIENT_IP_HEADER で信頼する） */
const usedSourceIps = new Set<string>();
function uniqueSourceIp(): string {
  for (;;) {
    const ip = `198.18.${randomInt(0, 256)}.${randomInt(1, 255)}`;
    if (!usedSourceIps.has(ip)) {
      usedSourceIps.add(ip);
      return ip;
    }
  }
}

/** 既知のパスワードの会員を作る。admin なら役割 admin（app_metadata と user_roles）も付ける。終わりに消す */
async function createMember(label: string, options: { admin?: boolean } = {}): Promise<Member> {
  const email = newEmail(label);
  const password = newPassword();
  const created = await localAuthAdmin()
    .auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      ...(options.admin ? { app_metadata: { role: 'admin' } } : {}),
    })
    .catch(() => {
      throw new Error('手元の会員を作る要求に失敗した');
    });
  if (created.error || !created.data.user) {
    throw new Error(`手元の会員を作れない（status: ${created.error?.status ?? '不明'}, code: ${created.error?.code ?? '不明'}）`);
  }
  const userId = created.data.user.id;
  createdUserIds.push(userId);
  if (options.admin) {
    await withLocalDb(async (db) => {
      const assigned = await db.query(
        `insert into public.user_roles (user_id, role_id, active, expires_at)
         select $1::uuid, r.id, true, null from public.roles r where r.code = 'admin'`,
        [userId],
      );
      if (assigned.rowCount !== 1) throw new Error('役割 admin の行が手元の DB に無い');
    });
  }
  return { userId, email, password };
}

/** Google だけで登録した会員（パスワードを持たない）を作る。終わりに消す */
async function createGoogleOnlyMember(label: string): Promise<{ userId: string; email: string }> {
  const email = newEmail(label);
  const created = await localAuthAdmin()
    .auth.admin.createUser({
      email,
      email_confirm: true,
      app_metadata: { provider: 'google', providers: ['google'] },
    })
    .catch(() => {
      throw new Error('手元の会員を作る要求に失敗した');
    });
  if (created.error || !created.data.user) {
    throw new Error(`手元の会員を作れない（status: ${created.error?.status ?? '不明'}, code: ${created.error?.code ?? '不明'}）`);
  }
  createdUserIds.push(created.data.user.id);
  return { userId: created.data.user.id, email };
}

test.afterEach(async () => {
  const ids = createdUserIds.splice(0);
  if (ids.length === 0) return;
  const admin = localAuthAdmin();
  for (const id of ids) {
    await admin.auth.admin.deleteUser(id).catch(() => undefined);
  }
});

/** 時計の10分の枠の切れ目が近い時だけ、次の枠に入るまで条件で待つ（固定の sleep はしない） */
async function ensureRoomInRateLimitWindow(): Promise<void> {
  const remaining = RATE_LIMIT_WINDOW_MS - (Date.now() % RATE_LIMIT_WINDOW_MS);
  if (remaining >= MIN_ROOM_IN_WINDOW_MS) return;
  const nextWindowStart = Date.now() + remaining;
  await expect
    .poll(() => Date.now() >= nextWindowStart, {
      message: '10分の枠が切り替わるのを待つ',
      timeout: MIN_ROOM_IN_WINDOW_MS + 15_000,
      intervals: [250],
    })
    .toBe(true);
}

/** この会員の本人ごとの枠（start・confirm）の行だけを消す。5回間違えた後の「使えない」を枠に邪魔されず見るため */
async function resetUserRateLimit(userId: string): Promise<void> {
  const hash = createHash('sha512').update(userId).digest('hex');
  await withLocalDb(async (db) => {
    await db.query('delete from public.rate_limit_counters where endpoint like $1', [`auth:password_change_%|acct:${hash}`]);
  });
}

// ---- メール（Mailpit を Node から読む） ----

type Mail = { ID: string; Subject: string };

async function listMails(email: string): Promise<Mail[]> {
  const searchUrl = new URL('/api/v1/search', localMailUrl());
  searchUrl.searchParams.set('query', `to:${email}`);
  const response = await fetch(searchUrl, { signal: AbortSignal.timeout(5_000), redirect: 'manual' }).catch(() => {
    throw new Error('手元のメール受けを検索できない');
  });
  if (!response.ok) throw new Error(`手元のメール受けを検索できない: ${response.status}`);
  const body = (await response.json().catch(() => ({}))) as { messages?: Mail[] };
  return body.messages ?? [];
}

async function mailIdsOf(email: string): Promise<Set<string>> {
  return new Set((await listMails(email)).map((mail) => mail.ID));
}

async function mailText(id: string): Promise<string> {
  const response = await fetch(new URL(`/api/v1/message/${encodeURIComponent(id)}`, localMailUrl()), {
    signal: AbortSignal.timeout(5_000),
    redirect: 'manual',
  }).catch(() => {
    throw new Error('手元のメールを取得できない');
  });
  if (!response.ok) throw new Error(`手元のメールを取得できない: ${response.status}`);
  const content = (await response.json().catch(() => ({}))) as { Text?: string; HTML?: string };
  return `${content.Text ?? ''}\n${(content.HTML ?? '').replace(/<[^>]*>/g, ' ')}`;
}

async function countNewMails(email: string, previousIds: ReadonlySet<string>, subject: string): Promise<number> {
  return (await listMails(email)).filter((mail) => !previousIds.has(mail.ID) && mail.Subject === subject).length;
}

/** 既に届いていたメールを除き、新しく届いたコードのメールの8桁のコードを返す */
async function waitForCode(email: string, previousIds: ReadonlySet<string>): Promise<string> {
  let code = '';
  await expect
    .poll(
      async () => {
        const mail = (await listMails(email)).find((m) => !previousIds.has(m.ID) && m.Subject === CODE_MAIL_SUBJECT);
        if (!mail) return '';
        const text = (await mailText(mail.ID)).replace(/https?:\/\/\S+/g, ' ');
        code = text.match(/\b(\d{8})\b/)?.[1] ?? '';
        return code;
      },
      { message: 'パスワード変更の確認コードのメールが届かない', timeout: 15_000 },
    )
    .toMatch(/^\d{8}$/);
  return code;
}

// ---- 窓口 ----

async function jsonOf(response: APIResponse): Promise<Record<string, unknown> | null> {
  const text = await response.text();
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function cookieValue(page: Page, origin: string, name: string): Promise<string> {
  const cookie = (await page.context().cookies(origin)).find((c) => c.name === name);
  if (!cookie?.value) throw new Error(`${name} の Cookie が無い`);
  return cookie.value;
}

/** パスワード変更の窓口を、この端末の Cookie と CSRF の印つきで叩く */
async function postChange(
  page: Page,
  origin: string,
  path: typeof START_PATH | typeof CONFIRM_PATH,
  data: unknown,
  sourceIp: string,
): Promise<APIResponse> {
  const csrf = await cookieValue(page, origin, CSRF_COOKIE);
  return page.request.post(new URL(path, origin).toString(), {
    headers: { origin, 'x-csrf-token': csrf, 'x-real-ip': sourceIp },
    data,
    maxRedirects: 0,
  });
}

/** start を叩いてコードのメールを読む。start が 200 でなければ試験を落とす */
async function startAndReadCode(page: Page, origin: string, member: Member, sourceIp: string): Promise<string> {
  const previousIds = await mailIdsOf(member.email);
  const response = await postChange(page, origin, START_PATH, { current_password: member.password }, sourceIp);
  expect(response.status(), 'start の status（準備）').toBe(200);
  return waitForCode(member.email, previousIds);
}

/** アプリのログインの1段目（パスワードの確かめ）。誤りは 401、合えば 200（確認コードのメールが出る） */
function postLogin(request: APIRequestContext, origin: string, email: string, password: string): Promise<APIResponse> {
  return request.post(new URL(LOGIN_PATH, origin).toString(), {
    headers: { origin, 'x-real-ip': uniqueSourceIp() },
    data: { email, password, turnstileToken: VALID_TURNSTILE_TOKEN },
    maxRedirects: 0,
  });
}

/** 確認コードと違う8桁（誤りを送るため） */
const otherCode = (code: string): string => (code === '00000000' ? '00000001' : '00000000');

function setCookieNames(response: APIResponse, predicate: (attributes: string[]) => boolean): Set<string> {
  const names = new Set<string>();
  for (const header of response.headersArray()) {
    if (header.name.toLowerCase() !== 'set-cookie') continue;
    const [pair, ...rest] = header.value.split(';').map((part) => part.trim());
    const name = pair.split('=')[0];
    if (predicate(rest.map((attribute) => attribute.toLowerCase()))) names.add(name);
  }
  return names;
}

function sessionIdOf(accessToken: string): string {
  const payload = accessToken.split('.')[1];
  if (!payload) throw new Error('JWT の形が正しくない');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { session_id?: string };
  if (!claims.session_id) throw new Error('JWT に session_id が無い');
  return claims.session_id;
}

// ---- DB ----

async function passwordHashOf(userId: string): Promise<string> {
  return withLocalDb(async (db) => {
    const row = await db.query('select encrypted_password from auth.users where id = $1::uuid', [userId]);
    return row.rows[0].encrypted_password as string;
  });
}

type AuditRow = { action: string; outcome: string; detail: string | null; rowText: string };

async function auditRowsOf(userId: string): Promise<AuditRow[]> {
  return withLocalDb(async (db) => {
    const result = await db.query(
      `select a.action, a.outcome, a.detail, to_jsonb(a)::text as row_text
         from public.audit_logs a
        where a.actor_id::text = $1 and a.action in ('password_change_start', 'password_change_confirm')
        order by a.created_at`,
      [userId],
    );
    return result.rows.map((row) => ({
      action: row.action as string,
      outcome: row.outcome as string,
      detail: (row.detail as string | null) ?? null,
      rowText: row.row_text as string,
    }));
  });
}

// ---- 画面の試験（3幅） ----

for (const viewport of viewports) {
  test.describe(`FR-ACCOUNT-046 password change screen (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`FR-AUTH-006-AC-01 ${viewport.name}: プロフィールのリンクから /account/password に着き、現行パスワードの欄と送るボタンだけが出る`, async ({ page }) => {
      test.setTimeout(120_000);
      const member = await createMember('screen');
      await loginAsMember(page, member, uniqueSourceIp());

      await page.goto('/account?tab=profile');
      const link = page.getByRole('link', { name: 'パスワードを変更' });
      await expect(link, 'プロフィールのパスワード変更のリンク').toBeVisible({ timeout: 30_000 });
      await link.click();

      await expect(page).toHaveURL(/\/account\/password$/);
      await expect(page.getByRole('heading', { level: 1, name: 'パスワードの変更' })).toBeVisible();
      await expect(page.getByLabel('現行のパスワード', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '確認コードをメールに送る' })).toBeVisible();
      // コードと新しいパスワードの欄は、現行パスワードが通るまで出ない
      await expect(page.getByLabel('確認コード', { exact: true })).toHaveCount(0);
      await expect(page.getByLabel('新しいパスワード', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'パスワードを変更する' })).toHaveCount(0);

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, '横にはみ出さない').toBeLessThanOrEqual(0);
    });

    test(`FR-AUTH-006-AC-02 ${viewport.name}: 画面で現行パスワード → コード → 新しいパスワードを入れると変わり、ログインへ移る。古いパスワードは 401、新しいパスワードは通る`, async ({ page, request, baseURL }) => {
      test.setTimeout(120_000);
      const origin = originOf(baseURL);
      const member = await createMember('screen-change');
      const sourceIp = uniqueSourceIp();
      await loginAsMember(page, member, sourceIp);
      // ブラウザの要求も試験ごとの送り元で数える（付けないと「送り元なし」の1つの枠を全試験で使い切る）
      await page.route('**/api/**', (route) => route.continue({ headers: { ...route.request().headers(), 'x-real-ip': sourceIp } }));

      await page.goto('/account/password');
      await page.getByLabel('現行のパスワード', { exact: true }).fill(member.password);
      const previousIds = await mailIdsOf(member.email);
      await page.getByRole('button', { name: '確認コードをメールに送る' }).click();
      await expect(page.getByLabel('確認コード', { exact: true })).toBeVisible({ timeout: 30_000 });
      const code = await waitForCode(member.email, previousIds);

      const replacement = newPassword();
      await page.getByLabel('確認コード', { exact: true }).fill(code);
      await page.getByLabel('新しいパスワード', { exact: true }).fill(replacement);
      await page.getByLabel('新しいパスワード（確認）', { exact: true }).fill(replacement);
      await page.getByRole('button', { name: 'パスワードを変更する' }).click();
      await expect(page).toHaveURL(/\/login/, { timeout: 30_000 });

      expect((await postLogin(request, origin, member.email, member.password)).status(), '古いパスワードのログイン').toBe(401);
      expect((await postLogin(request, origin, member.email, replacement)).status(), '新しいパスワードのログイン').toBe(200);
    });

    test(`FR-AUTH-006-AC-07 ${viewport.name}: パスワードを持たない会員にも、段階1に再設定への固定の案内が出てリンクが再設定の申請に着く`, async ({ page }) => {
      test.setTimeout(120_000);
      const member = await createGoogleOnlyMember('google-screen');
      await loginAsMember(page, member, uniqueSourceIp());

      await page.goto('/account/password');
      await expect(
        page.getByText('Google でログインしていてパスワードを設定していない場合は、先に'),
        'Google だけで登録した会員への案内（誰にでも出る固定の文）',
      ).toBeVisible({ timeout: 30_000 });
      await page.getByRole('link', { name: 'パスワードの再設定' }).click();
      await expect(page).toHaveURL(/\/auth\/password-reset/);
    });
  });
}

// ---- 窓口の試験（desktop） ----

for (const viewport of apiOnlyViewports) {
  test.describe(`FR-ACCOUNT-046 password change API (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`FR-AUTH-006-AC-02 ${viewport.name}: 正しい現行パスワード → メールのコード → 新しいパスワードで 200。古いパスワードは 401、新しいパスワードで入り直せる`, async ({ page, request, baseURL }) => {
      test.setTimeout(120_000);
      const origin = originOf(baseURL);
      const member = await createMember('api-change');
      const sourceIp = uniqueSourceIp();
      await loginAsMember(page, member, sourceIp);

      const code = await startAndReadCode(page, origin, member, sourceIp);
      const replacement = newPassword();
      const confirmed = await postChange(page, origin, CONFIRM_PATH, { code, new_password: replacement }, sourceIp);
      expect(confirmed.status(), 'confirm の status').toBe(200);
      expect(await jsonOf(confirmed), 'confirm の本文').toEqual({ ok: true });

      expect((await postLogin(request, origin, member.email, member.password)).status(), '古いパスワードのログイン').toBe(401);
      expect((await postLogin(request, origin, member.email, replacement)).status(), '新しいパスワードのログイン').toBe(200);
    });

    test(`FR-AUTH-006-AC-03 ${viewport.name}: 現行パスワードが違うと 401 でコードのメールが届かず、監査に failure と current_password_invalid が残る`, async ({ page, baseURL }) => {
      test.setTimeout(120_000);
      const origin = originOf(baseURL);
      const member = await createMember('api-wrong-current');
      const sourceIp = uniqueSourceIp();
      await loginAsMember(page, member, sourceIp);

      const previousIds = await mailIdsOf(member.email);
      const wrong = `Wrong-${randomBytes(10).toString('hex')}-Pw!`;
      const response = await postChange(page, origin, START_PATH, { current_password: wrong }, sourceIp);
      expect(response.status(), 'start の status').toBe(401);
      expect(await jsonOf(response), 'start の本文（残りの回数を言わない）').toEqual({ error: CURRENT_INVALID_MESSAGE });
      expect(await countNewMails(member.email, previousIds, CODE_MAIL_SUBJECT), 'コードのメールの数').toBe(0);

      const rows = await auditRowsOf(member.userId);
      expect(rows.filter((row) => row.action === 'password_change_start' && row.outcome === 'failure' && row.detail === 'current_password_invalid')).toHaveLength(1);
      expect(rows.every((row) => !row.rowText.includes(wrong)), '監査の行に送ったパスワードが無い').toBe(true);
    });

    test(`FR-AUTH-006-AC-04 ${viewport.name}: コードが違うと 401 で、パスワードは変わらない`, async ({ page, baseURL }) => {
      test.setTimeout(120_000);
      const origin = originOf(baseURL);
      const member = await createMember('api-wrong-code');
      const sourceIp = uniqueSourceIp();
      await loginAsMember(page, member, sourceIp);
      const code = await startAndReadCode(page, origin, member, sourceIp);
      const hashBefore = await passwordHashOf(member.userId);

      const response = await postChange(page, origin, CONFIRM_PATH, { code: otherCode(code), new_password: newPassword() }, sourceIp);
      expect(response.status(), 'confirm の status').toBe(401);
      expect(await jsonOf(response), 'confirm の本文').toEqual({ error: CODE_UNUSABLE_MESSAGE });
      expect(await passwordHashOf(member.userId), 'パスワードのハッシュ').toBe(hashBefore);
    });

    test(`FR-AUTH-006-AC-04 ${viewport.name}: 同じコードを5回間違えた後は、正しいコードでも 401 でパスワードは変わらない`, async ({ page, baseURL }) => {
      test.setTimeout(180_000);
      const origin = originOf(baseURL);
      const member = await createMember('api-locked');
      const sourceIp = uniqueSourceIp();
      await loginAsMember(page, member, sourceIp);
      await ensureRoomInRateLimitWindow();
      const code = await startAndReadCode(page, origin, member, sourceIp);
      const hashBefore = await passwordHashOf(member.userId);

      const wrong = otherCode(code);
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const response = await postChange(page, origin, CONFIRM_PATH, { code: wrong, new_password: newPassword() }, sourceIp);
        expect(response.status(), `${attempt}回目の誤りの status`).toBe(401);
      }
      // 本人ごとの枠（confirm は10分に5回）を使い切っているので、枠を消して「使えなくなった」ことだけを見る
      await resetUserRateLimit(member.userId);
      const afterLock = await postChange(page, origin, CONFIRM_PATH, { code, new_password: newPassword() }, sourceIp);
      expect(afterLock.status(), '5回間違えた後の正しいコードの status').toBe(401);
      expect(await jsonOf(afterLock), '本文は誤りのコードと同じ文').toEqual({ error: CODE_UNUSABLE_MESSAGE });
      expect(await passwordHashOf(member.userId), 'パスワードのハッシュ').toBe(hashBefore);
    });

    test(`FR-AUTH-006-AC-04 ${viewport.name}: コードを送り直すと前のコードは使えず、新しいコードで変わる`, async ({ page, baseURL }) => {
      test.setTimeout(120_000);
      const origin = originOf(baseURL);
      const member = await createMember('api-resend');
      const sourceIp = uniqueSourceIp();
      await loginAsMember(page, member, sourceIp);
      const firstCode = await startAndReadCode(page, origin, member, sourceIp);
      const secondCode = await startAndReadCode(page, origin, member, sourceIp);
      expect(secondCode, '送り直したコードは前と違う（準備）').not.toBe(firstCode);

      const oldTry = await postChange(page, origin, CONFIRM_PATH, { code: firstCode, new_password: newPassword() }, sourceIp);
      expect(oldTry.status(), '前のコードの status').toBe(401);
      const newTry = await postChange(page, origin, CONFIRM_PATH, { code: secondCode, new_password: newPassword() }, sourceIp);
      expect(newTry.status(), '新しいコードの status').toBe(200);
    });

    test(`FR-AUTH-006-AC-04 ${viewport.name}: 別の session で取ったコードは使えず、その session では使える`, async ({ page, browser, baseURL }) => {
      test.setTimeout(180_000);
      const origin = originOf(baseURL);
      const member = await createMember('api-other-session');
      const ipA = uniqueSourceIp();
      const ipB = uniqueSourceIp();
      await loginAsMember(page, member, ipA);
      const codeOfA = await startAndReadCode(page, origin, member, ipA);

      // 2つ目の session は、別の端末として2回目のログインで作る。
      // GoTrue は同じメールへのコードの送信に間隔（手元は max_frequency = 1s）を求めるので、空けてから送る
      await page.waitForTimeout(1_500);
      const otherContext = await browser.newContext({ baseURL: origin, viewport: { width: viewport.width, height: viewport.height } });
      try {
        const pageB = await otherContext.newPage();
        await loginAsMember(pageB, member, ipB);
        const stolen = await postChange(pageB, origin, CONFIRM_PATH, { code: codeOfA, new_password: newPassword() }, ipB);
        expect(stolen.status(), '別の session から使ったコードの status').toBe(401);
        expect(await jsonOf(stolen), '本文は誤りのコードと同じ文').toEqual({ error: CODE_UNUSABLE_MESSAGE });
      } finally {
        await otherContext.close();
      }

      const own = await postChange(page, origin, CONFIRM_PATH, { code: codeOfA, new_password: newPassword() }, ipA);
      expect(own.status(), '取った session で使ったコードの status').toBe(200);
    });

    test(`FR-AUTH-006-AC-05 ${viewport.name}: 新しいパスワードが15文字・漏洩済みなら 400 で、コードは焼けずに同じコードで変えられる`, async ({ page, baseURL }) => {
      test.setTimeout(120_000);
      const origin = originOf(baseURL);
      const member = await createMember('api-weak');
      const sourceIp = uniqueSourceIp();
      await loginAsMember(page, member, sourceIp);
      const code = await startAndReadCode(page, origin, member, sourceIp);
      const hashBefore = await passwordHashOf(member.userId);

      expect(SHORT_PASSWORD, '送るパスワードの長さ（準備）').toHaveLength(15);
      const short = await postChange(page, origin, CONFIRM_PATH, { code, new_password: SHORT_PASSWORD }, sourceIp);
      expect(short.status(), '15文字の status').toBe(400);

      const leaked = await postChange(page, origin, CONFIRM_PATH, { code, new_password: LEAKED_PASSWORD }, sourceIp);
      expect(leaked.status(), '漏洩済みの status').toBe(400);
      const leakedText = JSON.stringify(await jsonOf(leaked));
      expect(JSON.parse(leakedText), '漏洩済みの本文').toEqual({ error: PWNED_MESSAGE });
      expect(leakedText, '応答にパスワード本体が出ない').not.toContain(LEAKED_PASSWORD);
      expect(await passwordHashOf(member.userId), 'ここまででパスワードは変わっていない').toBe(hashBefore);

      const valid = await postChange(page, origin, CONFIRM_PATH, { code, new_password: newPassword() }, sourceIp);
      expect(valid.status(), '焼けていないコードで変えた status').toBe(200);
    });

    test(`FR-AUTH-006-AC-06 ${viewport.name}: 未ログインの start・confirm は 401`, async ({ request, baseURL }) => {
      const origin = originOf(baseURL);
      const start = await request.post(new URL(START_PATH, origin).toString(), {
        headers: { origin, 'x-real-ip': uniqueSourceIp() },
        data: { current_password: newPassword() },
        maxRedirects: 0,
      });
      expect(start.status(), '未ログインの start').toBe(401);
      const confirm = await request.post(new URL(CONFIRM_PATH, origin).toString(), {
        headers: { origin, 'x-real-ip': uniqueSourceIp() },
        data: { code: '12345678', new_password: newPassword() },
        maxRedirects: 0,
      });
      expect(confirm.status(), '未ログインの confirm').toBe(401);
    });

    test(`FR-AUTH-006-AC-06 ${viewport.name}: aal1 の管理者は start が 403 で、コードのメールが届かず、監査に denied と aal2_required が残る`, async ({ page, baseURL }) => {
      test.setTimeout(120_000);
      const origin = originOf(baseURL);
      const admin = await createMember('api-admin-aal1', { admin: true });
      const sourceIp = uniqueSourceIp();
      await loginAsMember(page, admin, sourceIp);

      const previousIds = await mailIdsOf(admin.email);
      const response = await postChange(page, origin, START_PATH, { current_password: admin.password }, sourceIp);
      expect(response.status(), 'aal1 の管理者の start').toBe(403);
      expect(await countNewMails(admin.email, previousIds, CODE_MAIL_SUBJECT), 'コードのメールの数').toBe(0);
      const rows = await auditRowsOf(admin.userId);
      expect(rows.filter((row) => row.action === 'password_change_start' && row.outcome === 'denied' && row.detail === 'aal2_required')).toHaveLength(1);
    });

    test(`FR-AUTH-006-AC-07 ${viewport.name}: パスワードを持たない会員の start は、パスワードを持つ会員の誤りと同じ 401 で、コードのメールが届かない`, async ({ browser, baseURL }) => {
      test.setTimeout(180_000);
      const origin = originOf(baseURL);
      const google = await createGoogleOnlyMember('api-google');
      const holder = await createMember('api-holder');
      const wrong = `Wrong-${randomBytes(10).toString('hex')}-Pw!`;

      const contextA = await browser.newContext({ baseURL: origin });
      const contextB = await browser.newContext({ baseURL: origin });
      try {
        const googlePage = await contextA.newPage();
        const holderPage = await contextB.newPage();
        const googleIp = uniqueSourceIp();
        const holderIp = uniqueSourceIp();
        await loginAsMember(googlePage, google, googleIp);
        await loginAsMember(holderPage, holder, holderIp);

        const previousIds = await mailIdsOf(google.email);
        const googleReply = await postChange(googlePage, origin, START_PATH, { current_password: wrong }, googleIp);
        const holderReply = await postChange(holderPage, origin, START_PATH, { current_password: wrong }, holderIp);
        expect(googleReply.status(), 'パスワードを持たない会員の start').toBe(401);
        expect(holderReply.status(), 'パスワードを持つ会員の誤りの start').toBe(401);
        expect(await jsonOf(googleReply), '本文が同じ（区別がつかない）').toEqual(await jsonOf(holderReply));
        expect(await countNewMails(google.email, previousIds, CODE_MAIL_SUBJECT), 'コードのメールの数').toBe(0);
      } finally {
        await contextA.close();
        await contextB.close();
      }
    });

    test(`SEC-AUTH-034-AC-01 ${viewport.name}: 変更の後、この端末を含む全 session が失効し、古い access token・refresh token が通らず、認証の Cookie が消える`, async ({ page, request, baseURL }) => {
      test.setTimeout(120_000);
      const origin = originOf(baseURL);
      const member = await createMember('sec-revoke');
      const sourceIp = uniqueSourceIp();
      await loginAsMember(page, member, sourceIp);
      const oldAccess = await cookieValue(page, origin, 'sb-access-token');
      const oldRefresh = await cookieValue(page, origin, 'sb-refresh-token');
      expect(sessionIdOf(oldAccess), 'ログインで得た session_id（準備）').toBeTruthy();

      const code = await startAndReadCode(page, origin, member, sourceIp);
      const confirmed = await postChange(page, origin, CONFIRM_PATH, { code, new_password: newPassword() }, sourceIp);
      expect(confirmed.status(), 'confirm の status').toBe(200);

      // 応答が3つの認証 Cookie を消す（Max-Age=0 か空の値）
      const cleared = setCookieNames(confirmed, (attributes) => attributes.includes('max-age=0'));
      for (const name of AUTH_COOKIES) {
        expect(cleared.has(name), `${name} を消す Set-Cookie が付く`).toBe(true);
      }
      const remaining = (await page.context().cookies(origin)).map((cookie) => cookie.name);
      for (const name of AUTH_COOKIES) {
        expect(remaining, `${name} がこの端末に残らない`).not.toContain(name);
      }

      // 古い access token は Bearer で送っても通らない
      const me = await request.get(new URL(ME_PATH, origin).toString(), { headers: { Authorization: `Bearer ${oldAccess}` } });
      expect(await jsonOf(me), '古い access token の /api/auth/me').toMatchObject({ authenticated: false });
      // 古い refresh token では更新できない
      const refreshed = await request.post(new URL(REFRESH_PATH, origin).toString(), {
        headers: { origin, 'x-real-ip': uniqueSourceIp(), Cookie: `sb-refresh-token=${oldRefresh}` },
        failOnStatusCode: false,
        maxRedirects: 0,
      });
      expect(refreshed.status(), '古い refresh token の /api/auth/refresh').toBe(401);

      await withLocalDb(async (db) => {
        const live = await db.query('select count(*)::int as n from public.sessions where user_id = $1::uuid and revoked_at is null', [member.userId]);
        expect(live.rows[0].n, '失効していない sessions の行').toBe(0);
        const authSessions = await db.query('select count(*)::int as n from auth.sessions where user_id = $1::uuid', [member.userId]);
        expect(authSessions.rows[0].n, 'Auth 側の session の行').toBe(0);
      });
    });

    test(`SEC-AUTH-034-AC-02 ${viewport.name}: 変更の後に通知のメールがちょうど1通届き、本文にパスワードもコードも含まない`, async ({ page, baseURL }) => {
      test.setTimeout(120_000);
      const origin = originOf(baseURL);
      const member = await createMember('sec-notice');
      const sourceIp = uniqueSourceIp();
      await loginAsMember(page, member, sourceIp);
      const code = await startAndReadCode(page, origin, member, sourceIp);
      const replacement = newPassword();
      const beforeConfirm = await mailIdsOf(member.email);
      const confirmed = await postChange(page, origin, CONFIRM_PATH, { code, new_password: replacement }, sourceIp);
      expect(confirmed.status(), 'confirm の status').toBe(200);

      // 通知は応答の後で送る。件名「パスワードを変更しました」だけを数える（GoTrue の変更通知は別の件名）
      await expect
        .poll(() => countNewMails(member.email, beforeConfirm, NOTICE_MAIL_SUBJECT), { message: '通知のメールが届かない', timeout: 15_000 })
        .toBe(1);
      const notice = (await listMails(member.email)).find((mail) => !beforeConfirm.has(mail.ID) && mail.Subject === NOTICE_MAIL_SUBJECT);
      const text = await mailText(notice!.ID);
      expect(text, '通知の本文に新しいパスワードが無い').not.toContain(replacement);
      expect(text, '通知の本文に古いパスワードが無い').not.toContain(member.password);
      expect(text, '通知の本文にコードが無い').not.toContain(code);
      // 2通目が遅れて届かない
      expect(await countNewMails(member.email, beforeConfirm, NOTICE_MAIL_SUBJECT), '通知のメールの数').toBe(1);
    });

    test(`SEC-AUTH-034-AC-03 ${viewport.name}: 同じ会員の start を6回送ると6回目が 429 で、送り元を変えても 429。confirm も同じ`, async ({ page, baseURL }) => {
      test.setTimeout(120_000);
      const origin = originOf(baseURL);
      const member = await createMember('sec-limit');
      const sourceIp = uniqueSourceIp();
      await loginAsMember(page, member, sourceIp);
      await ensureRoomInRateLimitWindow();

      // 本文の形の誤り（400）でも本人ごとの枠は数える。GoTrue へ現行パスワードの確かめを撃たずに回数だけを使う
      for (const path of [START_PATH, CONFIRM_PATH] as const) {
        for (let attempt = 1; attempt <= 5; attempt += 1) {
          const response = await postChange(page, origin, path, {}, sourceIp);
          expect(response.status(), `${path} の ${attempt} 回目`).toBe(400);
        }
        const sixth = await postChange(page, origin, path, {}, sourceIp);
        expect(sixth.status(), `${path} の6回目`).toBe(429);
        expect(sixth.headers()['retry-after'], `${path} の Retry-After`).toBeTruthy();
        const otherIp = await postChange(page, origin, path, {}, uniqueSourceIp());
        expect(otherIp.status(), `${path} を別の送り元から送っても`).toBe(429);
      }
    });

    test(`SEC-AUTH-034-AC-04 ${viewport.name}: 監査の行（password_change_start・password_change_confirm）に固定の符号だけが残り、パスワード・コード・トークン・session_id が現れない`, async ({ page, baseURL }) => {
      test.setTimeout(180_000);
      const origin = originOf(baseURL);
      const member = await createMember('sec-audit');
      const sourceIp = uniqueSourceIp();
      await loginAsMember(page, member, sourceIp);
      const accessToken = await cookieValue(page, origin, 'sb-access-token');
      const refreshToken = await cookieValue(page, origin, 'sb-refresh-token');
      const authSessionId = sessionIdOf(accessToken);
      await ensureRoomInRateLimitWindow();

      const wrongCurrent = `Wrong-${randomBytes(10).toString('hex')}-Pw!`;
      expect((await postChange(page, origin, START_PATH, { current_password: wrongCurrent }, sourceIp)).status()).toBe(401);
      const code = await startAndReadCode(page, origin, member, sourceIp);
      const wrongNew = newPassword();
      expect((await postChange(page, origin, CONFIRM_PATH, { code: otherCode(code), new_password: wrongNew }, sourceIp)).status()).toBe(401);
      const replacement = newPassword();
      expect((await postChange(page, origin, CONFIRM_PATH, { code, new_password: replacement }, sourceIp)).status()).toBe(200);

      const rows = await auditRowsOf(member.userId);
      // HaveIBeenPwned に届かない環境では confirm のたびに pwned_check_unavailable:<理由> の行が増える（外部の都合）。
      // 順の比べからはその行だけを除き、秘密が現れないことの確かめ（下）は全行で行う。
      const triples = rows
        .filter((row) => !String(row.detail ?? '').startsWith('pwned_check_unavailable:'))
        .map((row) => `${row.action}|${row.outcome}|${row.detail}`);
      expect(triples).toEqual([
        'password_change_start|failure|current_password_invalid',
        'password_change_start|success|code_sent',
        'password_change_confirm|failure|code_invalid',
        'password_change_confirm|success|password_changed',
      ]);
      // 行の全部の列を文字列にして、送った値が1つも現れないことを真偽で比べる（値そのものは失敗の文面に出さない）
      const secrets = [member.password, wrongCurrent, wrongNew, replacement, code, accessToken, refreshToken, authSessionId];
      for (const row of rows) {
        expect(secrets.some((secret) => row.rowText.includes(secret)), '監査の行に秘密の値が入っていないこと').toBe(false);
      }
    });
  });
}
