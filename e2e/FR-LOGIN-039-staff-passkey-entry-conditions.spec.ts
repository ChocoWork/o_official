/**
 * FR-LOGIN-039 管理の入口は、パスキーのログイン・24時間以内・DB で数えた認めたパスキー2本以上の3つで通す（API の管理窓口）
 * 対応: FR-AUTH-012-AC-01 / FR-AUTH-012-AC-02 / FR-AUTH-012-AC-03 / FR-AUTH-012-AC-04
 *
 * 手元の Supabase とアプリの管理 API（/api/admin/permissions。admin.permissions.manage は店長に固定で付く）を、
 * 共有の道具 createAdminSessionActor（provisionStaff → パスキーのログイン → アプリの sessions に結び付ける）で作った JWT で、HTTP から叩く。
 * 古い名前の 'aal2' は認めたパスキー2本の店員、'aal1' は1本の店員（e2e/admin-session-test-utils.ts の先頭の読み替え）。
 * 画面は開かない（HTTP の試験なので幅で結果は変わらないが、3つの幅（390・768・1280）でくり返す）。JWT が通信記録に残らないよう trace は切る。
 */
import { expect, test, type APIResponse } from '@playwright/test';
import { Client } from 'pg';
import { isLocalUrl } from '../scripts/e2e/environment';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { bearerHeaders, createAdminSessionActor } from './admin-session-test-utils';
import { deleteOnePasskeyViaGoTrue } from './passkey-hook-scenarios';

test.use({ trace: 'off' });

const LOCAL_DB_URL = process.env.E2E_LOCAL_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const PROBE_ROUTE = '/api/admin/permissions';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

async function withDb<T>(run: (db: PgClient) => Promise<T>): Promise<T> {
  if (!isLocalUrl(LOCAL_DB_URL)) throw new Error('手元の DB だけで流す');
  const db = new Client({ connectionString: LOCAL_DB_URL });
  await db.connect();
  try {
    return await run(db as unknown as PgClient);
  } finally {
    await db.end();
  }
}

type Forbidden = { error?: string; reason?: string };

async function bodyOf(response: APIResponse): Promise<Forbidden> {
  return (await response.json().catch(() => ({}))) as Forbidden;
}

for (const viewport of viewports) {
  test.describe(`${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`FR-AUTH-012-AC-01 認めたパスキー2本の店員がパスキーで入った JWT は管理 API が 200 で通り、JWT の aal は aal1 のまま (${viewport.name})`, async ({ request }) => {
      const staff = await withDb((db) => createAdminSessionActor(db, 'admin', 'aal2'));
      const claims = JSON.parse(Buffer.from(staff.accessToken.split('.')[1], 'base64url').toString('utf8')) as { aal?: string };
      expect(claims.aal, 'パスキーのログインは aal1 のまま').toBe('aal1');

      const response = await request.get(PROBE_ROUTE, { headers: bearerHeaders(staff), failOnStatusCode: false, maxRedirects: 0 });

      expect(response.status()).toBe(200);
    });

    test(`FR-AUTH-012-AC-02 認めたパスキー1本の店員は、パスキーで入っていても 403 で、reason が MFA required (${viewport.name})`, async ({ request }) => {
      const staff = await withDb((db) => createAdminSessionActor(db, 'admin', 'aal1'));

      const response = await request.get(PROBE_ROUTE, { headers: bearerHeaders(staff), failOnStatusCode: false, maxRedirects: 0 });

      expect(response.status()).toBe(403);
      expect((await bodyOf(response)).reason).toBe('MFA required');
    });

    test(`FR-AUTH-012-AC-03 管理の役割を持たないお客さんは 403 になる (${viewport.name})`, async ({ request }) => {
      const customer = await withDb((db) => createAdminSessionActor(db, 'user', 'aal1'));

      const response = await request.get(PROBE_ROUTE, { headers: bearerHeaders(customer), failOnStatusCode: false, maxRedirects: 0 });

      expect(response.status()).toBe(403);
    });

    test(`FR-AUTH-012-AC-04 認めた鍵を GoTrue の auth.passkey.delete で消した直後に、更新を待たず同じ JWT の管理 API が 403 になる (${viewport.name})`, async ({ request }) => {
      const staff = await withDb((db) => createAdminSessionActor(db, 'admin', 'aal2'));
      const before = await request.get(PROBE_ROUTE, { headers: bearerHeaders(staff), failOnStatusCode: false, maxRedirects: 0 });
      expect(before.status(), '消す前は通る（対照）').toBe(200);

      await deleteOnePasskeyViaGoTrue({ accessToken: staff.accessToken, refreshToken: staff.refreshToken });

      // JWT の staff_passkeys_ok は真のまま（次の更新まで変わらない）。それでも、管理 API は DB で数え直して断る
      const claims = JSON.parse(Buffer.from(staff.accessToken.split('.')[1], 'base64url').toString('utf8')) as { staff_passkeys_ok?: boolean };
      expect(claims.staff_passkeys_ok, 'JWT の印は真のまま').toBe(true);
      const after = await request.get(PROBE_ROUTE, { headers: bearerHeaders(staff), failOnStatusCode: false, maxRedirects: 0 });
      expect(after.status()).toBe(403);
      expect((await bodyOf(after)).reason).toBe('MFA required');
    });
  });
}
