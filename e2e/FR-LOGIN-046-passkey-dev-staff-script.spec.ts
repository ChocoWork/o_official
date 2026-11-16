/**
 * FR-LOGIN-046 手元の開発で店員として入るスクリプト（scripts/dev/passkey-dev-staff.ts）が、手元でない住所で何も書かず、
 * 店員の public.sessions の行を結び付けて作る
 * 対応: FR-AUTH-014-AC-01、FR-AUTH-014-AC-02
 *
 * 手元の Supabase（GoTrue）と手元の DB（E2E_LOCAL_DB_URL、既定は 127.0.0.1:54322）だけで流す。ブラウザは開かない（--open を付けない）。
 * HTTP と DB の試験なので幅で結果は変わらないが、3つの幅（390・768・1280）でくり返す。
 */
import { expect, test } from '@playwright/test';
import { Client } from 'pg';
import { main } from '../scripts/dev/passkey-dev-staff';
import { isLocalUrl } from '../scripts/e2e/environment';

test.use({ trace: 'off' });

const LOCAL_DB_URL = process.env.E2E_LOCAL_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

for (const viewport of viewports) {
  test.describe(`${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`FR-AUTH-014-AC-01 本番の住所では何も作らずに投げる (${viewport.name})`, async () => {
      const saved = process.env.NEXT_PUBLIC_SUPABASE_URL;
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://x.supabase.co';
      try {
        await expect(main([])).rejects.toThrow();
      } finally {
        if (saved === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
        else process.env.NEXT_PUBLIC_SUPABASE_URL = saved;
      }
    });

    test(`FR-AUTH-014-AC-02 作った店員の public.sessions の行が、パスキーのログインの session に結び付き csrf_token_hash が入る (${viewport.name})`, async () => {
      if (!isLocalUrl(LOCAL_DB_URL)) throw new Error('手元の DB だけで流す');
      const email = `dev-staff-e2e-${Date.now().toString(36)}-${viewport.width}@example.com`;
      await main(['--email', email]);
      const db = new Client({ connectionString: LOCAL_DB_URL });
      await db.connect();
      try {
        const user = await db.query('select id from auth.users where lower(email) = lower($1)', [email]);
        expect(user.rowCount).toBe(1);
        const userId = user.rows[0].id as string;
        const authSessions = await db.query('select id from auth.sessions where user_id = $1::uuid', [userId]);
        expect(authSessions.rowCount).toBe(1);
        const rows = await db.query(
          'select auth_session_id, csrf_token_hash, revoked_at from public.sessions where user_id = $1::uuid',
          [userId],
        );
        expect(rows.rowCount).toBe(1);
        expect(rows.rows[0].auth_session_id).toBe(authSessions.rows[0].id);
        expect(rows.rows[0].revoked_at).toBeNull();
        expect(rows.rows[0].csrf_token_hash).toMatch(/^[0-9a-f]{64}$/);
      } finally {
        await db.end();
      }
    });
  });
}
