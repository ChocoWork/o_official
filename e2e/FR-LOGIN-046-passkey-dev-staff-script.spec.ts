/**
 * FR-LOGIN-046 手元の開発で店員として入るスクリプト（scripts/dev/passkey-dev-staff.ts）が、手元でない住所で何も書かず、
 * 店員の public.sessions の行を結び付けて作る
 * 対応: FR-AUTH-014-AC-01、FR-AUTH-014-AC-02、FR-AUTH-014-AC-03
 *
 * 手元の Supabase（GoTrue）と手元の DB（E2E_LOCAL_DB_URL、既定は 127.0.0.1:54322）と、本番ビルドのアプリ（3000番）で流す。
 * AC-03 は openBrowser を入れ替え、スクリプトが作った Cookie を試験のブラウザに入れて /admin と CSRF の確かめを通す。3つの幅（390・768・1280）でくり返す。
 */
import { expect, test } from '@playwright/test';
import { Client } from 'pg';
import { main } from '../scripts/dev/passkey-dev-staff';
import { isLocalUrl } from '../scripts/e2e/environment';

test.use({ trace: 'off' });

const LOCAL_DB_URL = process.env.E2E_LOCAL_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

/** 呼ばれた回数を数えるだけの入れ物 */
function counter(): { calls: number } {
  return { calls: 0 };
}

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

for (const viewport of viewports) {
  test.describe(`${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`FR-AUTH-014-AC-01 本番の住所では何も作らずに投げる (${viewport.name})`, async () => {
      const email = `dev-staff-e2e-prod-${Date.now().toString(36)}-${viewport.width}@example.com`;
      const connectDb = counter();
      const provision = counter();
      await expect(
        main(['--email', email], {
          readEnv: () => ({ url: 'https://x.supabase.co', anonKey: 'a', serviceRoleKey: 's', databaseUrl: LOCAL_DB_URL }),
          connectDb: async () => {
            connectDb.calls += 1;
            throw new Error('呼ばれてはいけない');
          },
          provisionStaff: (async () => {
            provision.calls += 1;
            throw new Error('呼ばれてはいけない');
          }) as never,
        }),
      ).rejects.toThrow('手元の Supabase だけ');
      expect(connectDb.calls).toBe(0);
      expect(provision.calls).toBe(0);
      const db = new Client({ connectionString: LOCAL_DB_URL });
      await db.connect();
      try {
        expect((await db.query('select 1 from auth.users where lower(email) = lower($1)', [email])).rowCount).toBe(0);
      } finally {
        await db.end();
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

    test(`FR-AUTH-014-AC-03 作った Cookie で /admin に入れ、CSRF のヘッダーが無い管理の書き込みは 403・ヘッダーがあれば 403 でない (${viewport.name})`, async ({ page }) => {
      const email = `dev-staff-e2e-open-${Date.now().toString(36)}-${viewport.width}@example.com`;
      let opened = false;
      await main(['--open', '--email', email], {
        print: () => {},
        openBrowser: async ({ cookies, startUrl }) => {
          opened = true;
          await page.context().clearCookies();
          await page.context().addCookies(cookies);
          const response = await page.goto(startUrl);
          expect(response?.status()).toBe(200);
          expect(new URL(page.url()).pathname).toBe('/admin');
          const csrf = cookies.find((cookie) => cookie.name === 'sb-csrf-token')!.value;
          const patch = (withHeader: boolean) =>
            page.evaluate(
              async ({ token, withHeader }) => {
                const r = await fetch('/api/admin/users', {
                  method: 'PATCH',
                  headers: { 'content-type': 'application/json', ...(withHeader ? { 'x-csrf-token': token } : {}) },
                  body: '{}',
                });
                return { status: r.status, text: await r.text() };
              },
              { token: csrf, withHeader },
            );
          const without = await patch(false);
          expect(without.status).toBe(403);
          expect(without.text).toContain('CSRF validation failed');
          const withHeader = await patch(true);
          expect(withHeader.status).not.toBe(403);
        },
      });
      expect(opened).toBe(true);
    });
  });
}
