/**
 * FR-LOGIN-050 パスキーのログインの終わり（POST /api/auth/passkey/login/finish）
 * 対応: FR-AUTH-019-AC-01〜08
 *
 * 手元のアプリ（本番ビルド）・手元の Supabase（GoTrue）・手元の DB だけで流す HTTP の試験。画面は開かない（幅で結果は変わらないが、3つの幅でくり返す）。
 * ソフトの認証器で本物の GoTrue に当てる。道具は e2e/passkey-app-api.ts と scripts/e2e/passkey-staff.ts。
 * 要求ごとに別の x-real-ip と origin を付ける（回数の枠を使い切らないため・proxy の Origin の確かめ）。
 */
import { expect, test, type APIRequestContext } from '@playwright/test';
import { Client } from 'pg';
import { assertLocalDbClient, isLocalUrl } from '../scripts/e2e/environment';
import {
  addUnapprovedPasskey,
  provisionPasskeyUser,
  provisionStaff,
  startAuthenticationAsBrowser,
} from '../scripts/e2e/passkey-staff';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { finishLoginViaApp, loginViaApp } from './passkey-app-api';

test.use({ trace: 'off' });

const LOCAL_DB_URL = process.env.E2E_LOCAL_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const ORIGIN = 'http://localhost:3000';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

function uniqueIp(): string {
  const octet = () => 1 + Math.floor(Math.random() * 253);
  return `10.${octet()}.${octet()}.${octet()}`;
}

async function withDb<T>(run: (db: PgClient) => Promise<T>): Promise<T> {
  if (!isLocalUrl(LOCAL_DB_URL)) throw new Error('手元の DB だけで流す');
  const client = new Client({ connectionString: LOCAL_DB_URL });
  await client.connect();
  try {
    const db = client as unknown as PgClient;
    assertLocalDbClient(db);
    return await run(db);
  } finally {
    await client.end();
  }
}

async function sessionCount(db: PgClient, userId: string): Promise<number> {
  const rows = await db.query('select count(*)::int as n from auth.sessions where user_id = $1::uuid', [userId]);
  return (rows.rows[0] as { n: number }).n;
}

function api(request: APIRequestContext, method: 'get' | 'post', path: string) {
  return request[method](path, {
    headers: { origin: ORIGIN, 'x-real-ip': uniqueIp() },
    maxRedirects: 0,
    failOnStatusCode: false,
  });
}

const hasCookie = (cookies: Array<{ name: string }>, name: string) => cookies.some((cookie) => cookie.name === name);

