import { expect, test, type Page } from '@playwright/test';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

/** 方針本文の入れ物（サイトの枠の main）。ヘッダー・モーダルなど頁の外の字を含めないため */
const policyBody = (page: Page) => page.getByRole('main');

/** 見出し h2 を持つ節 */
const sectionOf = (page: Page, headingName: string) =>
  page.locator('section').filter({ has: page.getByRole('heading', { level: 2, name: headingName }) });

for (const vp of viewports) {
  test.describe(`FR-PRIVACY-005 /privacy の文面 (${vp.name} ${vp.width}px)`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/privacy');
    });

    test(`FREQ-100-AC-02 ${vp.name}: お問い合わせ先メール privacy@lefildesheures.com が表示される`, async ({ page }) => {
      await expect(page.getByText('privacy@lefildesheures.com')).toBeVisible();
    });

    for (const path of ['/privacy', '/terms']) {
      test(`FREQ-101-AC-02 ${vp.name}: ${path} の節の見出し h2 の字が本文段落より大きい`, async ({ page }) => {
        await page.goto(path);
        const bodySize = await page
          .locator('section p')
          .first()
          .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
        const headingSize = await page
          .getByRole('heading', { level: 2 })
          .first()
          .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

        expect(headingSize).toBeGreaterThan(bodySize);
      });
    }

    test(`FR-PRIVACY-001-AC-01 ${vp.name}: 頁の h1 と元からある節の h2 が表示される`, async ({ page }) => {
      await expect(page.getByRole('heading', { level: 1, name: /Privacy Policy/ })).toBeVisible();
      for (const name of [
        '個人情報の取り扱いについて',
        '1. 個人情報の定義',
        '2. 個人情報の収集方法',
        '3. 個人情報の利用目的',
        '4. 個人情報の第三者提供',
        '8. 個人情報の安全管理',
        '9. Cookie 及び外部サービスの利用',
      ]) {
        await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
      }
    });

    test(`FR-PRIVACY-002-AC-01 ${vp.name}: title と meta description が決めた字で出る`, async ({ page }) => {
      await expect(page).toHaveTitle('Privacy Policy | Le Fil des Heures');
      await expect(page.locator('meta[name="description"]')).toHaveAttribute(
        'content',
        'Le Fil des Heures のプライバシーポリシー。個人情報の取扱い、利用目的、第三者提供、お問い合わせ窓口をご案内します。',
      );
    });

    test(`SEC-PRIVACY-011-AC-01 ${vp.name}: Stripe の名前が表示される`, async ({ page }) => {
      await expect(policyBody(page), 'Stripe の名前').toContainText('Stripe', { useInnerText: true });
    });

    test(`SEC-PRIVACY-011-AC-01 ${vp.name}: Resend・Supabase・Cloudflare Turnstile の名前が表示される`, async ({ page }) => {
      const body = policyBody(page);
      for (const service of ['Resend', 'Supabase', 'Cloudflare Turnstile']) {
        await expect(body, `${service} の名前`).toContainText(service, { useInnerText: true });
      }
    });

    test(`SEC-PRIVACY-011-AC-02 ${vp.name}: 「メールマガジン」の字が表示されない`, async ({ page }) => {
      await expect(policyBody(page)).toBeVisible();
      await expect(policyBody(page)).not.toContainText('メールマガジン', { useInnerText: true });
    });

    test(`SEC-PRIVACY-017-AC-01 ${vp.name}: 12 節に窓口のメールと /contact のお問い合わせフォームのリンクが表示される`, async ({ page }) => {
      const section = sectionOf(page, '12. お問い合わせ窓口');
      await expect(section.getByText('privacy@lefildesheures.com')).toBeVisible();
      const link = section.getByRole('link', { name: 'お問い合わせフォーム' });
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute('href', '/contact');
    });

    test(`SEC-PRIVACY-019-AC-01 ${vp.name}: 10 節に本人であることを確認した上で応える旨が表示される`, async ({ page }) => {
      const section = sectionOf(page, '10. 保有個人データの開示・訂正・利用停止等の請求');
      await expect(section).toBeVisible();
      await expect(section).toContainText('ご本人であることを確認', { useInnerText: true });
    });
  });
}
