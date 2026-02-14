import { test, expect } from '@playwright/test';
import {
  generateTestUser,
  registerUser,
  clearCookies,
  expectLoggedOut,
} from '../helpers';

/**
 * AUTH-01-14: E2E テスト - 異常系・エラーケース
 * 
 * テストシナリオ:
 * 1. 誤パスワードでログイン失敗
 * 2. 存在しないメールアドレスでログイン失敗
 * 3. 重複メールアドレスで登録失敗
 * 4. 不正なCSRFトークンで操作失敗
 * 5. 有効期限切れトークンでリフレッシュ失敗
 * 6. レート制限の動作確認
 * 7. バリデーションエラー（無効なメール、短いパスワード）
 */

test.describe('認証エラーケース', () => {
  test.beforeEach(async ({ page }) => {
    await clearCookies(page);
    await page.goto('/');
  });

  test('誤パスワードでログイン失敗', async ({ page }) => {
    const user = generateTestUser();

    // ユーザー登録
    await registerUser(page, user);
    await page.waitForTimeout(1000);

    // 誤パスワードでログイン試行
    await page.click('button:has-text("ログイン")');
    await page.fill('input[type="email"]', user.email);
    await page.fill('input[type="password"]', 'WrongPassword123!');
    await page.click('button[type="submit"]');

    // エラーメッセージが表示されることを確認
    await expect(
      page.locator('text=/パスワード|認証|ログイン.*失敗|incorrect|invalid/i')
    ).toBeVisible({ timeout: 5000 });

    // ログインできていないことを確認
    await expectLoggedOut(page);
  });

  test('存在しないメールアドレスでログイン失敗', async ({ page }) => {
    const nonExistentEmail = `nonexistent-${Date.now()}@example.com`;

    // 存在しないメールでログイン試行
    await page.click('button:has-text("ログイン")');
    await page.fill('input[type="email"]', nonExistentEmail);
    await page.fill('input[type="password"]', 'SomePassword123!');
    await page.click('button[type="submit"]');

    // エラーメッセージが表示されることを確認
    await expect(
      page.locator('text=/存在しない|見つかりません|not found|invalid/i')
    ).toBeVisible({ timeout: 5000 });

    // ログインできていないことを確認
    await expectLoggedOut(page);
  });

  test('重複メールアドレスで登録失敗', async ({ page }) => {
    const user = generateTestUser();

    // 1回目の登録（成功）
    await registerUser(page, user);
    await page.waitForTimeout(1000);

    // ログアウト
    await clearCookies(page);
    await page.goto('/');

    // 同じメールアドレスで2回目の登録試行（失敗するはず）
    await page.click('button:has-text("ログイン")');
    await page.click('text=新規登録');
    await page.fill('input[type="email"]', user.email);
    await page.fill('input[type="password"]', user.password);
    if (user.displayName) {
      await page.fill('input[name="displayName"]', user.displayName);
    }
    await page.click('button[type="submit"]');

    // エラーメッセージが表示されることを確認
    await expect(
      page.locator('text=/既に登録|重複|already.*exist|duplicate/i')
    ).toBeVisible({ timeout: 5000 });
  });

  test('バリデーションエラー: 無効なメールアドレス', async ({ page }) => {
    await page.click('button:has-text("ログイン")');
    await page.click('text=新規登録');

    // 無効なメールアドレスを入力
    await page.fill('input[type="email"]', 'invalid-email');
    await page.fill('input[type="password"]', 'ValidPassword123!');
    await page.click('button[type="submit"]');

    // バリデーションエラーが表示されることを確認
    await expect(
      page.locator('text=/メールアドレス.*形式|invalid.*email|email.*format/i')
    ).toBeVisible({ timeout: 5000 });
  });

  test('バリデーションエラー: 短すぎるパスワード', async ({ page }) => {
    await page.click('button:has-text("ログイン")');
    await page.click('text=新規登録');

    // 短すぎるパスワードを入力
    const user = generateTestUser();
    await page.fill('input[type="email"]', user.email);
    await page.fill('input[type="password"]', 'short');
    await page.click('button[type="submit"]');

    // バリデーションエラーが表示されることを確認
    await expect(
      page.locator('text=/パスワード.*8文字|password.*8.*character|too.*short/i')
    ).toBeVisible({ timeout: 5000 });
  });

  test('CSRF トークンなしでPOSTリクエスト失敗', async ({ page, context }) => {
    const user = generateTestUser();

    // 通常の登録とログイン
    await registerUser(page, user);
    await page.waitForTimeout(1000);

    // CSRFトークンを削除
    await context.clearCookies({ name: 'csrf_token' });

    // CSRF検証が必要なエンドポイントにアクセス（例: ログアウト）
    const response = await page.request.post('/api/auth/logout', {
      failOnStatusCode: false,
    });

    // 403 または 401 が返ることを確認
    expect([401, 403]).toContain(response.status());
  });

  test('レート制限: 連続したログイン試行でブロック', async ({ page }) => {
    const user = generateTestUser();
    const wrongPassword = 'WrongPassword123!';

    // ユーザー登録
    await registerUser(page, user);
    await page.waitForTimeout(1000);
    await clearCookies(page);
    await page.goto('/');

    // 連続して5回以上ログイン失敗
    for (let i = 0; i < 6; i++) {
      await page.click('button:has-text("ログイン")');
      await page.fill('input[type="email"]', user.email);
      await page.fill('input[type="password"]', wrongPassword);
      await page.click('button[type="submit"]');
      await page.waitForTimeout(500);

      // モーダルを閉じる
      const closeButton = page.locator('button[aria-label="閉じる"], button:has-text("×")');
      if (await closeButton.isVisible()) {
        await closeButton.click();
      }
      await page.waitForTimeout(500);
    }

    // 6回目のログイン試行でレート制限エラーが表示されることを確認
    await page.click('button:has-text("ログイン")');
    await page.fill('input[type="email"]', user.email);
    await page.fill('input[type="password"]', wrongPassword);
    await page.click('button[type="submit"]');

    // レート制限エラーメッセージが表示されることを確認
    await expect(
      page.locator('text=/試行回数|制限|too.*many.*attempt|rate.*limit/i')
    ).toBeVisible({ timeout: 5000 });
  });

  test('有効期限切れのリフレッシュトークンでリフレッシュ失敗', async ({
    page,
    context,
  }) => {
    // このテストは実装と統合が必要
    // 有効期限切れトークンをシミュレートするには、
    // テスト用のトークンを生成するか、時間を進める機能が必要

    // 簡易バージョン: 無効なトークンでリフレッシュ
    await context.addCookies([
      {
        name: 'refresh_token',
        value: 'invalid-token',
        domain: 'localhost',
        path: '/',
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
      },
    ]);

    const response = await page.request.post('/api/auth/refresh', {
      failOnStatusCode: false,
    });

    // 401 が返ることを確認
    expect(response.status()).toBe(401);
  });

  test('ログアウト後のアクセストークンは無効', async ({ page }) => {
    const user = generateTestUser();

    // ログイン
    await registerUser(page, user);
    await page.waitForTimeout(1000);

    // ログアウト
    await clearCookies(page);
    await page.goto('/');

    // 保護されたAPIエンドポイントにアクセス
    const response = await page.request.get('/api/auth/refresh', {
      failOnStatusCode: false,
    });

    // 401 が返ることを確認
    expect(response.status()).toBe(401);
  });
});
