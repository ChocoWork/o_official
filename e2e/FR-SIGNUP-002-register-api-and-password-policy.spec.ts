/**
 * FR-SIGNUP-002 会員登録の窓口（POST /api/auth/register）の、パスワードの決まり・応答の同一性・回数の制限・管理の鍵の扱い
 * 対応: FREQ-323-AC-01・FREQ-323-AC-03・SEC-AUTH-014-AC-01・SEC-AUTH-016-AC-01・SEC-AUTH-016-AC-03・SEC-AUTH-017-AC-01・SEC-AUTH-029-AC-01
 *
 * 画面は使わず、本番ビルドの窓口へ request で直に送る（HTTP だけなので画面の幅は結果を変えない）。
 * 送り元は試験ごとに違う x-real-ip（E2E のアプリが CLIENT_IP_HEADER で信頼する見出し）にして、IP 単位の回数の制限（20 回／時）を他の試験と分ける。
 * Turnstile は手元の公式の常に通る鍵（.env.local）なので、トークンは適当な文字列でよい。
 *
 * 前提:
 * - 漏洩の照合（FREQ-323-AC-01・SEC-AUTH-014-AC-01）は本物の HaveIBeenPwned（api.pwnedpasswords.com）へ出る。
 *   届かないと窓口は fail-open で通すので、この 2 件は届かない環境では 400 にならず失敗する（網の前提）。
 * - FREQ-323-AC-01 の「外へ出る URL にパスワード本体と SHA-1 の 6 文字目以降が無い」半分は、サーバーから外への
 *   通信なので試験からは見えない。ここでは見えるところ（400・応答に本体が無い・利用者が作られない）だけを確かめる。
 * - SEC-AUTH-016-AC-03 は宛先単位の枠（5 回／時。Turnstile と漏洩の確かめの後に数える）で 429 になることを確かめる。
 *   SEC-AUTH-017-AC-01 は管理の鍵（x-admin-token）を付けても公開の登録と同じに扱われる（管理の枝は無い）ことを確かめる。
 * 手元の Supabase にだけ書く。作った利用者は終わりに GoTrue の管理の窓口で消す。
 */
import { randomBytes, randomInt } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';
import { mailsTo, withLocalDb } from './order-email-test-utils';

const REGISTER_PATH = '/api/auth/register';
const APP_ORIGIN = 'http://localhost:3000';
const TURNSTILE_TOKEN = 'e2e-dummy-turnstile-token';

/** 昔の管理の鍵の代わりに付ける適当な値。窓口は管理の鍵を読まないので、値が何でも公開の登録と同じに扱われる */
const FORMER_ADMIN_TOKEN = 'e2e-former-admin-token-0123456789';

/** HaveIBeenPwned に載っている 16 文字以上の固定の文字列（出現回数は 2026-10-25 に確かめた） */
const LEAKED_PASSWORD_A = '1234567890123456';
const LEAKED_PASSWORD_B = 'passwordpassword';

/** lib/pwned-password.ts の PWNED_PASSWORD_MESSAGE と同じ文 */
const PWNED_MESSAGE = 'このパスワードは過去の情報流出で公開されています。別のパスワードを設定してください。';

/** 宛先単位の上限を超えるまでに送る回数の上限（IP 単位の 20 回／時には、送り元を毎回変えて当たらない） */
const MAX_REGISTER_ATTEMPTS_PER_ADDRESS = 40;

const usedForwardedFor = new Set<string>();
const trackedEmails = new Set<string>();

/** 走らせるたび・試験ごとに違う x-real-ip の値（ベンチマーク用の 198.18.0.0/15 から乱数で選ぶ） */
function uniqueForwardedFor(): string {
  for (;;) {
    const ip = `198.18.${randomInt(0, 256)}.${randomInt(1, 255)}`;
    if (!usedForwardedFor.has(ip)) {
      usedForwardedFor.add(ip);
      return ip;
    }
  }
}

function uniqueEmail(label: string): string {
  const email = `e2e-signup002-${label}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}@example.com`;
  trackedEmails.add(email);
  return email;
}

/** 英小文字だけ（数字も記号も含まない）の乱数のパスワード。漏洩の一覧に載らない長さと並びにする */
function lettersOnlyPassword(length: number): string {
  let out = '';
  while (out.length < length) out += String.fromCharCode(97 + randomInt(0, 26));
  return out;
}

