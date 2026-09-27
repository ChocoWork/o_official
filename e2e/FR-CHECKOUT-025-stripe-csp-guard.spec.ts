import { expect, test, type Frame, type Page } from '@playwright/test';
import { selectPaymentMethod } from './checkout-test-utils';

const VIEWPORTS = [
  { name: 'mobile', width: 390 },
  { name: 'tablet', width: 768 },
  { name: 'desktop', width: 1280 },
] as const;

type CspViolation = { directive: string; blocked: string; source: string };

/** CSP ブロックは操作の後から非同期に起きる。待つべき完了条件が無いので、一定時間だけ観測する。 */
const OBSERVE_MS = 3_000;

/** 支払方法セクションに描画される Stripe の iframe（FR-CHECKOUT-022 と同じ拾い方）。 */
function paymentIframe(page: Page) {
  return page
    .locator('section.checkout-section')
    .filter({ hasText: '支払方法の選択' })
    .locator('iframe')
    .first();
}

/**
 * ページ本体の文書で発生した CSP 違反を記録する。
 * Stripe の iframe の内側で読み込まれるもの（m.stripe.network 等）には Stripe 側の CSP が
 * 適用されるので、ここに現れるのは当サイトの CSP で止められたものだけになる。
 */
async function recordCspViolations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const store = window as unknown as { __cspViolations: CspViolation[] };
    store.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      store.__cspViolations.push({
        directive: event.effectiveDirective || event.violatedDirective,
        blocked: event.blockedURI,
        source: event.sourceFile,
      });
    });
  });
}

/**
 * 外部リソース（http(s) の URL）の読み込みブロックだけを返す。
 * 自前バンドルの Zod が eval の可否を試して止められる違反（blocked: "eval"）は、
 * 失敗時に通常処理へ切り替わり機能に影響しないので対象外とする。
 */
async function blockedExternalResources(page: Page): Promise<CspViolation[]> {
  const violations = await page.evaluate(
    () => (window as unknown as { __cspViolations: CspViolation[] }).__cspViolations,
  );
  return violations.filter((violation) => /^https?:/.test(violation.blocked));
}

async function openCheckoutAndWaitForPaymentForm(page: Page): Promise<void> {
  await page.goto('/checkout');
  // CSP で Stripe の読み込みが止められると決済フォームは出ないので、
  // 「決済フォームが表示された」か「外部リソースのブロックが起きた」のどちらかまで待つ。
  await expect
    .poll(
      async () =>
        (await paymentIframe(page).isVisible()) ||
        (await blockedExternalResources(page)).length > 0,
      { timeout: 30_000 },
    )
    .toBe(true);
}

async function paymentElementFrame(page: Page): Promise<Frame> {
  const isPaymentElement = (frame: Frame) => /elements-inner-payment/.test(frame.url());
  await expect.poll(() => page.frames().some(isPaymentElement)).toBe(true);
  return page.frames().find(isPaymentElement)!;
}

test.describe('FR-CHECKOUT-025 checkout の CSP が Stripe の決済フォームを妨げない', () => {
  test.describe.configure({ timeout: 90_000 });
  test.use({ locale: 'ja-JP' });

  // CSP の実際の効き目は本物の Stripe.js と決済フォームでしか確かめられない。
  // create-session は session_id クッキーに紐づく carts テーブルを直接読むので、
  // FR-CHECKOUT-022 と同じく実カートを作り、Stripe テストモードのセッションを使う。
  test.beforeEach(async ({ page }) => {
    await recordCspViolations(page);
    await page.goto('/');
    const seeded = await page.evaluate(async () => {
      const itemsResponse = await fetch('/api/items?pageSize=20&sort=newest');
      if (!itemsResponse.ok) {
        return { ok: false, reason: `/api/items returned ${itemsResponse.status}` };
      }
      const body = (await itemsResponse.json()) as {
        items?: { id?: number; price?: number }[];
      };
      const item = (body.items ?? []).find(
        (candidate) => typeof candidate?.id === 'number' && (candidate?.price ?? 0) >= 50,
      );
      if (!item?.id) {
        return { ok: false, reason: 'No published item priced at 50 JPY or above' };
      }
      const cartResponse = await fetch('/api/cart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_id: item.id, quantity: 1 }),
      });
      return cartResponse.ok
        ? { ok: true, reason: '' }
        : { ok: false, reason: `cart seeding failed ${cartResponse.status}` };
    });
    if (!seeded.ok) {
      test.skip(true, seeded.reason);
    }
  });

  for (const viewport of VIEWPORTS) {
    // FREQ-359-AC-01
    test(`${viewport.name}（${viewport.width}px）決済フォームの表示で外部リソースの CSP ブロックが起きない`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: 900 });
      await openCheckoutAndWaitForPaymentForm(page);
      await page.waitForTimeout(OBSERVE_MS);

      expect(await blockedExternalResources(page)).toEqual([]);
      await expect(paymentIframe(page)).toBeVisible();

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  }

  for (const viewport of VIEWPORTS) {
    // FREQ-359-AC-02
    test(`${viewport.name}（${viewport.width}px）Link の保存欄を操作しても外部リソースの CSP ブロックが起きない`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: 900 });
      await openCheckoutAndWaitForPaymentForm(page);
      expect(await blockedExternalResources(page)).toEqual([]);

      const frame = await paymentElementFrame(page);
      await frame.getByText('Link で安全かつスピーディーに決済').first().click();
      await frame.getByLabel('メールアドレス').first().fill('csp-guard@example.com');
      await page.waitForTimeout(OBSERVE_MS);

      expect(await blockedExternalResources(page)).toEqual([]);
    });
  }

  for (const viewport of VIEWPORTS) {
    // FREQ-359-AC-03
    test(`${viewport.name}（${viewport.width}px）PayPay を選択しても外部リソースの CSP ブロックが起きない`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: 900 });
      await openCheckoutAndWaitForPaymentForm(page);
      expect(await blockedExternalResources(page)).toEqual([]);

      const frame = await paymentElementFrame(page);
      // 選べたことまで確かめてから観測する（選べないまま観測すると、何も検証せずに通る）
      await selectPaymentMethod(page, frame, 'PayPay');
      await page.waitForTimeout(OBSERVE_MS);

      expect(await blockedExternalResources(page)).toEqual([]);
    });
  }
});
