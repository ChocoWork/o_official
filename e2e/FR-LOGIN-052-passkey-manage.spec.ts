/**
 * FR-LOGIN-052 パスキーの一覧・名前の変更・削除（GET /api/auth/passkey、PATCH・DELETE /api/auth/passkey/{id}）
 * 対応: FR-AUTH-021-AC-01〜06
 *
 * 手元のアプリ（本番ビルド）・手元の Supabase（GoTrue）・手元の DB だけで流す HTTP の試験。画面は開かない（幅で結果は変わらないが、3つの幅でくり返す）。
 * ソフトの認証器で本物の GoTrue に当てる。道具は e2e/passkey-app-api.ts・scripts/e2e/passkey-staff.ts。
 * 要求ごとに別の x-real-ip と origin を付ける（回数の枠を使い切らないため・proxy の Origin の確かめ）。
 * 店員は Cookie と x-csrf-token で呼ぶ（認めた2本の店員が入り直した直後に、登録の窓口で3本目を足す）。お客さんは Bearer の通行証で呼ぶ。
 */
import { expect, test, type APIRequestContext } from '@playwright/test';
import { Client } from 'pg';
import { assertLocalDbClient, isLocalUrl } from '../scripts/e2e/environment';
import { addUnapprovedPasskey, provisionPasskeyUser, provisionStaff } from '../scripts/e2e/passkey-staff';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { bindAppSession } from './admin-session-test-utils';
import { signInWithEmailCode } from './passkey-hook-scenarios';
import { finishRegisterViaApp, loginViaApp, startRegisterViaApp } from './passkey-app-api';
import { createSoftAuthenticator, type SoftAuthenticator } from './passkey-soft-authenticator';

test.use({ trace: 'off' });

const LOCAL_DB_URL = process.env.E2E_LOCAL_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const RELYING_PARTY = { origin: 'http://localhost:3000', rpId: 'localhost' } as const;
const ORIGIN = 'http://localhost:3000';
const MISSING_ID = '99999999-9999-4999-8999-999999999999';

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

async function countOf(db: PgClient, sql: string, userId: string): Promise<number> {
  const rows = await db.query(sql, [userId]);
  return (rows.rows[0] as { n: number }).n;
}
const goTrueKeys = (db: PgClient, userId: string) =>
  countOf(db, 'select count(*)::int as n from auth.webauthn_credentials where user_id = $1::uuid', userId);
const approvedKeys = (db: PgClient, userId: string) =>
  countOf(db, 'select count(*)::int as n from private.approved_passkeys where user_id = $1::uuid', userId);

type Auth = { authorization?: string; csrfToken?: string };
type ListBody = {
  isStaff: boolean;
  approvedCount?: number;
  passkeys: Array<{ id: string; friendly_name: string | null; created_at: string; last_used_at: string | null; approved?: boolean }>;
};

