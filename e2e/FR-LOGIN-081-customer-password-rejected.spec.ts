/**
 * FR-LOGIN-081 お客さんの password ログインは、GoTrue のフックが `[customer-password-disabled]` で拒否し、ほかの入り方は通る
 * 対応: FR-AUTH-055-AC-01 / FR-AUTH-055-AC-02 / SEC-AUTH-060-AC-01 / SEC-AUTH-060-AC-02（上位: SR-AUTH-030、THR-AUTH-058）
 *
 * 移行 J（`private.passkey_staff_config.reject_customer_password = true`）を当てた手元の Supabase の GoTrue を、アプリを通さず直に叩く
 * （画面は開かない。HTTP の試験なので幅で結果は変わらないが、3つの幅（390・768・1280）でくり返す）。旗の値は変えず、真であることを前提にする
 * （旗を切り替える試験と重ならないよう isolated-global で直列に流す。playwright.config.ts）。
 * 場面は e2e/passkey-hook-scenarios.ts。JWT・鍵・パスワードが通信記録に残らないよう trace は切る。
 */
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';
import { Client } from 'pg';
import { isLocalUrl } from '../scripts/e2e/environment';
import { provisionPasskeyUser } from '../scripts/e2e/passkey-staff';
import { isStaffPasskeyRequiredError } from '../src/lib/auth/staff-passkey-reject';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { DUMMY_CAPTCHA_TOKEN } from './captcha-test-utils';
import { claimsOf, createCustomerWithPassword, passkeyLogin, refreshWith, signInWithEmailCode, signInWithPasswordGrant } from './passkey-hook-scenarios';

test.use({ trace: 'off' });
test.describe.configure({ timeout: 120_000 });

const LOCAL_DB_URL = process.env.E2E_LOCAL_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const CUSTOMER_MARKER = '[customer-password-disabled]';

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

/** 移行 J の後の旗（真）を前提にする。偽なら、旗を戻し忘れた試験があるので、ここで止める */
async function expectFlagTrue(): Promise<void> {
  const flag = await withDb(async (db) => (await db.query('select reject_customer_password as flag from private.passkey_staff_config')).rows[0]?.flag);
  expect(flag, '移行 J の後は、お客さんの password を拒む旗が真').toBe(true);
}

function randomIp(): string {
  const [a, b, c] = randomBytes(3);
  return `10.${a}.${b}.${c}`;
}

for (const viewport of viewports) {
  test.describe(`${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`FR-AUTH-055-AC-01 お客さんが正しいパスワードで grant_type=password を直に叩くと 403 で、message が [customer-password-disabled] で始まり、店員の印ではなく、トークンが無い (${viewport.name})`, async () => {
      await expectFlagTrue();
      const customer = await createCustomerWithPassword();

      const rejected = await signInWithPasswordGrant(customer.email, customer.password);

      expect(rejected.status).toBe(403);
      expect(rejected.message?.startsWith(CUSTOMER_MARKER), 'お客さんの印').toBe(true);
      expect(isStaffPasskeyRequiredError({ status: rejected.status, message: rejected.message }), '店員の印ではない').toBe(false);
      expect(rejected.accessToken, '拒否された時はトークンが無い').toBeUndefined();
      expect(rejected.refreshToken).toBeUndefined();
    });

    test(`FR-AUTH-055-AC-02 同じお客さんでも、メールのコードでは 200 で入れて、更新（token_refresh）も通る (${viewport.name})`, async () => {
      await expectFlagTrue();
      const customer = await createCustomerWithPassword();

      const byCode = await signInWithEmailCode(customer.email);
      expect(byCode.status, 'メールのコード').toBe(200);
      expect(claimsOf(byCode.accessToken as string).sub).toBe(customer.userId);

      const refreshed = await refreshWith(byCode.refreshToken as string);
      expect(refreshed.status, '更新').toBe(200);
    });

    test(`SEC-AUTH-060-AC-01 公開の anon の鍵の signInWithPassword（GoTrue の直叩き）も拒否され、session が作られない (${viewport.name})`, async () => {
      await expectFlagTrue();
      const customer = await createCustomerWithPassword();
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
      const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
      expect(isLocalUrl(url), '手元の Supabase だけで流す').toBe(true);
      const anon = createClient(url, anonKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { headers: { 'x-forwarded-for': randomIp() } },
      });

      const signedIn = await anon.auth.signInWithPassword({
        email: customer.email,
        password: customer.password,
        options: { captchaToken: DUMMY_CAPTCHA_TOKEN },
      });

      expect(signedIn.data.session).toBeNull();
      expect(signedIn.error?.status).toBe(403);
      expect(signedIn.error?.message.startsWith(CUSTOMER_MARKER)).toBe(true);
      const sessions = await withDb(async (db) => (await db.query('select count(*)::int as n from auth.sessions where user_id = $1::uuid', [customer.userId])).rows[0].n);
      expect(sessions, '拒否された入り方では auth.sessions の行が作られない').toBe(0);
    });

    test(`SEC-AUTH-060-AC-02 お客さんのパスキーでの入り方も 200 で、更新が通り、店員の印は付かない (${viewport.name})`, async () => {
      await expectFlagTrue();
      const withPasskey = await withDb((db) => provisionPasskeyUser(db, { approvedPasskeys: 1 }));

      const byPasskey = await passkeyLogin(withPasskey.email, withPasskey.authenticators[0]);
      expect(byPasskey.status, 'パスキー').toBe(200);
      expect(byPasskey.claims.staff_passkeys_ok, 'お客さんには店員の印を付けない').not.toBe(true);

      const refreshed = await refreshWith(byPasskey.refreshToken as string);
      expect(refreshed.status, '更新').toBe(200);
    });
  });
}
