import { test, expect, type Page } from '@playwright/test';
import { injectTurnstileToken, stubTurnstileScript } from './turnstile-test-utils';

// FREQ-331: 再設定メール送信後の結果画面に、図 → 見出し → 補足 → 注意書き → 主アクション
// の優先順位を見た目で示す。
const viewports = [
  // 注意書きの折り返しは幅が最も狭い iPhone SE で先に破れるので、この spec だけ 375px を足す。
  { name: 'iphone-se', width: 375, height: 667 },
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

const EMAIL = 'user@example.com';

const mockSessionNotReady = async (page: Page) => {
  await page.route('**/api/auth/password-reset/session', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ready: false }),
    });
  });
};

const sendResetMail = async (page: Page) => {
  await injectTurnstileToken(page);
  await page.locator('#email').fill(EMAIL);
  await page.getByRole('button', { name: '再設定メールを送信' }).click();
};

for (const viewport of viewports) {
  test.describe(`FR-PWRESET-006 reset mail sent visual hierarchy (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      // 実 CDN はスイート並列実行時に 429 を返すので、ウィジェットはスタブで出す。
      await stubTurnstileScript(page);
      await mockSessionNotReady(page);
      await page.route('**/api/auth/password-reset/request', async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      });
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/auth/password-reset');
    });

    test('AC-01: 結果の先頭に封筒の図を置き、パスワード更新の図は出さない', async ({ page }) => {
      await sendResetMail(page);

      await expect(page.getByTestId('auth-result-icon-mail')).toBeVisible();
      await expect(page.getByTestId('auth-result-icon-password')).toHaveCount(0);
    });

    test('AC-02: ページ見出しを畳み、結果のタイトルを唯一の h1 にする', async ({ page }) => {
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('パスワード再設定');

      await sendResetMail(page);

      const heading = page.getByRole('heading', { level: 1 });
      await expect(heading).toHaveCount(1);
      await expect(heading).toHaveText('再設定メールを送信しました');

      // h1 の既定は Didot（セリフ）。指定を外すとページ見出しと書体が食い違う。
      const fontFamily = await heading.evaluate((el) => getComputedStyle(el).fontFamily);
      expect(fontFamily).toContain('acumin-pro');
    });

    test('AC-03: 注意書きはグレーの面に左寄せでまとめる', async ({ page }) => {
      await sendResetMail(page);

      const note = page.getByTestId('auth-result-note');
      await expect(note).toBeVisible();
      await expect(note.getByText('再送信すると前回のリンクは無効です')).toBeVisible();
      await expect(note.getByText(/迷惑メールフォルダ/)).toBeVisible();

      const style = await note.evaluate((el) => {
        const s = getComputedStyle(el);
        return { background: s.backgroundColor, textAlign: s.textAlign };
      });
      expect(style.background).toBe('rgb(237, 237, 237)');
      expect(style.textAlign).toBe('left');
    });

    test('AC-04: 隙間を意味の遠さに応じた 4 段階にする', async ({ page }) => {
      await sendResetMail(page);
      await expect(page.getByTestId('auth-result-note')).toBeVisible();

      // 隙間は行ボックスで測る。h1 の line-height が leading を足すので、
      // CSS の margin をそのまま比べても見た目の順序は分からない。
      const g = await page.evaluate(() => {
        const textRect = (el: Element) => {
          const range = document.createRange();
          range.selectNodeContents(el);
          return range.getBoundingClientRect();
        };
        const icon = document
          .querySelector('[data-testid="auth-result-icon-mail"]')!
          .getBoundingClientRect();
        const title = textRect(document.querySelector('h1')!);
        const detail = textRect(
          document.querySelector('[role="status"] span.block')!,
        );
        const note = document
          .querySelector('[data-testid="auth-result-note"]')!
          .getBoundingClientRect();
        const action = textRect(
          Array.from(document.querySelectorAll('p')).find((p) =>
            /後に再送可能/.test(p.textContent ?? ''),
          )!,
        );
        const links = textRect(
          Array.from(document.querySelectorAll('button')).find((b) =>
            (b.textContent ?? '').includes('別のアドレス'),
          )!,
        );
        return {
          titleToDetail: detail.top - title.bottom,
          iconToTitle: title.top - icon.bottom,
          detailToNote: note.top - detail.bottom,
          noteToAction: action.top - note.bottom,
          actionToLinks: links.top - action.bottom,
        };
      });

      expect(g.titleToDetail).toBeLessThan(g.iconToTitle);
      expect(g.iconToTitle).toBeLessThan(g.detailToNote);
      expect(g.detailToNote).toBeLessThan(g.noteToAction);
      // 最も広い段は主アクションの上下で共通にする。ここが食い違うと、
      // 主アクションが補助リンク側のまとまりに見える。
      expect(Math.abs(g.noteToAction - g.actionToLinks)).toBeLessThan(3);
    });

    test('AC-01: パスワード更新の完了は南京錠の図で示す', async ({ page }) => {
      // 後から追加した route が優先されるので、confirm モードへ上書きする。
      await page.route('**/api/auth/password-reset/session', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ready: true, email: EMAIL }),
        });
      });
      await page.route('**/api/auth/password-reset/confirm', async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      });
      await page.goto('/auth/password-reset');

      await page.locator('#newPassword').fill('Password123456789!');
      // FREQ-333: 確認欄が埋まるまで送信ボタンは無効。
      await page.locator('#confirmNewPassword').fill('Password123456789!');
      await page.getByRole('button', { name: 'パスワードを更新' }).click();

      await expect(page.getByTestId('auth-result-icon-password')).toBeVisible();
      await expect(page.getByTestId('auth-result-icon-mail')).toHaveCount(0);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        'パスワードを更新しました',
      );
    });

    test('AC-06: 注意書きは 3 行で、どの画面幅でも折り返さない', async ({ page }) => {
      await sendResetMail(page);

      const note = page.getByTestId('auth-result-note');
      await expect(note).toBeVisible();

      const lines = await note.evaluate((el) => {
        const spans = Array.from(el.querySelectorAll('span.block'));
        return spans.map((span) => {
          const range = document.createRange();
          range.selectNodeContents(span);
          // ブロック要素の getClientRects() は行ではなくボーダーボックスを返すので、
          // 行数は Range で数える。
          return range.getClientRects().length;
        });
      });
      expect(lines).toEqual([1, 1, 1]);
    });

    test('AC-07: 結果の宣言はひとまとまりに見える間隔にする', async ({ page }) => {
      await sendResetMail(page);
      await expect(page.getByTestId('auth-result-note')).toBeVisible();

      // 隙間は行ボックスで測る。h1 の line-height が leading を足すので、
      // CSS の margin を揃えても見た目は揃わない。
      const gaps = await page.evaluate(() => {
        const textRect = (el: Element) => {
          const range = document.createRange();
          range.selectNodeContents(el);
          return range.getBoundingClientRect();
        };
        const icon = document
          .querySelector('[data-testid="auth-result-icon-mail"]')!
          .getBoundingClientRect();
        const title = textRect(document.querySelector('h1')!);
        const detail = textRect(
          document.querySelector('[role="status"] span.block')!,
        );
        const note = document
          .querySelector('[data-testid="auth-result-note"]')!
          .getBoundingClientRect();
        return {
          iconToTitle: title.top - icon.bottom,
          titleToDetail: detail.top - title.bottom,
          detailToNote: note.top - detail.bottom,
        };
      });

      const withinGroup = Math.max(gaps.iconToTitle, gaps.titleToDetail);
      expect(withinGroup).toBeLessThanOrEqual(gaps.detailToNote / 2);
    });

    test('AC-05: 結果のタイトルはどの画面幅でも 1 行に収める', async ({ page }) => {
      await sendResetMail(page);
      // 結果画面へ差し替わる前の h1 を掴むと、評価時には要素が外れていて
      // 矩形が 0 個になる。差し替わりを待ってから測る。
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        '再設定メールを送信しました',
      );

      // 13 文字の見出しが折り返すと、最後の 1 文字だけが次行に落ちて締まりがなくなる。
      // 行数は Range で数える。ブロック要素の getClientRects() は行ではなく
      // ボーダーボックスを返すので、何行でも 1 になり検証にならない。
      const lines = await page.getByRole('heading', { level: 1 }).evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return range.getClientRects().length;
      });
      expect(lines).toBe(1);
    });
  });
}

test('AC-04: Bot 検証ウィジェットと再送信ボタンの間も最も広い段に揃える', async ({ page }) => {
  // クールダウンは 60 秒。実時間で待つとテストが止まるので仮想時計で送る。
  await page.clock.install();
  await stubTurnstileScript(page);
  await page.route('**/api/auth/password-reset/session', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ready: false }),
    });
  });
  await page.route('**/api/auth/password-reset/request', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.goto('/auth/password-reset');
  await sendResetMail(page);
  // 残り時間が出るまで待ってから進める。先に進めると cooldownStartedAt が
  // 進めたあとの時刻で捕まり、60 秒が一向に減らない。
  await expect(page.getByText(/後に再送可能/)).toBeVisible();
  await page.clock.fastForward(61_000);
  await expect(page.getByRole('button', { name: '再送信する' })).toBeVisible();

  const gap = await page.evaluate(() => {
    const button = document.querySelector(
      '.auth-form-grid--result > button[type="button"]',
    );
    const previous = button?.previousElementSibling ?? null;
    if (!button || !previous) return null;
    const prev = previous.getBoundingClientRect();
    return button.getBoundingClientRect().top - (prev.top + prev.height);
  });

  expect(gap).not.toBeNull();
  expect(Math.abs(gap! - 30)).toBeLessThan(1);
});
