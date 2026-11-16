/**
 * FR-LOGIN-040 GoTrue のアクセストークンのフックが、店員の入口をパスキー（と登録の窓）だけに絞り、お客さんの道を壊さない
 * 対応: FR-AUTH-013-AC-01 / FR-AUTH-013-AC-02 / FR-AUTH-013-AC-03 / FR-AUTH-013-AC-04
 *
 * 手元の Supabase の GoTrue を、アプリを通さず直に叩く（画面は開かない。HTTP の試験なので幅で結果は変わらないが、
 * 3つの幅（390・768・1280）でくり返す）。場面は e2e/passkey-hook-scenarios.ts、店員の用意は scripts/e2e/passkey-staff.ts。
 * 24時間は待てないので、設定を縮めず、案 B の窓（役割の無い間にメールのコードで入る → 窓を開ける → 役割を有効にする → 更新が通る →
 * 窓を閉じる → 更新が拒否される）で作る。JWT・鍵が通信記録に残らないよう trace は切る。
 */
import { expect, test } from '@playwright/test';
import { Client } from 'pg';
import { isLocalUrl } from '../scripts/e2e/environment';
import { provisionPasskeyUser, provisionStaff } from '../scripts/e2e/passkey-staff';
import { isStaffPasskeyRequiredError } from '../src/lib/auth/staff-passkey-reject';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import {
  claimsOf,
  createCustomerWithPassword,
  passkeyLogin,
  refreshWith,
  runWindowScenario,
  setStaffPassword,
  signInWithEmailCode,
  signInWithPasswordGrant,
} from './passkey-hook-scenarios';

test.use({ trace: 'off' });
test.describe.configure({ timeout: 120_000 });

const LOCAL_DB_URL = process.env.E2E_LOCAL_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

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

for (const viewport of viewports) {
  test.describe(`${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`FR-AUTH-013-AC-01 店員がパスキーで入ると 200 で、JWT の staff_passkeys_ok が、認めた鍵2本なら真・1本なら偽になる (${viewport.name})`, async () => {
      const two = await withDb((db) => provisionStaff(db, { role: 'admin', approvedPasskeys: 2 }));
      const one = await withDb((db) => provisionStaff(db, { role: 'supporter', approvedPasskeys: 1 }));

      const twoLogin = await passkeyLogin(two.email, two.authenticators[0]);
      const oneLogin = await passkeyLogin(one.email, one.authenticators[0]);

      expect(twoLogin.status).toBe(200);
      expect(twoLogin.claims.amr?.some((entry) => entry.method === 'passkey')).toBe(true);
      expect(twoLogin.claims.staff_passkeys_ok, '認めた鍵2本').toBe(true);
      expect(oneLogin.claims.staff_passkeys_ok, '認めた鍵1本（印が偽になる側）').toBe(false);
    });

    test(`FR-AUTH-013-AC-02 店員がメールのコードで入ろうとすると 403 で、message が印で始まり isStaffPasskeyRequiredError が真。パスワードでも 403 (${viewport.name})`, async () => {
      const staff = await withDb((db) => provisionStaff(db, { role: 'admin', approvedPasskeys: 2 }));

      const byCode = await signInWithEmailCode(staff.email);
      expect(byCode.status).toBe(403);
      expect(byCode.message?.startsWith('[staff-passkey-required]')).toBe(true);
      expect(isStaffPasskeyRequiredError({ status: byCode.status, message: byCode.message })).toBe(true);
      expect(byCode.accessToken, '拒否された時はトークンが無い').toBeUndefined();

      const password = await setStaffPassword(staff.userId);
      const byPassword = await signInWithPasswordGrant(staff.email, password);
      expect(byPassword.status).toBe(403);
      expect(isStaffPasskeyRequiredError({ status: byPassword.status, message: byPassword.message })).toBe(true);
    });

    test(`FR-AUTH-013-AC-03 お客さんのパスキー・メールのコード・パスワードは入れて（旗は偽）、本物の更新（token_refresh）も通る (${viewport.name})`, async () => {
      const customer = await createCustomerWithPassword();
      const byPassword = await signInWithPasswordGrant(customer.email, customer.password);
      expect(byPassword.status, 'パスワード').toBe(200);
      const byCode = await signInWithEmailCode(customer.email);
      expect(byCode.status, 'メールのコード').toBe(200);

      const withPasskey = await withDb((db) => provisionPasskeyUser(db, { approvedPasskeys: 1 }));
      const byPasskey = await passkeyLogin(withPasskey.email, withPasskey.authenticators[0]);
      expect(byPasskey.status, 'パスキー').toBe(200);
      expect(byPasskey.claims.staff_passkeys_ok, 'お客さんには店員の印を付けない').not.toBe(true);

      // お客さんの本物の更新が通る（フックが token_refresh を邪魔しない）
      const refreshed = await refreshWith(byPassword.refreshToken as string);
      expect(refreshed.status, 'お客さんの更新').toBe(200);
      expect(claimsOf(refreshed.accessToken as string).sub).toBe(claimsOf(byPassword.accessToken as string).sub);
    });

    test(`FR-AUTH-013-AC-04 窓を閉じた後の店員の更新は拒否され（同じ更新トークンでも同じ拒否・session の行は残る）、前のアクセストークンは管理の表を読めない (${viewport.name})`, async ({}, testInfo) => {
      const scenario = await withDb((db) => runWindowScenario(db));

      expect(scenario.refreshInsideWindow.status, '窓が開いている間の更新は通る').toBe(200);
      expect(scenario.refreshAfterClose.status, '窓を閉じた後の更新').toBe(403);
      expect(isStaffPasskeyRequiredError({ status: scenario.refreshAfterClose.status, message: scenario.refreshAfterClose.message })).toBe(true);
      expect(scenario.refreshAfterCloseAgain.status, '同じ更新トークンをもう一度送っても').toBe(403);
      expect(scenario.refreshAfterCloseAgain.message).toBe(scenario.refreshAfterClose.message);
      expect(scenario.sessionRowRemains, 'auth.sessions の行は残る').toBe(true);

      // 拒否の後、前のアクセストークンは GoTrue 自身の /auth/v1/user ではまだ 200 だが、管理の表（has_permission）は passkey の amr が無いので0行
      expect(scenario.oldTokenUserStatus).toBe(200);
      expect(scenario.oldTokenAdminRows, '管理の表（非公開の記事）の行数').toBe(0);
      // 対照: 古い通行証をアプリの sessions に結び付けても0行（断る理由が amr だけ）。パスキーでログインした2本の店長は同じ行が読める
      expect(scenario.oldTokenBoundSessionLive, '結び付けた session は DB で生きている（0行の理由が amr だけだと言える）').toBe(true);
      expect(scenario.oldTokenBoundAdminRows, 'アプリに結び付けた古い通行証の行数').toBe(0);
      expect(scenario.controlAdminRows, '対照（パスキーの店長）の行数').toBeGreaterThanOrEqual(1);

      // auth.sessions.not_after の値を記録する（設定の session の最長との食い違いを後で読むため）
      testInfo.annotations.push({ type: 'auth.sessions.not_after', description: String(scenario.sessionNotAfter) });
      console.log(`auth.sessions.not_after = ${String(scenario.sessionNotAfter)}`);
    });
  });
}