type RegisterOptions = { password: string; forwardedFor?: string; extraHeaders?: Record<string, string> };

function postRegister(request: APIRequestContext, email: string, options: RegisterOptions): Promise<APIResponse> {
  return request.post(REGISTER_PATH, {
    headers: {
      origin: APP_ORIGIN,
      'x-real-ip': options.forwardedFor ?? uniqueForwardedFor(),
      ...(options.extraHeaders ?? {}),
    },
    data: { email, password: options.password, turnstileToken: TURNSTILE_TOKEN },
    failOnStatusCode: false,
  });
}

// ---- 手元の Supabase ----

function localAuth(): { url: string; serviceKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error('手元の Supabase の住所と鍵が環境に無い');
  if (!isLocalUrl(url)) throw new Error('手元の Supabase 以外には利用者を作らない');
  return { url, serviceKey };
}

async function authUserCount(email: string): Promise<number> {
  return withLocalDb(async (db) =>
    Number((await db.query('select count(*)::int as n from auth.users where lower(email) = lower($1)', [email])).rows[0].n),
  );
}

/** 登録済みの利用者（メール確認済み）を GoTrue の管理の窓口で作る */
async function createConfirmedUser(email: string, password: string): Promise<void> {
  const { url, serviceKey } = localAuth();
  const response = await fetch(`${url}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (response.status !== 200) throw new Error(`前提: 手元の GoTrue で利用者を作れること（status ${response.status}）`);
}

async function removeTrackedUsers(): Promise<void> {
  const emails = [...trackedEmails];
  if (emails.length === 0) return;
  const { url, serviceKey } = localAuth();
  const ids = await withLocalDb(async (db) =>
    (await db.query('select id from auth.users where email = any($1::text[])', [emails])).rows.map((row) => row.id as string),
  );
  for (const id of ids) {
    const response = await fetch(`${url}/auth/v1/admin/users/${id}`, {
      method: 'DELETE',
      headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` },
    });
    expect(response.status, `後始末: 利用者 ${id} を消せること`).toBe(200);
  }
  trackedEmails.clear();
}

