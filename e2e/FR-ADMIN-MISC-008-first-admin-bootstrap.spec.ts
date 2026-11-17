/**
 * FR-ADMIN-MISC-008 最初の店長を作るコマンド
 * 対応: FR-ADMIN-010-AC-01（作った店長がログインし、最初の TOTP の登録の画面まで進める）
 * パスワードの段は結合テスト（ARC-ADMIN-006）で確かめる（この試験は loginAsMemberLegacy でパスワードの段を飛ばす）
 *
 * コマンドの中身（bootstrapFirstAdmin と本物の deps）を、手元の Supabase に向けて直接呼ぶ。
 * 手元の DB には E2E の店長が残っているので、countActiveAdmins だけ 0 を返す物に替える。漏洩の照合は外へ出ないよう「問題なし」にする。
 * 作った利用者は試験の後に消す。この試験の Playwright の処理は、手元の Supabase にだけ書く。
 */
import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';
import { bootstrapFirstAdmin } from '../scripts/admin/bootstrap-core';
import { createBootstrapDeps } from '../scripts/admin/bootstrap-deps';
import { loginAsMemberLegacy } from './member-session-helpers';
import { viewports } from './order-fulfillment-test-utils';

// 会員のログインは確認コードとログインの Cookie をブラウザの通信に載せるので、通信記録（trace）を残さない。
// trace は worker 単位の設定なので、test.describe の中ではなくファイルの最上位に置く。
test.use({ trace: 'off' });

const ENV_KEYS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ALERT_AUDIT_URL'] as const;
const PASSWORD = `Bootstrap-E2e-${randomBytes(12).toString('hex')}`;

function localClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !isLocalUrl(url)) {
    throw new Error('最初の店長を作る試験は手元の Supabase にだけ向ける');
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

for (const [index, viewport] of viewports.entries()) {
  test.describe(`最初の店長を作るコマンド (${viewport.name} ${viewport.width}px)`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`FR-ADMIN-010-AC-01 コマンドで作った店長が、ログインの後に最初の TOTP の登録の画面へ進める (${viewport.name})`, async ({ page }) => {
      test.skip(true, '段4で消す機能: 最初の店長のコマンド admin:bootstrap（パスワード＋TOTP。本番用に残し、コードは変えない）。手元の DB では店員がアプリの画面から入れない（SEC-AUTH-040）。手元の手順は Task 10 の dev の店員のスクリプト');
      test.setTimeout(120_000);
      const client = localClient();
      const saved: Record<string, string | undefined> = {};
      for (const k of ENV_KEYS) saved[k] = process.env[k];
      let createdId: string | undefined;
      try {
        // logAudit は process.env から service role の client を作るので、手元の Supabase に向ける。
        process.env.SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
        delete process.env.ALERT_AUDIT_URL;
        const email = `e2e-bootstrap-${randomBytes(6).toString('hex')}@example.com`;
        const deps = {
          ...createBootstrapDeps(client),
          countActiveAdmins: async () => 0,
          checkPwned: async () => ({ status: 'ok' as const }),
        };
        const result = await bootstrapFirstAdmin(
          { email, password: PASSWORD, passwordConfirmation: PASSWORD, displayName: 'E2E 店長' },
          deps,
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        createdId = result.userId;

        await loginAsMemberLegacy(page, { userId: result.userId, email }, `198.19.${index}.${randomBytes(1)[0] % 250 + 1}`);
        await page.goto('/auth/verified');

        // 画面は TOTP が未登録だと案内の文を出した後に自動で登録を始め、QR コードと確認コードの入力を出す。終わりの状態を確かめる。
        await expect(page.getByText('認証アプリでQRコードを読み取り、生成されたコードを入力してください。')).toBeVisible();
        await expect(page.getByRole('img', { name: 'TOTP QR code' })).toBeVisible();
        await expect(page.getByRole('button', { name: '2要素認証を完了' })).toBeVisible();
      } finally {
        for (const k of ENV_KEYS) {
          if (saved[k] === undefined) delete process.env[k];
          else process.env[k] = saved[k];
        }
        if (createdId) await client.auth.admin.deleteUser(createdId);
      }
    });
  });
}
