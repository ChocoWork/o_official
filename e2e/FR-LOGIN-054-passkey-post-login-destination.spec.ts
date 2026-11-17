/**
 * FR-LOGIN-054 店員の行き先・戻り先を、パスキーの入口の条件（amr のパスキー・24時間・認めた2本）で決める（POST /api/auth/post-login）
 * 対応: FR-AUTH-018-AC-01〜03
 *
 * 手元のアプリ（本番ビルド）と手元の DB だけで流す HTTP の試験。画面は開かない（幅で結果は変わらないが、3つの幅でくり返す）。
 * 戻り先の控えは、実在の POST /api/auth/oauth/start（next を控えて Cookie に付ける）で作る。試験専用の入口をアプリに足さない。
 * 手元の GoTrue で Google が有効でなく控えが作れない時は、手元の DB に控えの行を直に入れる（手元の DB だけを許す）。
 * 店員の通行証は createAdminSessionActor（provisionStaff＋パスキーのログイン＋sessions への結び付け）で作り、Bearer で渡す。
 * 要求ごとに別の x-real-ip と origin を付ける（回数の枠を使い切らないため・proxy の Origin の確かめ）。
 */
import { randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { Client } from 'pg';
import { assertLocalDbClient, isLocalUrl } from '../scripts/e2e/environment';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { hashReturnIntentToken } from '../src/features/auth/return-intent/return-intent-store';
import { bearerHeaders, createAdminSessionActor, type AdminSessionActor } from './admin-session-test-utils';

test.use({ trace: 'off' });

const LOCAL_DB_URL = process.env.E2E_LOCAL_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const ORIGIN = 'http://localhost:3000';
const INTENT_COOKIE_NAME = 'sb-return-intent';

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

/** 戻り先 next の控えを作り、Cookie の値（番号）を返す。まず実在の oauth/start、だめなら手元の DB に直に入れる */
async function issueIntentCookie(request: APIRequestContext, db: PgClient, next: string): Promise<string> {
  const started = await request.post('/api/auth/oauth/start', {
    headers: { origin: ORIGIN, 'x-real-ip': uniqueIp() },
    data: { provider: 'google', next },
    maxRedirects: 0,
    failOnStatusCode: false,
  });
  if (started.status() === 200) {
    const setCookie = started
      .headersArray()
      .filter((header) => header.name.toLowerCase() === 'set-cookie')
      .map((header) => header.value)
      .find((value) => value.startsWith(`${INTENT_COOKIE_NAME}=`));
    const token = setCookie?.split(';')[0].slice(INTENT_COOKIE_NAME.length + 1);
    if (token) return token;
  }
  const token = randomBytes(32).toString('base64url');
  const inserted = await db.query(
    `insert into private.auth_return_intents (token_hash, return_path, purpose, expires_at)
     values ($1, $2, 'login', now() + interval '10 minutes')`,
    [hashReturnIntentToken(token), next],
  );
  if (inserted.rowCount !== 1) throw new Error('戻り先の控えを作れない');
  return token;
}

async function isConsumed(db: PgClient, token: string): Promise<boolean> {
  const rows = await db.query('select consumed_at from private.auth_return_intents where token_hash = $1', [hashReturnIntentToken(token)]);
  if (rows.rowCount !== 1) throw new Error('戻り先の控えの行が1行ではない');
  return (rows.rows[0] as { consumed_at: string | null }).consumed_at !== null;
}

function postLogin(request: APIRequestContext, actor: AdminSessionActor, token?: string) {
  return request.post('/api/auth/post-login', {
    headers: {
      ...bearerHeaders(actor),
      origin: ORIGIN,
      'x-real-ip': uniqueIp(),
      ...(token ? { cookie: `${INTENT_COOKIE_NAME}=${token}` } : {}),
    },
    maxRedirects: 0,
    failOnStatusCode: false,
  });
}

for (const viewport of viewports) {
  test.describe(`${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`FR-AUTH-018-AC-01 認めた鍵が1本の店員は needsMfa:true・/auth/verified で、戻り先の控えは使い切られない (${viewport.name})`, async ({ request }) => {
      await withDb(async (db) => {
        for (const role of ['admin', 'supporter'] as const) {
          const actor = await createAdminSessionActor(db, role, 'aal1');
          const token = await issueIntentCookie(request, db, '/item');
          const res = await postLogin(request, actor, token);
          expect(res.status(), role).toBe(200);
          expect(await res.json(), role).toEqual({ redirectTo: '/auth/verified', needsMfa: true });
          expect(await isConsumed(db, token), role).toBe(false);
        }
      });
    });

    test(`FR-AUTH-018-AC-02 認めた鍵が1本の店員に next=/admin の控えを付けても /admin に着かない (${viewport.name})`, async ({ request }) => {
      await withDb(async (db) => {
        const actor = await createAdminSessionActor(db, 'admin', 'aal1');
        const token = await issueIntentCookie(request, db, '/admin');
        const res = await postLogin(request, actor, token);
        expect(res.status()).toBe(200);
        const body = (await res.json()) as { redirectTo: string; needsMfa: boolean };
        expect(body).toEqual({ redirectTo: '/auth/verified', needsMfa: true });
        expect(body.redirectTo.startsWith('/admin')).toBe(false);
        expect(await isConsumed(db, token)).toBe(false);
      });
    });

    test(`FR-AUTH-018-AC-03 お客さんは needsMfa:false で、認めた鍵が2本の店員は戻り先が無ければ /admin に着く (${viewport.name})`, async ({ request }) => {
      await withDb(async (db) => {
        const customer = await createAdminSessionActor(db, 'user', 'aal1');
        const customerRes = await postLogin(request, customer);
        expect(customerRes.status()).toBe(200);
        expect(await customerRes.json()).toEqual({ redirectTo: '/', needsMfa: false });

        const staff = await createAdminSessionActor(db, 'admin', 'aal2');
        const staffRes = await postLogin(request, staff);
        expect(staffRes.status()).toBe(200);
        expect(await staffRes.json()).toEqual({ redirectTo: '/admin', needsMfa: false });

        const token = await issueIntentCookie(request, db, '/admin/orders');
        const withIntent = await postLogin(request, staff, token);
        expect(await withIntent.json()).toEqual({ redirectTo: '/admin/orders', needsMfa: false });
        expect(await isConsumed(db, token)).toBe(true);
      });
    });
  });
}
