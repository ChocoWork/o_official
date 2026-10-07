import { expect, type Frame, type Page } from '@playwright/test';
import { waitForPositionToSettle } from './checkout-test-utils';

/**
 * 決済の新しい流れ（グループ F）の E2E の共通の部品。
 * 入力画面 →「確認へ進む」→ 最終確認画面（Stripe の決済の入力欄）→「注文する」。
 */

export const CHECKOUT_VIEWPORTS = [
  { name: 'mobile', width: 390, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
] as const;

export type SeedResult = { ok: true; itemId: number; price: number } | { ok: false; reason: string };

/**
 * 公開中で50円以上の商品を1つ、色・サイズなしの行としてカートに入れる（Stripe の最低額は50円）。
 * スキップの理由を返すのは、その商品が無い環境のときだけ。入口の崩れや回数の制限（429）などの通信の失敗は
 * 投げて、テストを失敗にする（スキップにすると赤にならず、push の前の E2E でも回帰に気づけない）。
 */
export async function seedCart(page: Page): Promise<SeedResult> {
  await page.goto('/');
  return page.evaluate(async (): Promise<SeedResult> => {
    const itemsResponse = await fetch('/api/items?pageSize=20&sort=newest');
    if (!itemsResponse.ok) {
      throw new Error(`/api/items returned ${itemsResponse.status}`);
    }
    const body = (await itemsResponse.json()) as { items?: { id?: number; price?: number }[] };
    const item = (body.items ?? []).find((i) => typeof i?.id === 'number' && (i?.price ?? 0) >= 50);
    if (!item?.id || typeof item.price !== 'number') {
      return { ok: false, reason: 'No published item priced at 50 JPY or above' };
    }
    const cartResponse = await fetch('/api/cart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id: item.id, quantity: 1 }),
    });
    if (!cartResponse.ok) {
      throw new Error(`/api/cart returned ${cartResponse.status}`);
    }
    return { ok: true, itemId: item.id, price: item.price };
  });
}

export async function stubPostalCode(page: Page): Promise<void> {
  await page.route('**/api/checkout/postal-code**', (route) =>
    route.fulfill({ json: { address: { prefecture: '東京都', city: '渋谷区', address: '神宮前1-2-3' } } }),
  );
}

export async function fillShippingForm(page: Page, email: string): Promise<void> {
  await page.getByLabel('氏名').fill('山田花子');
  await page.getByLabel('フリガナ').fill('ヤマダハナコ');
  await page.getByLabel('メールアドレス').fill(email);
  await page.getByLabel('電話番号').fill('0312345678');
  await page.getByLabel('郵便番号').fill('1500001');
  await expect(page.getByRole('combobox', { name: '都道府県' })).toContainText('東京都');
  await expect(page.getByLabel('市区町村')).toHaveValue('渋谷区');
  await expect(page.getByLabel('番地')).toHaveValue('神宮前1-2-3');
}

/** 「確認へ進む」を押し、最終確認画面の表題が出るまで待つ */
export async function proceedToFinal(page: Page): Promise<void> {
  const button = page.getByRole('button', { name: '確認へ進む' });
  await expect(button).toBeEnabled({ timeout: 30_000 });
  await button.click();
  await expect(page.getByRole('heading', { name: '注文内容の最終確認' })).toBeVisible({ timeout: 60_000 });
}

function isPaymentElementFrame(frame: Frame): boolean {
  return /elements-inner-payment/.test(frame.url());
}

export function hasPaymentElement(page: Page): boolean {
  return page.frames().some(isPaymentElementFrame);
}

/** 最終確認画面の Stripe の決済の入力欄（FR-CHECKOUT-025 と同じ拾い方） */
export async function paymentElementFrame(page: Page): Promise<Frame> {
  await expect.poll(() => hasPaymentElement(page), { timeout: 30_000 }).toBe(true);
  return page.frames().find(isPaymentElementFrame)!;
}

export async function fillTestCard(frame: Frame): Promise<void> {
  await frame.getByRole('textbox', { name: 'カード番号' }).fill('4242424242424242');
  await frame.getByRole('textbox', { name: '有効期限' }).fill('12 / 34');
  await frame.getByRole('textbox', { name: 'セキュリティコード' }).fill('123');
}

/**
 * 「注文する」を押す。決済の入力欄の展開と Link の自動入力でボタンがずれるので、落ち着いてから押す。
 * Link の保存欄（任意）に電話番号が入ったまま押すと Link のアカウントが作られるので、空を確かめる。
 */
export async function clickPlaceOrder(page: Page, frame: Frame): Promise<void> {
  const button = page.getByRole('button', { name: '注文する' });
  await expect(button).toBeEnabled({ timeout: 30_000 });
  await waitForPositionToSettle(button);
  const linkPhone = frame.getByRole('textbox', { name: '携帯電話番号' });
  if ((await linkPhone.count()) > 0) {
    await expect(linkPhone).toHaveValue('');
  }
  await button.click();
}

/** テスト用カード（4242…）で「注文する」を押す */
export async function placeOrderWithTestCard(page: Page): Promise<void> {
  const frame = await paymentElementFrame(page);
  await fillTestCard(frame);
  await clickPlaceOrder(page, frame);
}

export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  expect(overflow).toBe(false);
}
