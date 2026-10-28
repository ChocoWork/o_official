/**
 * FR-LOGIN-035 ログインの回数の制限・Turnstile・監査と、トークン更新の送り元の数え方
 * 対応: SEC-AUTH-001-AC-01 / SEC-AUTH-001-AC-02 / FREQ-335-AC-04 / SEC-AUTH-030-AC-02 / SEC-AUTH-013-AC-01
 *
 * 道具立て
 * - Playwright の request（HTTP）で /api/auth/login と /api/auth/refresh を直に叩く。画面は見ない。
 *   HTTP の試験なので結果は画面の幅で変わらない。1つの幅（desktop）だけ流す（DB の書き込みと回数の制限の枠を3倍にしない）。
 * - 回数の制限の枠は「送り元（x-real-ip。E2E のアプリは固定の環境 CLIENT_IP_HEADER で信頼し、x-forwarded-for は読まない）× 10分（時計の10分きざみ）」、メールの枠は「メール × 10分」で数える。
 *   試験ごと・要求ごとに新しい送り元とメールを使い、ほかの試験・ほかの spec と枠を共有しない。
 *   10分の枠が切り替わる間際に始めると途中で数えが0に戻るので、切れ目の手前に近いときだけ、次の枠に入るのを条件で待つ。
 * - Turnstile は .env.local の公式のテスト鍵（常に通る）で Cloudflare の siteverify に問い合わせる。
 *   落ちる送信は「トークンを付けない」で作る（常に通る鍵は、付けたトークンの中身を見ないため）。
 * - FREQ-335-AC-04 は本物のパスワードで通す必要があるので、手元の Supabase に既知のパスワードの会員を作り、試験の後に消す。
 *   通すと手元のメール受け（Mailpit）に確認コードが届く。
 * - SEC-AUTH-030-AC-02 は監査ログ（public.audit_logs）を手元の DB の接続で直に読む。
 * - SEC-AUTH-013-AC-01 は、1 試験で固定の x-real-ip を付け、偽れる x-forwarded-for だけを毎回変えて 31 回送り、31 回目が 429 になることを見る
 *   （2026-10-28、波 4 で getClientIp が x-forwarded-for を読まなくなり満たす）。x-real-ip まで毎回変えると枠を逃れるので変えない。
 */
import { randomBytes, randomInt } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';
import { withLocalDb } from './order-email-test-utils';

// 2FA の Cookie（パスワードを通った印）が通信記録に残るので、記録は取らない。
test.use({ trace: 'off' });

// 窓口を HTTP で叩く試験で、画面の幅で結果が変わらない。幅ごとに流すと DB の書き込みと回数の制限の枠が3倍になるので、1つの幅（desktop）だけ流す。
const viewports = [{ name: 'desktop', width: 1280, height: 800 }] as const;

const LOGIN_PATH = '/api/auth/login';
const REFRESH_PATH = '/api/auth/refresh';
/** Cloudflare の公式のテスト鍵は、どんな中身のトークンでも通す */
const VALID_TURNSTILE_TOKEN = 'test-turnstile-token';
/** 16 文字以上（パスワードの最小）で、どの会員のパスワードにもならない値 */
const wrongPassword = (): string => `Wrong-${randomBytes(10).toString('hex')}-Pw!`;

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
/** 枠の切れ目までこれより短いと、数回の送信の途中で枠が切り替わりうるので、切り替わるのを待つ */
const MIN_ROOM_IN_WINDOW_MS = 20_000;

/** 試験ごと・要求ごとに違う送り元（ベンチマーク用の 198.18.0.0/15 から乱数で選ぶ） */
const usedForwardedFor = new Set<string>();
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
  return `e2e-login-${label}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}@example.com`;
}

/** 時計の10分の枠の切れ目が近いときだけ、次の枠に入るまで条件で待つ（固定の sleep はしない） */
async function ensureRoomInRateLimitWindow(): Promise<void> {
  const remaining = RATE_LIMIT_WINDOW_MS - (Date.now() % RATE_LIMIT_WINDOW_MS);
  if (remaining >= MIN_ROOM_IN_WINDOW_MS) {
    return;
  }
  const nextWindowStart = Date.now() + remaining;
  await expect
    .poll(() => Date.now() >= nextWindowStart, {
      message: '10分の枠が切り替わるのを待つ',
      timeout: MIN_ROOM_IN_WINDOW_MS + 15_000,
      intervals: [250],
    })
    .toBe(true);
}