for (const viewport of viewports) {
  test.describe(`${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`FR-AUTH-019-AC-01 認めた鍵2本の店員が 200 で入り、Cookie が付き、me が mfaVerified:true で、管理 API が 200 (${viewport.name})`, async ({ request }) => {
      await withDb(async (db) => {
        const staff = await provisionStaff(db, { role: 'admin', approvedPasskeys: 2 });
        const result = await loginViaApp(request, { authenticator: staff.authenticators[0], ip: uniqueIp() });
        expect(result.status).toBe(200);
        expect((result.body as { user: { id: string; role: string } }).user).toMatchObject({ id: staff.userId, role: 'admin' });
        expect(hasCookie(result.cookies, 'sb-access-token')).toBe(true);
        expect(hasCookie(result.cookies, 'sb-refresh-token')).toBe(true);

        const me = await api(request, 'get', '/api/auth/me');
        expect(me.status()).toBe(200);
        expect(await me.json()).toMatchObject({ authenticated: true, user: { mfaVerified: true } });

        const users = await api(request, 'get', '/api/admin/users');
        expect(users.status()).toBe(200);
      });
    });

    test(`FR-AUTH-019-AC-02 認めた鍵1本の店員は 200 で入るが、mfaVerified:false で管理 API は 403 (${viewport.name})`, async ({ request }) => {
      await withDb(async (db) => {
        const staff = await provisionStaff(db, { role: 'admin', approvedPasskeys: 1 });
        const result = await loginViaApp(request, { authenticator: staff.authenticators[0], ip: uniqueIp() });
        expect(result.status).toBe(200);

        const me = await api(request, 'get', '/api/auth/me');
        expect(me.status()).toBe(200);
        expect(await me.json()).toMatchObject({ authenticated: true, user: { mfaVerified: false } });

        const users = await api(request, 'get', '/api/admin/users');
        expect(users.status()).toBe(403);
      });
    });

    test(`FR-AUTH-019-AC-03 認めていない鍵で入った店員は 403 で、Cookie が付かず、GoTrue のセッションが残らない (${viewport.name})`, async ({ request }) => {
      await withDb(async (db) => {
        const staff = await provisionStaff(db, { role: 'admin', approvedPasskeys: 2 });
        const unapproved = await addUnapprovedPasskey({ email: staff.email, authenticator: staff.authenticators[0] });
        const before = await sessionCount(db, staff.userId);

        const result = await loginViaApp(request, { authenticator: unapproved.authenticator, ip: uniqueIp() });
        expect(result.status).toBe(403);
        expect(result.body).toEqual({ error: 'passkey_not_approved' });
        expect(hasCookie(result.cookies, 'sb-access-token')).toBe(false);
        expect(hasCookie(result.cookies, 'sb-refresh-token')).toBe(false);
        expect(await sessionCount(db, staff.userId)).toBe(before);

        const rows = await db.query('select count(*)::int as n from public.sessions where user_id = $1::uuid', [staff.userId]);
        expect((rows.rows[0] as { n: number }).n).toBe(0);
      });
    });

    test(`FR-AUTH-019-AC-04 認めた鍵の id に、直に足した鍵の rawId・署名を付けると 400 で、セッションが増えない (${viewport.name})`, async ({ request }) => {
      await withDb(async (db) => {
        const staff = await provisionStaff(db, { role: 'admin', approvedPasskeys: 2 });
        const unapproved = await addUnapprovedPasskey({ email: staff.email, authenticator: staff.authenticators[0] });
        const before = await sessionCount(db, staff.userId);

        const ip = uniqueIp();
        const started = await request.post('/api/auth/passkey/login/start', { headers: { origin: ORIGIN, 'x-real-ip': ip } });
        const body = (await started.json()) as { challenge_id: string; options: Parameters<typeof unapproved.authenticator.authenticate>[0] };
        const forged = {
          ...unapproved.authenticator.authenticate(body.options),
          id: staff.authenticators[0].credentialId.toString('base64url'),
        };
        const result = await finishLoginViaApp(request, { ip, challengeId: body.challenge_id, credential: forged });
        expect(result.status).toBe(400);
        expect(result.body).toEqual({ error: 'invalid_request' });
        expect(hasCookie(result.cookies, 'sb-access-token')).toBe(false);
        expect(await sessionCount(db, staff.userId)).toBe(before);
      });
    });

    test(`FR-AUTH-019-AC-05 お客さん（認めの表に無い）は 200 で入り、Cookie が付く (${viewport.name})`, async ({ request }) => {
      await withDb(async (db) => {
        const customer = await provisionPasskeyUser(db, { approvedPasskeys: 1, appRole: 'user' });
        // お客さんは認めの表を使わない。表に行が無くても入れることを見せるため、認めの行を消す
        await db.query('delete from private.approved_passkeys where user_id = $1::uuid', [customer.userId]);
        const result = await loginViaApp(request, { authenticator: customer.authenticators[0], ip: uniqueIp() });
        expect(result.status).toBe(200);
        expect((result.body as { user: { id: string; role: string } }).user).toMatchObject({ id: customer.userId, role: 'user' });
        expect(hasCookie(result.cookies, 'sb-access-token')).toBe(true);
      });
    });

    test(`FR-AUTH-019-AC-06 UV の無い認証器の応答は 400 で、GoTrue のセッションが増えない (${viewport.name})`, async ({ request }) => {
      await withDb(async (db) => {
        const staff = await provisionStaff(db, { role: 'admin', approvedPasskeys: 2 });
        const before = await sessionCount(db, staff.userId);
        const result = await loginViaApp(request, { authenticator: staff.authenticators[0], ip: uniqueIp(), userVerified: false });
        expect(result.status).toBe(400);
        expect(result.body).toEqual({ error: 'uv_required' });
        expect(hasCookie(result.cookies, 'sb-access-token')).toBe(false);
        expect(await sessionCount(db, staff.userId)).toBe(before);
      });
    });

    test(`FR-AUTH-019-AC-07 始めを別の呼び手（ブラウザの道 (b)）で行っても、アプリの終わりが 200 で通る (${viewport.name})`, async ({ request }) => {
      await withDb(async (db) => {
        const staff = await provisionStaff(db, { role: 'admin', approvedPasskeys: 2 });
        const started = await startAuthenticationAsBrowser();
        expect(started.options.userVerification).toBe('required');
        const ip = uniqueIp();
        const result = await finishLoginViaApp(request, {
          ip,
          challengeId: started.challengeId,
          credential: staff.authenticators[0].authenticate(started.options),
        });
        expect(result.status).toBe(200);
        expect(hasCookie(result.cookies, 'sb-access-token')).toBe(true);
      });
    });

    test(`FR-AUTH-019-AC-08 next=/admin つきで入った、認めた鍵2本の店員は /admin に着き、1本の店員は needsMfa:true・/login?error=staff_passkey_required (${viewport.name})`, async ({ request, playwright, baseURL }) => {
      await withDb(async (db) => {
        const two = await provisionStaff(db, { role: 'admin', approvedPasskeys: 2 });
        const loggedTwo = await loginViaApp(request, { authenticator: two.authenticators[0], ip: uniqueIp(), next: '/admin' });
        expect(loggedTwo.status).toBe(200);
        const destTwo = await api(request, 'post', '/api/auth/post-login');
        expect(destTwo.status()).toBe(200);
        expect(await destTwo.json()).toEqual({ redirectTo: '/admin', needsMfa: false });

        const one = await provisionStaff(db, { role: 'admin', approvedPasskeys: 1 });
        const second = await playwright.request.newContext({ baseURL });
        try {
          const loggedOne = await loginViaApp(second, { authenticator: one.authenticators[0], ip: uniqueIp(), next: '/admin' });
          expect(loggedOne.status).toBe(200);
          const destOne = await api(second, 'post', '/api/auth/post-login');
          expect(destOne.status()).toBe(200);
          expect(await destOne.json()).toEqual({ redirectTo: '/login?error=staff_passkey_required', needsMfa: true });
        } finally {
          await second.dispose();
        }
      });
    });
  });
}
