/**
 * FR-LOGIN-053 フックが更新を拒否した店員のセッションを、アプリが終わらせる（POST /api/auth/refresh）
 * 対応: FR-AUTH-022-AC-01〜04
 *
 * 手元のアプリ（本番ビルド）・手元の Supabase（GoTrue のフック）・手元の DB だけで流す HTTP の試験。画面は開かない（幅で結果は変わらないが、3つの幅でくり返す）。
 * 店員は e2e/admin-session-test-utils.ts の createWindowSessionActor（役割の無い間にメールのコードで入る → アプリに結び付ける → 窓を開ける → 役割を有効にする）で作る。
 * 窓の中の更新はフックが通し、`passkey_window_close` の後の更新はフックが拒否する（e2e/passkey-hook-scenarios.ts の場面と同じ）。
 * Cookie は要求ごとに新しい文脈へ手で載せ、要求ごとに別の x-real-ip と origin を付ける（回数の枠・proxy の Origin の確かめ）。トークンの値は失敗の文面に出さない。
 */
import { expect, request as playwrightRequest, test } from '@playwright/test';
import { Client } from 'pg';
import { assertLocalDbClient, isLocalUrl } from '../scripts/e2e/environment';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { createAdminSessionActor, createWindowSessionActor } from './admin-session-test-utils';

test.use({ trace: 'off' });

const LOCAL_DB_URL = process.env.E2E_LOCAL_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const ORIGIN = 'http://localhost:3000';
const AUTH_COOKIES = ['sb-access-token', 'sb-refresh-token', 'sb-csrf-token'];

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

type RefreshResult = {
  status: number;
  body: { error?: string; code?: string; ok?: boolean };
  /** Set-Cookie の name → 値（消した Cookie は空） */
  setCookies: Record<string, string>;
  /** Set-Cookie の name → Max-Age */
  maxAges: Record<string, number | undefined>;
};

/** 新しい文脈で、Cookie を手で載せて POST /api/auth/refresh を呼ぶ */
async function refresh(tokens: { accessToken: string; refreshToken: string }): Promise<RefreshResult> {
  const context = await playwrightRequest.newContext({ baseURL: ORIGIN });
  try {
    const res = await context.post('/api/auth/refresh', {
      headers: {
        origin: ORIGIN,
        'x-real-ip': uniqueIp(),
        cookie: `sb-access-token=${tokens.accessToken}; sb-refresh-token=${tokens.refreshToken}`,
      },
      failOnStatusCode: false,
      maxRedirects: 0,
    });
    const setCookies: Record<string, string> = {};
    const maxAges: Record<string, number | undefined> = {};
    for (const header of res.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie')) {
      const [pair, ...attributes] = header.value.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      setCookies[name] = pair.slice(eq + 1).trim();
      const maxAge = attributes.map((a) => a.trim()).find((a) => a.toLowerCase().startsWith('max-age='));
      maxAges[name] = maxAge ? Number(maxAge.slice('max-age='.length)) : undefined;
    }
    const body = (await res.json().catch(() => ({}))) as RefreshResult['body'];
    return { status: res.status(), body, setCookies, maxAges };
  } finally {
    await context.dispose();
  }
}

