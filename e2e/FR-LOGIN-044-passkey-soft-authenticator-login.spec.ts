/**
 * FR-LOGIN-044 ソフトの認証器で登録した店員が、パスキーでログインでき、トークンの amr に passkey が付き aal が aal1 になる
 * 対応: FR-AUTH-010-AC-01
 *
 * 手元の Supabase（GoTrue）と手元の DB（E2E_LOCAL_DB_URL、既定は 127.0.0.1:54322）だけで流す。画面は開かない
 * （HTTP の試験なので幅で結果は変わらないが、3つの幅（390・768・1280）でくり返す）。道具は scripts/e2e/passkey-staff.ts。
 */
import { expect, test } from '@playwright/test';
import { Client } from 'pg';
import { isLocalUrl } from '../scripts/e2e/environment';
import { loginWithPasskey, provisionStaff } from '../scripts/e2e/passkey-staff';
import type { PgClient } from '../tests/integration/db/helpers/local-db';

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

    test(`FR-AUTH-010-AC-01 ソフトの認証器で登録した店員がパスキーでログインでき amr に passkey が付き aal1 になる (${viewport.name})`, async () => {
      if (!isLocalUrl(LOCAL_DB_URL)) throw new Error('手元の DB だけで流す');
      const db = new Client({ connectionString: LOCAL_DB_URL });
      await db.connect();
      try {
        const staff = await provisionStaff(db as unknown as PgClient, { role: 'admin', approvedPasskeys: 2 });
        const { session } = await loginWithPasskey({ email: staff.email, authenticator: staff.authenticators[0] });
        const claims = JSON.parse(Buffer.from(session.access_token.split('.')[1], 'base64url').toString('utf8')) as {
          amr?: Array<{ method: string }>;
          aal?: string;
          session_id?: string;
        };
        expect(claims.amr?.some((a) => a.method === 'passkey')).toBe(true);
        expect(claims.aal).toBe('aal1');
        expect(claims.session_id).toBeTruthy();
      } finally {
        await db.end();
      }
    });
  });
}
