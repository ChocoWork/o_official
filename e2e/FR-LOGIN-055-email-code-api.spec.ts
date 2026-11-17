/**
 * FR-LOGIN-055 メールのコードのログイン・新規の窓口（POST /api/auth/email-code/start・verify）
 * 対応: FR-AUTH-023-AC-01〜06（守りは SEC-AUTH-048・SEC-AUTH-049）
 *
 * 手元のアプリ（本番ビルド）・手元の Supabase・手元の Mailpit だけで流す HTTP の試験。窓口を `request` で直に呼ぶ（画面は開かない。幅で結果は変わらないが、3つの幅でくり返す）。
 * 要求ごとに別の x-real-ip と origin を付ける（回数の枠を使い切らないため・proxy の Origin の確かめ）。Turnstile は E2E の公式のテスト鍵（常に通る）。
 * 確定の総当たりの枠は「数えてから確かめる」ので、枠の上限 5 を超えた6回目で 429 になる。
 */
import { randomBytes, randomInt } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import { createTestMember, readLatestCode } from './member-session-helpers';
import { setLoginTwoFactorCookie } from './auth-2fa-test-utils';
import { withLocalDb } from './order-email-test-utils';
import { provisionStaff } from '../scripts/e2e/passkey-staff';

// 保留の Cookie とコードが通信記録に残るので、記録は取らない。
test.use({ trace: 'off' });

const ORIGIN = 'http://localhost:3000';
const VALID_TURNSTILE_TOKEN = 'test-turnstile-token';
const PENDING_COOKIE = 'sb-email-code-session';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

/** 試験ごとに別の送り元（回数の枠を共有しない） */
function uniqueIp(): string {
  return `198.18.${randomInt(0, 256)}.${randomInt(1, 255)}`;
}

/**
 * 回数の制限の枠は、UTC の epoch を 10 分（600 秒）で切った固定の窓で数える（enforceRateLimit の bucket）。
 * 数える途中で窓の境を越えると、回数が2つの窓に分かれて 6 回目が 429 にならない。
 * 窓の残りが 10 秒より短い時は、次の窓が始まるまで待ってから数え始める。
 */
async function waitForFreshRateWindow(): Promise<void> {
  const windowMs = 600_000;
  const remaining = windowMs - (Date.now() % windowMs);
  if (remaining < 10_000) {
    await new Promise((resolve) => setTimeout(resolve, remaining + 500));
  }
}

function uniqueEmail(label: string): string {
  return `e2e-code-${label}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}@example.com`;
}

function startCode(request: APIRequestContext, email: string, ip: string): Promise<APIResponse> {
  return request.post('/api/auth/email-code/start', {
    headers: { origin: ORIGIN, 'x-real-ip': ip },
    data: { email, turnstileToken: VALID_TURNSTILE_TOKEN },
    maxRedirects: 0,
  });
}

function verifyCode(request: APIRequestContext, code: string, ip: string): Promise<APIResponse> {
  return request.post('/api/auth/email-code/verify', {
    headers: { origin: ORIGIN, 'x-real-ip': ip },
    data: { code },
    maxRedirects: 0,
  });
}