/** state を変える /api/* の POST は Origin か Referer が無いと proxy が 403 で止める。request フィクスチャは付けないので自分で付ける */
function originOf(baseURL: string | undefined): string {
  return new URL(baseURL ?? 'http://localhost:3000').origin;
}

function postLogin(
  request: APIRequestContext,
  body: { email: string; password: string; turnstileToken?: string },
  forwardedFor: string,
  origin: string,
): Promise<APIResponse> {
  return request.post(LOGIN_PATH, {
    headers: { 'x-real-ip': forwardedFor, origin },
    data: body,
    maxRedirects: 0,
  });
}

function localAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !isLocalUrl(url)) {
    throw new Error('会員を作れるのは手元の Supabase だけ');
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** sb-login-2fa-session の Set-Cookie から Max-Age の値だけを取り出す（Cookie の値は失敗の報告に載せない） */
function twoFactorCookieMaxAge(response: APIResponse): string | null {
  const setCookie = response.headersArray().find(
    (header) => header.name.toLowerCase() === 'set-cookie' && header.value.startsWith('sb-login-2fa-session='),
  );
  if (!setCookie) {
    return null;
  }
  const attributes = setCookie.value.split(';').slice(1).map((part) => part.trim());
  const maxAge = attributes.find((part) => part.toLowerCase().startsWith('max-age='));
  return maxAge ? maxAge.slice('max-age='.length) : null;
}

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-035 login throttling, Turnstile and audit (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`SEC-AUTH-001-AC-01 ${viewport.name}: 同じメールに600秒の中で6回送ると、6回目が 429 と Retry-After を返す`, async ({ request, baseURL }) => {
      const origin = originOf(baseURL);
      await ensureRoomInRateLimitWindow();
      const email = uniqueEmail('throttle');

      // 送り元は毎回変える。メールの枠は送り元に関係なく数えられる。
      const statuses: number[] = [];
      let sixth: APIResponse | null = null;
      for (let attempt = 1; attempt <= 6; attempt += 1) {
        const response = await postLogin(
          request,
          { email, password: wrongPassword(), turnstileToken: VALID_TURNSTILE_TOKEN },
          uniqueForwardedFor(),
          origin,
        );
        statuses.push(response.status());
        if (attempt === 6) {
          sixth = response;
        }
      }

      // 1〜5回目は誤ったパスワードとして断られるだけで、回数の制限には当たらない
      expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
      // 6回目が 429 で、Retry-After を返す
      expect(statuses[5]).toBe(429);
      const retryAfter = sixth?.headers()['retry-after'];
      expect(retryAfter, '6回目の応答に Retry-After があること').toBeTruthy();
      expect(Number(retryAfter)).toBeGreaterThan(0);
    });

    test(`SEC-AUTH-001-AC-02 ${viewport.name}: Turnstile に落ちる送信を5回した後でも、正しい Turnstile の送信は 429 にならない`, async ({ request, baseURL }) => {
      const origin = originOf(baseURL);
      await ensureRoomInRateLimitWindow();
      const email = uniqueEmail('turnstile');

      // Turnstile に落ちる送信（トークン無し）を5回。メールの枠は減らないので、どれも 403 で断られる
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const failed = await postLogin(request, { email, password: wrongPassword() }, uniqueForwardedFor(), origin);
        expect(failed.status(), `Turnstile に落ちる ${attempt} 回目`).toBe(403);
        // proxy の「Forbidden origin」ではなく、login ルート自身の Turnstile 失敗であること
        expect(await failed.json(), `Turnstile に落ちる ${attempt} 回目の本文`).toEqual({ error: 'Bot detection failed' });
      }

      // 正しい Turnstile の送信。メールの枠が減っていれば、ここで 429 になる
      const valid = await postLogin(
        request,
        { email, password: wrongPassword(), turnstileToken: VALID_TURNSTILE_TOKEN },
        uniqueForwardedFor(),
        origin,
      );
      expect(valid.status()).not.toBe(429);
      // パスワードの確かめまで進み、誤りとして断られる
      expect(valid.status()).toBe(401);
    });

    test(`FREQ-335-AC-04 ${viewport.name}: POST /api/auth/login が発行する sb-login-2fa-session の Max-Age が 300 である`, async ({ request, baseURL }) => {
      const origin = originOf(baseURL);
      const admin = localAdmin();
      const email = uniqueEmail('twofa-ttl');
      const password = `E2e-${randomBytes(12).toString('hex')}!`;
      const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (created.error || !created.data.user) {
        throw new Error(`手元の会員を作れない（status: ${created.error?.status ?? '不明'}）`);
      }
      const userId = created.data.user.id;

      try {
        const response = await postLogin(
          request,
          { email, password, turnstileToken: VALID_TURNSTILE_TOKEN },
          uniqueForwardedFor(),
          origin,
        );

        // パスワードを通ってメールの確認コードの段へ進み、2FA の Cookie が出る
        expect(response.status()).toBe(200);
        expect(twoFactorCookieMaxAge(response), 'sb-login-2fa-session の Max-Age').toBe('300');
      } finally {
        await admin.auth.admin.deleteUser(userId).catch(() => undefined);
      }
    });

    test(`SEC-AUTH-030-AC-02 ${viewport.name}: 誤ったパスワードでログインした後に、audit_logs に失敗の行が1つ増え、その行に送ったパスワードの字が無い`, async ({ request, baseURL }) => {
      const origin = originOf(baseURL);
      await ensureRoomInRateLimitWindow();
      const email = uniqueEmail('audit');
      const password = wrongPassword();
      const failureRows = `select to_jsonb(a)::text as row_text from public.audit_logs a
        where a.action = 'login' and a.outcome = 'failure' and a.actor_email = $1`;

      const before = await withLocalDb(async (db) => (await db.query(failureRows, [email])).rows.length);
      expect(before).toBe(0);

      const response = await postLogin(
        request,
        { email, password, turnstileToken: VALID_TURNSTILE_TOKEN },
        uniqueForwardedFor(),
        origin,
      );
      expect(response.status()).toBe(401);

      const rows = await withLocalDb(async (db) => (await db.query(failureRows, [email])).rows);
      // 失敗の行が1つ増える
      expect(rows).toHaveLength(before + 1);
      // その行（全部の列）に、送ったパスワードの字が無い
      const rowText = String((rows[0] as { row_text: string }).row_text);
      expect(rowText.includes(password), '監査の行にパスワードが入っていないこと').toBe(false);
    });

    test(`SEC-AUTH-013-AC-01 ${viewport.name}: x-forwarded-for を毎回変えても、固定の x-real-ip で /api/auth/refresh に31回送ると、31回目が 429 になる`, async ({ request, baseURL }) => {
      const origin = originOf(baseURL);
      // 信頼する見出し（x-real-ip。E2E のアプリは CLIENT_IP_HEADER で信頼する）は 1 試験で 1 つに固定し、偽れる x-forwarded-for だけを毎回変える。
      // x-real-ip まで毎回変えると枠を逃れて 429 にならず、付けないと全試験が共有する「送り元なし」の枠を使い切って他の試験を 10 分間 429 にする。
      const fixedRealIp = uniqueForwardedFor();
      // 31回の途中で10分の枠が切り替わると数えが0に戻るので、切れ目が近いときは次の枠に入るのを待つ
      await ensureRoomInRateLimitWindow();

      let last: APIResponse | null = null;
      for (let attempt = 1; attempt <= 31; attempt += 1) {
        last = await request.post(REFRESH_PATH, {
          headers: { 'x-real-ip': fixedRealIp, 'x-forwarded-for': uniqueForwardedFor(), origin },
          maxRedirects: 0,
        });
      }

      expect(last?.status(), '送り元を毎回変えた31回目の状態').toBe(429);
    });
  });
}
