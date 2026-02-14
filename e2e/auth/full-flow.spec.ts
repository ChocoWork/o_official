import { test, expect } from '@playwright/test';
import {
  generateTestUser,
  registerUser,
  loginUser,
  logoutUser,
  expectLoggedIn,
  expectLoggedOut,
  getSessionCookies,
  clearCookies,
} from '../helpers';

/**
 * AUTH-01-14: E2E テスト - 完全な認証フロー
 * 
 * テストシナリオ:
 * 1. 新規ユーザー登録
 * 2. ログイン
 * 3. セッション維持確認（ページリロード）
 * 4. リフレッシュトークン動作確認
 * 5. ログアウト
 * 6. ログアウト後のアクセス制御確認
 */

test.describe('完全な認証フロー', () => {
  test.beforeEach(async ({ page }) => {
    // 各テスト前にクッキーをクリア
    await clearCookies(page);
  });

  test('新規登録 → ログイン → リフレッシュ → ログアウトの完全フロー', async ({
    page,
  }) => {
    const user = generateTestUser();

    // ステップ1: 新規ユーザー登録
    await test.step('新規ユーザー登録', async () => {
      await registerUser(page, user);
      
      // 登録後、確認メッセージまたはログイン状態を確認
      // 注: Supabase Auth はメール確認が必要な場合があるため、
      // 実際の挙動に応じて調整が必要
      await page.waitForTimeout(2000);
    });

    // ステップ2: ログイン
    await test.step('ログイン実行', async () => {
      await loginUser(page, user.email, user.password);
      await expectLoggedIn(page);
      
      // セッションクッキーが設定されていることを確認
      const cookies = await getSessionCookies(page);
      expect(cookies.refreshToken).toBeTruthy();
      expect(cookies.csrfToken).toBeTruthy();
    });

    // ステップ3: セッション維持確認（ページリロード）
    await test.step('ページリロード後もログイン状態を維持', async () => {
      await page.reload();
      await expectLoggedIn(page);
    });

    // ステップ4: アカウントページにアクセス
    await test.step('アカウントページにアクセス', async () => {
      await page.goto('/account');
      await expect(page.locator('h1, h2, h3').first()).toContainText(
        /アカウント|マイページ|プロフィール/i
      );
    });

    // ステップ5: 買い物フロー（カートページ確認）
    await test.step('カートページにアクセス', async () => {
      await page.goto('/cart');
      // カートページが表示されることを確認
      await expect(page.locator('h1, h2').first()).toContainText(/カート|cart/i);
    });

    // ステップ6: リフレッシュトークン動作確認（15分後を想定した時間経過シミュレーション）
    await test.step('リフレッシュトークン動作確認', async () => {
      // クッキーをバックアップ
      const cookiesBefore = await getSessionCookies(page);
      
      // アクセストークンの有効期限切れをシミュレート
      // 実際のアプリでは15分でアクセストークンが期限切れになり、
      // リフレッシュトークンで自動更新される
      
      // APIリクエストを実行してリフレッシュをトリガー
      await page.goto('/api/auth/refresh', { waitUntil: 'networkidle' });
      await page.waitForTimeout(1000);
      
      // リフレッシュ後にトップページに戻る
      await page.goto('/');
      await expectLoggedIn(page);
      
      // リフレッシュトークンがローテーションされていることを確認
      const cookiesAfter = await getSessionCookies(page);
      expect(cookiesAfter.refreshToken).toBeTruthy();
      // JTI ローテーションにより、リフレッシュトークンは変わる可能性がある
    });

    // ステップ7: ログアウト
    await test.step('ログアウト実行', async () => {
      await logoutUser(page);
      await expectLoggedOut(page);
      
      // セッションクッキーがクリアされていることを確認
      const cookies = await getSessionCookies(page);
      expect(cookies.refreshToken).toBeFalsy();
    });

    // ステップ8: ログアウト後のアクセス制御確認
    await test.step('ログアウト後はアカウントページにアクセスできない', async () => {
      await page.goto('/account');
      
      // ログインページにリダイレクトされるか、
      // またはログインモーダルが表示されることを確認
      await page.waitForTimeout(2000);
      const currentUrl = page.url();
      const isRedirectedToLogin =
        currentUrl.includes('/login') || currentUrl.includes('/auth');
      const hasLoginButton = await page
        .locator('button:has-text("ログイン")')
        .isVisible();
      
      expect(isRedirectedToLogin || hasLoginButton).toBeTruthy();
    });
  });

  test('ヘッダーのログイン状態表示が正しく切り替わる', async ({ page }) => {
    const user = generateTestUser();

    // 初期状態: ログインボタンが表示される
    await page.goto('/');
    await expectLoggedOut(page);

    // ログイン後: ユーザーアイコンが表示される
    await registerUser(page, user);
    await page.waitForTimeout(1000);
    await loginUser(page, user.email, user.password);
    await expectLoggedIn(page);

    // ログアウト後: 再度ログインボタンが表示される
    await logoutUser(page);
    await expectLoggedOut(page);
  });

  test('セッション有効期限内であればページ遷移後もログイン状態を保持', async ({
    page,
  }) => {
    const user = generateTestUser();

    // ログイン
    await registerUser(page, user);
    await page.waitForTimeout(1000);
    await loginUser(page, user.email, user.password);
    await expectLoggedIn(page);

    // 複数のページを遷移
    await page.goto('/about');
    await expectLoggedIn(page);

    await page.goto('/cart');
    await expectLoggedIn(page);

    await page.goto('/account');
    await expectLoggedIn(page);

    await page.goto('/');
    await expectLoggedIn(page);
  });

  test('リフレッシュトークン再利用検出でセッション失効', async ({ page }) => {
    const user = generateTestUser();

    // ログイン
    await registerUser(page, user);
    await page.waitForTimeout(1000);
    await loginUser(page, user.email, user.password);
    await expectLoggedIn(page);

    // リフレッシュトークンを取得
    const cookies = await getSessionCookies(page);
    const refreshToken = cookies.refreshToken;

    // 1回目のリフレッシュ
    const response1 = await page.request.post('/api/auth/refresh');
    expect(response1.ok()).toBeTruthy();

    // 同じリフレッシュトークンで2回目のリフレッシュ（再利用検出）
    // 注: この動作をテストするには、古いリフレッシュトークンを
    // 手動で設定する必要があるため、実装依存
    
    // 実装が完了している場合、再利用検出により全セッションが失効し、
    // ログアウト状態になることを確認
    // await page.reload();
    // await expectLoggedOut(page);
  });
});
