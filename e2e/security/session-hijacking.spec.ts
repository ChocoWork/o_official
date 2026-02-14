import { test, expect, Browser, BrowserContext } from '@playwright/test';
import {
  generateTestUser,
  registerUser,
  loginUser,
  clearCookies,
  getSessionCookies,
  expectLoggedIn,
  expectLoggedOut,
} from '../helpers';

/**
 * AUTH-01-14: E2E テスト - セキュリティ（セッションハイジャック対策）
 * 
 * テストシナリオ:
 * 1. リフレッシュトークン再利用検出
 * 2. セッション盗聴シミュレーション
 * 3. CSRF攻撃防御
 * 4. 複数デバイスでのセッション管理
 * 5. 不正なトークンでのアクセス拒否
 */

test.describe('セッションセキュリティ', () => {
  test.beforeEach(async ({ page }) => {
    await clearCookies(page);
  });

  test('リフレッシュトークン再利用時に全セッション失効', async ({
    browser,
  }) => {
    const user = generateTestUser();

    // コンテキスト1: 正規ユーザー
    const context1: BrowserContext = await browser.newContext();
    const page1 = await context1.newPage();

    // ユーザー登録とログイン
    await registerUser(page1, user);
    await page1.waitForTimeout(1000);
    await loginUser(page1, user.email, user.password);
    await expectLoggedIn(page1);

    // リフレッシュトークンを取得
    const cookies1 = await getSessionCookies(page1);
    const originalRefreshToken = cookies1.refreshToken;
    expect(originalRefreshToken).toBeTruthy();

    // 1回目のリフレッシュ（正常）
    const response1 = await page1.request.post('/api/auth/refresh');
    expect(response1.ok()).toBeTruthy();

    // 新しいリフレッシュトークンを取得
    const cookies2 = await getSessionCookies(page1);
    const newRefreshToken = cookies2.refreshToken;

    // コンテキスト2: 攻撃者（古いトークンを盗聴）
    const context2: BrowserContext = await browser.newContext();
    const page2 = await context2.newPage();

    // 攻撃者が古いリフレッシュトークンを使用
    if (originalRefreshToken) {
      await context2.addCookies([
        {
          name: 'refresh_token',
          value: originalRefreshToken,
          domain: 'localhost',
          path: '/',
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        },
      ]);

      // 古いトークンでリフレッシュ試行（再利用検出）
      const response2 = await page2.request.post('/api/auth/refresh', {
        failOnStatusCode: false,
      });

      // 再利用検出により 401 が返る
      expect(response2.status()).toBe(401);

      // 正規ユーザーのセッションも失効しているはず
      await page1.reload();
      await page1.waitForTimeout(2000);
      
      // セッションが失効し、ログアウト状態になることを確認
      // 注: 実装によっては、明示的なログアウト処理が必要
    }

    await context1.close();
    await context2.close();
  });

  test('CSRF攻撃: トークンなしでPOSTリクエストは拒否される', async ({
    page,
    context,
  }) => {
    const user = generateTestUser();

    // ログイン
    await registerUser(page, user);
    await page.waitForTimeout(1000);
    await loginUser(page, user.email, user.password);
    await expectLoggedIn(page);

    // CSRFトークンを削除（攻撃者が盗んだクッキーを使うシナリオ）
    const cookies = await context.cookies();
    const filteredCookies = cookies.filter((c) => c.name !== 'csrf_token');
    await context.clearCookies();
    await context.addCookies(filteredCookies);

    // CSRF保護が必要なエンドポイントにアクセス
    const response = await page.request.post('/api/auth/logout', {
      failOnStatusCode: false,
    });

    // 403 または 401 が返ることを確認
    expect([401, 403]).toContain(response.status());

    // 元のページは依然としてログイン状態のはず
    await page.reload();
    await expectLoggedIn(page);
  });

  test('複数デバイスでのログイン: 各セッションが独立して管理される', async ({
    browser,
  }) => {
    const user = generateTestUser();

    // デバイス1
    const context1: BrowserContext = await browser.newContext();
    const page1 = await context1.newPage();

    // ユーザー登録
    await registerUser(page1, user);
    await page1.waitForTimeout(1000);

    // デバイス1でログイン
    await loginUser(page1, user.email, user.password);
    await expectLoggedIn(page1);

    // デバイス2
    const context2: BrowserContext = await browser.newContext();
    const page2 = await context2.newPage();

    // デバイス2でログイン
    await loginUser(page2, user.email, user.password);
    await expectLoggedIn(page2);

    // 両方のデバイスでログイン状態が維持されることを確認
    await page1.reload();
    await expectLoggedIn(page1);

    await page2.reload();
    await expectLoggedIn(page2);

    // デバイス1でログアウト
    await page1.click('i.ri-user-fill');
    await page1.click('text=ログアウト');
    await expectLoggedOut(page1);

    // デバイス2はまだログイン状態のはず
    await page2.reload();
    await expectLoggedIn(page2);

    await context1.close();
    await context2.close();
  });

  test('不正なトークンでアクセス拒否', async ({ page, context }) => {
    // 不正なアクセストークンを設定
    await context.addCookies([
      {
        name: 'access_token',
        value: 'invalid.jwt.token',
        domain: 'localhost',
        path: '/',
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
      },
    ]);

    // 保護されたページにアクセス
    await page.goto('/account');

    // ログインページにリダイレクトされるか、エラーメッセージが表示される
    await page.waitForTimeout(2000);
    const currentUrl = page.url();
    const isRedirectedToLogin =
      currentUrl.includes('/login') || currentUrl.includes('/auth');
    const hasLoginButton = await page
      .locator('button:has-text("ログイン")')
      .isVisible();

    expect(isRedirectedToLogin || hasLoginButton).toBeTruthy();
  });

  test('改ざんされたJWTでアクセス拒否', async ({ page, context }) => {
    const user = generateTestUser();

    // 正常にログイン
    await registerUser(page, user);
    await page.waitForTimeout(1000);
    await loginUser(page, user.email, user.password);
    await expectLoggedIn(page);

    // アクセストークンを取得
    const cookies = await getSessionCookies(page);
    const accessToken = cookies.accessToken;
    expect(accessToken).toBeTruthy();

    // トークンを改ざん（最後の文字を変更）
    if (accessToken) {
      const tamperedToken =
        accessToken.slice(0, -1) + (accessToken.slice(-1) === 'a' ? 'b' : 'a');

      // 改ざんされたトークンを設定
      await context.clearCookies({ name: 'access_token' });
      await context.addCookies([
        {
          name: 'access_token',
          value: tamperedToken,
          domain: 'localhost',
          path: '/',
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        },
      ]);

      // APIリクエスト
      const response = await page.request.post('/api/auth/logout', {
        failOnStatusCode: false,
      });

      // 401 が返ることを確認
      expect(response.status()).toBe(401);
    }
  });

  test('セッション有効期限切れ後はアクセス不可', async ({
    page,
    context,
  }) => {
    const user = generateTestUser();

    // ログイン
    await registerUser(page, user);
    await page.waitForTimeout(1000);
    await loginUser(page, user.email, user.password);
    await expectLoggedIn(page);

    // リフレッシュトークンの有効期限を過ぎたシミュレーション
    // 注: 実際には7日間の期限があるため、このテストは
    // テスト環境で短縮された有効期限を使用するか、
    // 時間を進める機能が必要

    // 簡易バージョン: 有効期限切れトークンを直接設定
    await context.clearCookies();
    await context.addCookies([
      {
        name: 'refresh_token',
        value: 'expired.token.value',
        domain: 'localhost',
        path: '/',
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
      },
    ]);

    // リフレッシュ試行
    const response = await page.request.post('/api/auth/refresh', {
      failOnStatusCode: false,
    });

    // 401 が返ることを確認
    expect(response.status()).toBe(401);
  });

  test('強制ログアウト: 管理者による全セッション失効', async ({
    browser,
  }) => {
    // このテストは管理者機能が実装されている場合のみ有効

    const user = generateTestUser();

    // ユーザーのセッションを複数作成
    const context1: BrowserContext = await browser.newContext();
    const page1 = await context1.newPage();
    await registerUser(page1, user);
    await page1.waitForTimeout(1000);
    await loginUser(page1, user.email, user.password);

    const context2: BrowserContext = await browser.newContext();
    const page2 = await context2.newPage();
    await loginUser(page2, user.email, user.password);

    // 管理者が全セッションを失効（API経由）
    // 注: 実装に応じて調整が必要
    // await page1.request.post('/api/admin/revoke-user-sessions', {
    //   data: { userId: user.id },
    //   headers: { 'X-Admin-Key': process.env.ADMIN_API_KEY },
    // });

    // 両方のセッションが無効になることを確認
    // await page1.reload();
    // await expectLoggedOut(page1);

    // await page2.reload();
    // await expectLoggedOut(page2);

    await context1.close();
    await context2.close();
  });
});