/** Set-Cookie の「名前と属性の名前」だけを取り出す（値は比べない） */
function cookieShape(response: APIResponse): string[] {
  return response
    .headersArray()
    .filter((header) => header.name.toLowerCase() === 'set-cookie')
    .map((header) => {
      const [pair, ...attrs] = header.value.split(';').map((part) => part.trim());
      const names = attrs.map((attr) => attr.replace(/=.*/, '').toLowerCase()).filter((name) => name !== 'expires' && name !== 'max-age');
      return `${pair.split('=')[0]}:${names.sort().join(',')}`;
    })
    .sort();
}

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-055 email code API (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`FR-AUTH-023-AC-01 ${viewport.name}: 未登録のアドレスで始め、メールのコードで確定するとログインでき、/api/auth/me が本人を返す`, async ({ request }) => {
      const email = uniqueEmail('new');
      const ip = uniqueIp();
      const started = await startCode(request, email, ip);
      expect(started.status()).toBe(202);
      expect(await started.json()).toEqual({
        step: 'code',
        message: '確認コードを送信しました。メールに届いたコードを入力してください。',
      });
      const code = await readLatestCode(email, new Set());
      const verified = await verifyCode(request, code, ip);
      expect(verified.status()).toBe(200);
      const body = await verified.json();
      expect(body.user.email).toBe(email);
      expect(body.user.role).toBe('user');
      expect(typeof body.offerPasskey).toBe('boolean');
      const me = await request.get('/api/auth/me');
      expect(me.status()).toBe(200);
      expect((await me.json()).user.id).toBe(body.user.id);
    });

    test(`FR-AUTH-023-AC-02 ${viewport.name}: 登録済みのアドレスで始めても、未登録と応答（状態・本文・Set-Cookie の名前と属性）が同じ`, async ({ request }) => {
      const member = await createTestMember(`code-${viewport.name}`);
      const fresh = await startCode(request, uniqueEmail('fresh'), uniqueIp());
      const existing = await startCode(request, member.email, uniqueIp());
      expect(existing.status()).toBe(fresh.status());
      expect(await existing.json()).toEqual(await fresh.json());
      expect(cookieShape(existing)).toEqual(cookieShape(fresh));
      expect(cookieShape(existing).join(' ')).toContain(PENDING_COOKIE);
    });

    test(`FR-AUTH-023-AC-03 ${viewport.name}: 間違ったコードは 1〜5回目が 401、6回目が 429 で、Cookie が消えてその後は 401`, async ({ request }) => {
      await waitForFreshRateWindow();
      const email = uniqueEmail('brute');
      const ip = uniqueIp();
      expect((await startCode(request, email, ip)).status()).toBe(202);
      const statuses: number[] = [];
      let sixth: APIResponse | null = null;
      for (let attempt = 1; attempt <= 6; attempt += 1) {
        const response = await verifyCode(request, '00000000', ip);
        statuses.push(response.status());
        if (attempt === 6) sixth = response;
      }
      expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
      expect(sixth?.headers()['retry-after']).toBeTruthy();
      expect(cookieShape(sixth!).join(' ')).toContain(PENDING_COOKIE);
      const after = await verifyCode(request, '00000000', ip);
      expect(after.status()).toBe(401);
      expect((await after.json()).error).toContain('セッションの有効期限が切れました。');
    });

    test(`FR-AUTH-023-AC-04 ${viewport.name}: 店員のアドレスで始めは同じ応答、確定は 403 staff_passkey_required でセッションの Cookie が付かない`, async ({ request }) => {
      const staff = await withLocalDb((db) => provisionStaff(db, { role: 'admin', approvedPasskeys: 2 }));
      const ip = uniqueIp();
      const fresh = await startCode(request, uniqueEmail('fresh'), uniqueIp());
      // 店員を作った直後は、GoTrue の同じアドレスへの送信の間隔（手元は1秒）の中にいる。始めは間隔の 429 を 202 に隠してメールを送らないので、
      // 間隔が過ぎるのを条件で待ってから始める（始めを呼び直さない。呼び直すと宛先の5通の枠を使う）。
      const intervalEnds = Date.now() + 1_500;
      await expect.poll(() => Date.now() >= intervalEnds, { intervals: [100], timeout: 5_000 }).toBe(true);
      const started = await startCode(request, staff.email, ip);
      expect(started.status()).toBe(fresh.status());
      expect(await started.json()).toEqual(await fresh.json());
      expect(cookieShape(started)).toEqual(cookieShape(fresh));
      const code = await readLatestCode(staff.email, new Set());
      const verified = await verifyCode(request, code, ip);
      expect(verified.status()).toBe(403);
      expect(await verified.json()).toEqual({ error: 'staff_passkey_required' });
      const names = cookieShape(verified).map((entry) => entry.split(':')[0]);
      expect(names).toEqual([PENDING_COOKIE]);
      expect((await (await request.get('/api/auth/me')).json()).authenticated).toBe(false);
    });

    test(`FR-AUTH-023-AC-05 ${viewport.name}: 旧い保留の Cookie（パスワードの道）を持っていても、新しい確定の窓口は 401`, async ({ page }) => {
      await page.goto('/');
      await setLoginTwoFactorCookie(page, uniqueEmail('legacy'));
      const response = await page.request.post('/api/auth/email-code/verify', {
        headers: { origin: ORIGIN, 'x-real-ip': uniqueIp() },
        data: { code: '12345678' },
        maxRedirects: 0,
      });
      expect(response.status()).toBe(401);
    });

    test(`FR-AUTH-023-AC-06 ${viewport.name}: 保留の Cookie が無い確定・再送は 401`, async ({ request }) => {
      expect((await verifyCode(request, '12345678', uniqueIp())).status()).toBe(401);
      const resend = await request.post('/api/auth/email-code/resend', {
        headers: { origin: ORIGIN, 'x-real-ip': uniqueIp() },
        maxRedirects: 0,
      });
      expect(resend.status()).toBe(401);
    });
  });
}