async function call(
  request: APIRequestContext,
  method: 'get' | 'patch' | 'delete',
  path: string,
  auth: Auth,
  data?: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await request[method](path, {
    headers: {
      origin: ORIGIN,
      'x-real-ip': uniqueIp(),
      ...(auth.authorization ? { authorization: auth.authorization } : {}),
      ...(auth.csrfToken ? { 'x-csrf-token': auth.csrfToken } : {}),
    },
    ...(data !== undefined ? { data } : {}),
    failOnStatusCode: false,
    maxRedirects: 0,
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status(), body };
}

const list = async (request: APIRequestContext, auth: Auth) => {
  const res = await call(request, 'get', '/api/auth/passkey', auth);
  return { status: res.status, body: res.body as ListBody };
};

/** 登録の窓口で鍵を足す（始め → 認証器 → 終わり）。足した鍵の id と認証器を返す。 */
async function registerKey(request: APIRequestContext, auth: Auth): Promise<{ id: string; authenticator: SoftAuthenticator }> {
  const start = await startRegisterViaApp(request, { ip: uniqueIp(), ...auth });
  if (start.status !== 200) throw new Error(`登録の始めが 200 でない（status: ${start.status}）`);
  const body = start.body as { challenge_id: string; options: Parameters<SoftAuthenticator['register']>[0] };
  const authenticator = createSoftAuthenticator(RELYING_PARTY);
  const finish = await finishRegisterViaApp(request, {
    ip: uniqueIp(),
    challengeId: body.challenge_id,
    credential: authenticator.register(body.options) as unknown as Record<string, unknown>,
    ...auth,
  });
  if (finish.status !== 200) throw new Error(`登録の終わりが 200 でない（status: ${finish.status}）`);
  return { id: (finish.body as { passkey: { id: string } }).passkey.id, authenticator };
}

/** 認めた2本の店員を用意し、パスキーで入り直して、3本目を足す。Cookie の文脈（request）と csrf を返す。 */
async function staffWithThreeKeys(db: PgClient, request: APIRequestContext, role: 'admin' | 'supporter') {
  const staff = await provisionStaff(db, { role, approvedPasskeys: 2 });
  const login = await loginViaApp(request, { authenticator: staff.authenticators[0], ip: uniqueIp() });
  expect(login.status).toBe(200);
  const csrfToken = login.cookies.find((cookie) => cookie.name === 'sb-csrf-token')?.value;
  expect(csrfToken).toBeTruthy();
  const auth: Auth = { csrfToken };
  const third = await registerKey(request, auth);
  return { staff, auth, thirdId: third.id };
}

/** メールのコードで入ったお客さんを用意し、1本登録する。Bearer の通行証を返す。 */
async function customerWithOneKey(db: PgClient, request: APIRequestContext) {
  const customer = await provisionPasskeyUser(db, { approvedPasskeys: 0 });
  const signedIn = await signInWithEmailCode(customer.email);
  if (!signedIn.accessToken || !signedIn.refreshToken) throw new Error(`メールのコードのログインに失敗した（status: ${signedIn.status}）`);
  await bindAppSession(db, { userId: customer.userId, accessToken: signedIn.accessToken, refreshToken: signedIn.refreshToken });
  const auth: Auth = { authorization: `Bearer ${signedIn.accessToken}` };
  const key = await registerKey(request, auth);
  return { customer, auth, keyId: key.id };
}

for (const viewport of viewports) {
  test.describe(`${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`FR-AUTH-021-AC-01 店員の一覧は3件で approved が真、approvedCount が3、公開鍵などを含まず、名前の変更が一覧に反映される (${viewport.name})`, async ({ request }) => {
      await withDb(async (db) => {
        const { auth, thirdId } = await staffWithThreeKeys(db, request, 'admin');
        const before = await list(request, auth);
        expect(before.status).toBe(200);
        expect(before.body.isStaff).toBe(true);
        expect(before.body.approvedCount).toBe(3);
        expect(before.body.passkeys).toHaveLength(3);
        for (const item of before.body.passkeys) {
          expect(item.approved).toBe(true);
          expect(Object.keys(item).sort()).toEqual(['approved', 'created_at', 'friendly_name', 'id', 'last_used_at']);
        }

        const renamed = await call(request, 'patch', `/api/auth/passkey/${thirdId}`, auth, { friendly_name: '  仕事用のキー  ' });
        expect(renamed.status).toBe(200);
        expect(renamed.body).toEqual({ passkey: { id: thirdId, friendly_name: '仕事用のキー' } });
        const after = await list(request, auth);
        expect(after.body.passkeys.find((item) => item.id === thirdId)?.friendly_name).toBe('仕事用のキー');
      });
    });

    test(`FR-AUTH-021-AC-02 店員は認めた鍵を3本から2本に減らせるが、2本から1本へは409で鍵が残る (${viewport.name})`, async ({ request }) => {
      await withDb(async (db) => {
        const { staff, auth, thirdId } = await staffWithThreeKeys(db, request, 'supporter');
        const removed = await call(request, 'delete', `/api/auth/passkey/${thirdId}`, auth);
        expect(removed.status).toBe(200);
        expect(removed.body).toEqual({ ok: true });
        expect(await goTrueKeys(db, staff.userId)).toBe(2);
        expect(await approvedKeys(db, staff.userId)).toBe(2);

        const remaining = (await list(request, auth)).body.passkeys;
        const blocked = await call(request, 'delete', `/api/auth/passkey/${remaining[0].id}`, auth);
        expect(blocked.status).toBe(409);
        expect(blocked.body).toEqual({ error: 'staff_min_keys' });
        expect(await goTrueKeys(db, staff.userId)).toBe(2);
        expect(await approvedKeys(db, staff.userId)).toBe(2);
      });
    });

    test(`FR-AUTH-021-AC-03 お客さんの一覧に approved・approvedCount が無く、最後の1本も消せる (${viewport.name})`, async ({ request }) => {
      await withDb(async (db) => {
        const { customer, auth, keyId } = await customerWithOneKey(db, request);
        const listed = await list(request, auth);
        expect(listed.status).toBe(200);
        expect(listed.body.isStaff).toBe(false);
        expect(listed.body).not.toHaveProperty('approvedCount');
        expect(listed.body.passkeys).toHaveLength(1);
        expect(listed.body.passkeys[0]).not.toHaveProperty('approved');

        const removed = await call(request, 'delete', `/api/auth/passkey/${keyId}`, auth);
        expect(removed.status).toBe(200);
        expect(await goTrueKeys(db, customer.userId)).toBe(0);
        expect(await approvedKeys(db, customer.userId)).toBe(0);
      });
    });

    test(`FR-AUTH-021-AC-04 別のお客さんの鍵の id は、名前の変更も削除も404で、存在しない id と同じ応答で、鍵も名前も変わらない (${viewport.name})`, async ({ request }) => {
      await withDb(async (db) => {
        const mine = await customerWithOneKey(db, request);
        const theirs = await customerWithOneKey(db, request);
        const before = (await list(request, theirs.auth)).body.passkeys[0].friendly_name;

        const deleted = await call(request, 'delete', `/api/auth/passkey/${theirs.keyId}`, mine.auth);
        const missing = await call(request, 'delete', `/api/auth/passkey/${MISSING_ID}`, mine.auth);
        expect(deleted.status).toBe(404);
        expect(deleted.body).toEqual({ error: 'not_found' });
        expect(missing).toEqual(deleted);

        const renamed = await call(request, 'patch', `/api/auth/passkey/${theirs.keyId}`, mine.auth, { friendly_name: '乗っ取り' });
        expect(renamed.status).toBe(404);
        expect(renamed.body).toEqual({ error: 'not_found' });

        expect(await goTrueKeys(db, theirs.customer.userId)).toBe(1);
        expect((await list(request, theirs.auth)).body.passkeys[0].friendly_name).toBe(before);
        expect(await goTrueKeys(db, mine.customer.userId)).toBe(1);
      });
    });

    test(`FR-AUTH-021-AC-05 直に GoTrue に足した鍵（認めていない）は一覧の approved が偽で、認めた本数に数えず、消せる (${viewport.name})`, async ({ request }) => {
      await withDb(async (db) => {
        const staff = await provisionStaff(db, { role: 'admin', approvedPasskeys: 2 });
        const unapproved = await addUnapprovedPasskey({ email: staff.email, authenticator: staff.authenticators[0] });
        const login = await loginViaApp(request, { authenticator: staff.authenticators[1], ip: uniqueIp() });
        expect(login.status).toBe(200);
        const auth: Auth = { csrfToken: login.cookies.find((cookie) => cookie.name === 'sb-csrf-token')?.value };

        const listed = await list(request, auth);
        expect(listed.body.approvedCount).toBe(2);
        expect(listed.body.passkeys).toHaveLength(3);
        expect(listed.body.passkeys.find((item) => item.id === unapproved.passkeyId)?.approved).toBe(false);
        expect(listed.body.passkeys.filter((item) => item.approved === true)).toHaveLength(2);

        const removed = await call(request, 'delete', `/api/auth/passkey/${unapproved.passkeyId}`, auth);
        expect(removed.status).toBe(200);
        expect(await goTrueKeys(db, staff.userId)).toBe(2);
        expect(await approvedKeys(db, staff.userId)).toBe(2);
      });
    });

    test(`FR-AUTH-021-AC-06 id が uuid でない・名前が決まりを外れる・通行証が無い・Cookie だけで CSRF が無い、は断られ、鍵が残る (${viewport.name})`, async ({ request }) => {
      await withDb(async (db) => {
        const { customer, auth, keyId } = await customerWithOneKey(db, request);
        expect((await call(request, 'patch', '/api/auth/passkey/not-a-uuid', auth, { friendly_name: 'x' })).status).toBe(400);
        expect((await call(request, 'delete', '/api/auth/passkey/not-a-uuid', auth)).status).toBe(400);
        for (const name of ['', '   ', 'a'.repeat(65), 'a\nb']) {
          expect((await call(request, 'patch', `/api/auth/passkey/${keyId}`, auth, { friendly_name: name })).status).toBe(400);
        }
        expect((await call(request, 'get', '/api/auth/passkey', {})).status).toBe(401);
        expect((await call(request, 'delete', `/api/auth/passkey/${keyId}`, {})).status).toBe(401);
        expect(await goTrueKeys(db, customer.userId)).toBe(1);

        const { staff, thirdId } = await staffWithThreeKeys(db, request, 'admin');
        const noCsrf = await call(request, 'delete', `/api/auth/passkey/${thirdId}`, {});
        expect(noCsrf.status).toBe(403);
        expect(await goTrueKeys(db, staff.userId)).toBe(3);
      });
    });
  });
}
