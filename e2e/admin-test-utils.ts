import type { Page } from '@playwright/test';

/**
 * 管理画面が裏で読む API と、セッション更新（refresh）を固定する。
 *
 * /admin は開くだけで、spec が見ていない API も読む（既定の KPI タブは Meta 連携の状態、会計タブは
 * 法定保存の状態）。モックしないと実サーバーが 401 を返し、clientFetch が /api/auth/refresh を呼ぶ。
 * refresh も 401 だとセッション切れとしてログアウト扱いになり「アクセス権限がありません」に落ちる。
 * 429（回数制限）なら何も起きずに通るので、回数制限の残り具合で結果が入れ替わっていた。
 * 保存・削除の POST も、CSRF cookie が無いと送る前に refresh を呼ぶ。
 *
 * spec 側の page.route は後から登録したほうが先に効くので、各 spec のモックより先に呼ぶ。
 * refresh の振る舞いそのものを確かめる spec（FR-ADMIN-057）では使わない。
 */
export async function mockAdminBackgroundApis(page: Page): Promise<void> {
  await page.route('**/api/auth/refresh', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'set-cookie': 'sb-csrf-token=e2e-csrf-token; Path=/; SameSite=Lax' },
      body: JSON.stringify({ ok: true }),
    }),
  );

  // KPI タブの Meta 連携（src/components/MetaKpiConnection.tsx）。未連携の状態を返す
  await page.route('**/api/admin/kpi/meta', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: { configured: true, missing: [], connected: false, connection: null },
      }),
    }),
  );

  // 会計タブの法定保存の状態（src/components/CostProfitSection.tsx）。状態なしを返す
  await page.route('**/api/admin/legal-archive/status**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: null }),
    }),
  );

  // ORDER タブと KPI 画面の要対応・要確認（src/components/AttentionInbox.tsx）。未処理なしを返す
  await page.route('**/api/admin/order-attention', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { exceptions: [], reviews: [], counts: { exceptions: 0, reviews: 0 } } }),
    }),
  );
}