test.describe('FR-SIGNUP-002 register API and password policy', () => {
  test.afterAll(async () => {
    await removeTrackedUsers();
  });

  // FREQ-323-AC-01（会員登録の半分）
  test('FREQ-323-AC-01 a leaked password gets 400 and no account is created', async ({ request }) => {
    const email = uniqueEmail('leaked-a');
    const response = await postRegister(request, email, { password: LEAKED_PASSWORD_A });

    // 漏洩リストに載っているパスワードで会員登録すると 400 が返る
    expect(response.status()).toBe(400);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: PWNED_MESSAGE });
    // 応答にもパスワード本体が出ない
    expect(text).not.toContain(LEAKED_PASSWORD_A);
    // アカウントが作成されない
    expect(await authUserCount(email)).toBe(0);
  });

  // FREQ-323-AC-03
  test('FREQ-323-AC-03 15 characters are refused, 16 pass, and letters-only passwords pass', async ({ request }) => {
    // 15 文字は拒否される（アカウントも作られない）
    const shortEmail = uniqueEmail('len15');
    const short = await postRegister(request, shortEmail, { password: lettersOnlyPassword(15) });
    expect(short.status()).toBe(400);
    const shortBody = (await short.json()) as { code?: string; detail?: Array<{ path: string; message: string }> };
    expect(shortBody.code).toBe('validation_error');
    expect(shortBody.detail?.some((issue) => issue.path === 'password')).toBe(true);
    expect(await authUserCount(shortEmail)).toBe(0);

    // 16 文字は受理される。英小文字だけで、記号も数字も無い。
    // 手元の設定は本番と同じ Confirm email 有効（波 6 で切り替えた）なので、受理は 202
    const exactEmail = uniqueEmail('len16');
    const exact = await postRegister(request, exactEmail, { password: lettersOnlyPassword(16) });
    expect(exact.status()).toBe(202);
    expect(await authUserCount(exactEmail)).toBe(1);

    // 記号や数字を含まない 16 文字以上（24 文字）も受理される
    const longEmail = uniqueEmail('len24');
    const long = await postRegister(request, longEmail, { password: lettersOnlyPassword(24) });
    expect(long.status()).toBe(202);
    expect(await authUserCount(longEmail)).toBe(1);
  });

  // SEC-AUTH-014-AC-01
  test('SEC-AUTH-014-AC-01 registering with a leaked password returns 400 and creates no user', async ({ request }) => {
    const email = uniqueEmail('leaked-b');
    const response = await postRegister(request, email, { password: LEAKED_PASSWORD_B });

    // 漏洩ありと答えるパスワードで登録すると 400 になる
    expect(response.status()).toBe(400);
    expect(((await response.json()) as { error?: string }).error).toBe(PWNED_MESSAGE);
    // 利用者ができない
    expect(await authUserCount(email)).toBe(0);
  });

  // SEC-AUTH-016-AC-01
  test('SEC-AUTH-016-AC-01 registered and unregistered emails get the same status and body', async ({ request }) => {
    const registeredEmail = uniqueEmail('enum-registered');
    const unregisteredEmail = uniqueEmail('enum-unregistered');
    await createConfirmedUser(registeredEmail, lettersOnlyPassword(24));
    expect(await authUserCount(registeredEmail)).toBe(1);
    expect(await authUserCount(unregisteredEmail)).toBe(0);

    const registered = await postRegister(request, registeredEmail, { password: lettersOnlyPassword(24) });
    const unregistered = await postRegister(request, unregisteredEmail, { password: lettersOnlyPassword(24) });

    // 状態の番号が同じ
    expect(registered.status()).toBe(unregistered.status());
    // 本文が同じ
    expect(await registered.text()).toBe(await unregistered.text());
    // 同じ番号は、公開の登録の受け付けの 202（409 でも Turnstile の 403 でもない）
    expect(unregistered.status()).toBe(202);
  });

  // SEC-AUTH-016-AC-03
  test('SEC-AUTH-016-AC-03 repeated registration for one registered address hits a per-address limit with 429 and no notice mail', async ({ request }) => {
    const email = uniqueEmail('per-address');
    await createConfirmedUser(email, lettersOnlyPassword(24));
    const password = lettersOnlyPassword(24);

    // 送り元の IP を毎回変えて、同じ登録済みのメールで続ける
    const statuses: number[] = [];
    for (let attempt = 0; attempt < MAX_REGISTER_ATTEMPTS_PER_ADDRESS; attempt += 1) {
      const response = await postRegister(request, email, { password, forwardedFor: uniqueForwardedFor() });
      statuses.push(response.status());
      if (response.status() === 429) break;
    }

    // 最初は公開の登録として受け付けられ、上限を超えた分が 429 になる
    expect(statuses[0]).toBe(202);
    expect(statuses, '宛先単位の上限を超えた分が 429 になること').toContain(429);
    // 429 になった分では通知のメールが送られない（受け付けた 202 の分だけ届く）
    const accepted = statuses.filter((status) => status === 202).length;
    await expect
      .poll(async () => (await mailsTo(request, email)).length, { timeout: 15_000 })
      .toBe(accepted);
  });

  // SEC-AUTH-017-AC-01
  test('SEC-AUTH-017-AC-01 an admin token with a registered email does not give 409', async ({ request }) => {
    const email = uniqueEmail('admin-token');
    await createConfirmedUser(email, lettersOnlyPassword(24));
    // 窓口は管理の鍵を読まない（枝を削除した）ので、値は何でもよい
    const adminToken = FORMER_ADMIN_TOKEN;

    const response = await postRegister(request, email, {
      password: lettersOnlyPassword(24),
      extraHeaders: { 'x-admin-token': adminToken },
    });

    // 409 にならない
    expect(response.status()).not.toBe(409);
    // 公開の登録と同じ 202、または Turnstile の 403 になる
    expect([202, 403]).toContain(response.status());
  });

  // SEC-AUTH-029-AC-01
  test('SEC-AUTH-029-AC-01 registering an unregistered email returns 202 without an access_token', async ({ request }) => {
    const email = uniqueEmail('confirm-email');
    const response = await postRegister(request, email, { password: lettersOnlyPassword(24) });

    // 202 が返り（Confirm email が ON なら 201 の即ログインにならない）
    expect(response.status()).toBe(202);
    // 本文に access_token が無い
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('access_token');
  });
});
