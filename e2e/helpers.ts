import { Page, expect } from '@playwright/test';

/**
 * テスト用ヘルパー関数集
 * 認証フローで使用する共通処理
 */

export interface TestUser {
  email: string;
  password: string;
  displayName?: string;
  kanaName?: string;
}

/**
 * ランダムなテストユーザーを生成
 */
export function generateTestUser(): TestUser {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(7);
  return {
    email: `test-${timestamp}-${random}@example.com`,
    password: 'TestPassword123!',
    displayName: 'テスト太郎',
    kanaName: 'テストタロウ',
  };
}

/**
 * ユーザー登録を実行
 */
export async function registerUser(page: Page, user: TestUser) {
  await page.goto('/login');
  
  // 登録タブに切り替え
  await page.click('button:has-text("新規登録")');
  
  // フォームに入力
  if (user.displayName) {
    await page.fill('input#name', user.displayName);
  }
  await page.fill('input#email', user.email);
  await page.fill('input#password', user.password);
  
  // 送信
  await page.click('button[type="submit"]:has-text("新規登録")');
  
  // 成功メッセージまたはリダイレクトを待つ
  await page.waitForTimeout(2000);
}

/**
 * ログインを実行
 */
export async function loginUser(page: Page, email: string, password: string) {
  await page.goto('/login');
  
  // ログインタブに切り替え（デフォルトはログインタブ）
  await page.click('button:has-text("ログイン")');
  
  // フォームに入力
  await page.fill('input#email', email);
  await page.fill('input#password', password);
  
  // 送信
  await page.click('button[type="submit"]:has-text("ログイン")');
  
  // ログイン成功を待つ（ユーザーアイコンが変わる or ページ遷移）
  await page.waitForTimeout(2000);
}

/**
 * ログアウトを実行
 */
export async function logoutUser(page: Page) {
  // APIを直接呼び出してログアウト
  await page.request.post('/api/auth/logout');
  
  // ページをリロードしてログアウトを反映
  await page.reload();
  await page.waitForTimeout(1000);
}

/**
 * ログイン状態を確認
 */
export async function expectLoggedIn(page: Page) {
  await page.goto('/');
  await expect(page.locator('i.ri-user-fill')).toBeVisible({ timeout: 5000 });
}

/**
 * 非ログイン状態を確認
 */
export async function expectLoggedOut(page: Page) {
  await page.goto('/');
  await expect(page.locator('i.ri-user-line')).toBeVisible({ timeout: 5000 });
}

/**
 * クッキーをクリア
 */
export async function clearCookies(page: Page) {
  const context = page.context();
  await context.clearCookies();
}

/**
 * セッションクッキーを取得
 */
export async function getSessionCookies(page: Page) {
  const context = page.context();
  const cookies = await context.cookies();
  return {
    accessToken: cookies.find((c) => c.name === 'access_token')?.value,
    refreshToken: cookies.find((c) => c.name === 'refresh_token')?.value,
    csrfToken: cookies.find((c) => c.name === 'csrf_token')?.value,
  };
}

/**
 * APIリクエストを直接実行（テストデータセットアップ用）
 */
export async function apiRequest(
  page: Page,
  method: string,
  path: string,
  data?: any
) {
  const response = await page.request[method.toLowerCase()](path, {
    data,
    headers: {
      'Content-Type': 'application/json',
    },
  });
  return response;
}