/** GET /api/auth/me を Bearer で呼び、authenticated を返す */
async function isAuthenticated(accessToken: string): Promise<boolean> {
  const context = await playwrightRequest.newContext({ baseURL: ORIGIN });
  try {
    const res = await context.get('/api/auth/me', {
      headers: { 'x-real-ip': uniqueIp(), authorization: `Bearer ${accessToken}` },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(200);
    return ((await res.json()) as { authenticated?: boolean }).authenticated === true;
  } finally {
    await context.dispose();
  }
}

function expectCookiesCleared(result: RefreshResult) {
  for (const name of AUTH_COOKIES) {
    expect(result.setCookies[name], `${name} の Set-Cookie`).toBe('');
    expect(result.maxAges[name], `${name} の Max-Age`).toBe(0);
  }
}

for (const viewport of viewports) {
  test.describe(`${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`FR-AUTH-022-AC-02 印の無い失敗（GoTrue の session が無い更新）は、今までどおり Cookie を消して 401 Failed to refresh token で、public.sessions の行は失効しない (${viewport.name})`, async () => {
      await withDb(async (db) => {
        const customer = await createAdminSessionActor(db, 'user', 'aal1');
        const deleted = await db.query('delete from auth.sessions where id = $1::uuid', [customer.sessionId]);
        expect(deleted.rowCount).toBe(1);

        const result = await refresh(customer);

        expect(result.status).toBe(401);
        expect(result.body).toEqual({ error: 'Failed to refresh token' });
        expectCookiesCleared(result);
        const rows = await db.query(
          'select count(*)::int as live from public.sessions where auth_session_id = $1::uuid and revoked_at is null',
          [customer.sessionId],
        );
        expect((rows.rows[0] as { live: number }).live).toBe(1);
      });
    });

    test(`FR-AUTH-022-AC-03 窓が開いている間の店員の更新と、窓の無いお客さんの更新は 200 で、新しい Cookie が付く (${viewport.name})`, async () => {
      await withDb(async (db) => {
        const staff = await createWindowSessionActor(db, { role: 'admin' });
        const inside = await refresh(staff);
        expect(inside.status).toBe(200);
        expect(inside.body).toEqual({ ok: true });
        for (const name of AUTH_COOKIES) expect(inside.setCookies[name]?.length ?? 0, `${name} の新しい値`).toBeGreaterThan(0);

        const customer = await createAdminSessionActor(db, 'user', 'aal1');
        const customerResult = await refresh(customer);
        expect(customerResult.status).toBe(200);
        expect(customerResult.body).toEqual({ ok: true });
        for (const name of AUTH_COOKIES) expect(customerResult.setCookies[name]?.length ?? 0).toBeGreaterThan(0);
      });
    });

    test(`FR-AUTH-022-AC-01 窓を閉じた後の更新は 401 staff_passkey_required で、Cookie が消え、public.sessions の行が失効し、auth.sessions の行が消える (${viewport.name})`, async () => {
      await withDb(async (db) => {
        const staff = await createWindowSessionActor(db, { role: 'admin' });
        const before = await db.query(
          'select count(*)::int as n from auth.sessions where id = $1::uuid',
          [staff.sessionId],
        );
        expect((before.rows[0] as { n: number }).n).toBe(1);

        await db.query('select public.passkey_window_close($1::uuid)', [staff.sessionId]);
        const rejected = await refresh(staff);

        expect(rejected.status).toBe(401);
        expect(rejected.body).toEqual({ error: 'Staff passkey required', code: 'staff_passkey_required' });
        expectCookiesCleared(rejected);

        const rows = await db.query(
          'select count(*)::int as total, count(*) filter (where revoked_at is null)::int as live from public.sessions where auth_session_id = $1::uuid',
          [staff.sessionId],
        );
        expect(rows.rows[0]).toEqual({ total: 1, live: 0 });
        const goTrue = await db.query('select count(*)::int as n from auth.sessions where id = $1::uuid', [staff.sessionId]);
        expect((goTrue.rows[0] as { n: number }).n).toBe(0);
      });
    });

    test(`FR-AUTH-022-AC-04 拒否の前は前のアクセストークンで /api/auth/me が authenticated:true で、拒否の後は false になる (${viewport.name})`, async () => {
      await withDb(async (db) => {
        const staff = await createWindowSessionActor(db, { role: 'admin' });
        const inside = await refresh(staff);
        expect(inside.status).toBe(200);
        const accessToken = inside.setCookies['sb-access-token'];
        const refreshToken = inside.setCookies['sb-refresh-token'];
        expect(accessToken.length).toBeGreaterThan(0);
        expect(await isAuthenticated(accessToken)).toBe(true);

        await db.query('select public.passkey_window_close($1::uuid)', [staff.sessionId]);
        const rejected = await refresh({ accessToken, refreshToken });
        expect(rejected.status).toBe(401);
        expect(rejected.body.code).toBe('staff_passkey_required');

        expect(await isAuthenticated(accessToken)).toBe(false);
      });
    });
  });
}
