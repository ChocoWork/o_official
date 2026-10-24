import { test, expect, Page } from '@playwright/test';
import { mockAdminBackgroundApis } from './admin-test-utils';

// FREQ-399: 商品編集画面で、色 × サイズごとの在庫を台帳経由で入れられるようにする。
// 在庫の正はバリアント。画面から直接 item_variants を書き換えず、必ず台帳への追記を送る。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

const ITEM_ID = '7';

type VariantState = {
  id: number;
  colorName: string;
  colorHex: string;
  sizeLabel: string;
  stockQuantity: number;
  isActive: boolean;
  committedQuantity: number;
  onHandQuantity: number;
  backorderQuantity: number;
};

type MovementState = {
  id: number;
  variantId: number;
  delta: number;
  reason: string;
  note: string | null;
  createdAt: string;
  actorEmail: string | null;
  orderId: string | null;
  orderNumber: string | null;
  balanceAfter: number;
};

// G-1（Task 5）: POST 本文は UUID の requestKey が必須。割り当て済みの品を外す棚卸は、確認後に expectedReleaseQuantity と理由（note）を付けて送り直す
type MovementPost = {
  variantId: number;
  delta: number;
  reason: string;
  note?: string;
  requestKey?: string;
  expectedReleaseQuantity?: number;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RELEASE_CONFIRMATION_ERROR = '割り当て済みの品を外す必要があります。数量を確認してください。';

async function mockAdminApis(
  page: Page,
  options: {
    movementStatus?: number;
    movementError?: string;
    /** 指定すると、expectedReleaseQuantity の無い減らす棚卸は、何も変えずに 409（確認が要る）で断る。確認後の送信（外す数が一致）だけ通る */
    releaseQuantity?: number;
    /** 確認後の送信を、最初のこの回数だけ 500 で失敗させる（通信の失敗の再送の確かめ） */
    failConfirmedSends?: number;
  } = {},
): Promise<{ posts: MovementPost[] }> {
  const posts: MovementPost[] = [];
  let remainingConfirmedFailures = options.failConfirmedSends ?? 0;
  await mockAdminBackgroundApis(page);

  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authenticated: true,
        user: { id: 'a', email: 'a@e.com', role: 'admin', mfaVerified: true },
      }),
    }),
  );

  await page.route('**/api/admin/item-color-presets**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) }),
  );

  await page.route(`**/api/admin/items/${ITEM_ID}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          id: Number(ITEM_ID),
          name: 'リネンシャツ',
          description: '説明',
          price: 28000,
          category: 'TOPS',
          colors: [{ name: 'BLACK', hex: '#000000' }],
          sizes: ['M', 'L'],
          material: '',
          origin: '',
          care: '',
          product_note: '',
          status: 'published',
          image_url: null,
          image_urls: [],
        },
      }),
    }),
  );

  // サーバ側の状態を画面から動かせるよう、モック内に持つ。
  const variants: VariantState[] = [
    { id: 11, colorName: 'BLACK', colorHex: '#000000', sizeLabel: 'M', stockQuantity: 4, isActive: true, committedQuantity: 3, onHandQuantity: 7, backorderQuantity: 2 },
    { id: 12, colorName: 'BLACK', colorHex: '#000000', sizeLabel: 'L', stockQuantity: 0, isActive: true, committedQuantity: 0, onHandQuantity: 0, backorderQuantity: 0 },
  ];
  const movements: MovementState[] = [
    { id: 5, variantId: 11, delta: 4, reason: 'restock', note: '初回入荷', createdAt: '2026-09-20T01:00:00Z', actorEmail: 'a@e.com', orderId: null, orderNumber: null, balanceAfter: 4 },
  ];
  let nextMovementId = 6;

  await page.route(`**/api/admin/items/${ITEM_ID}/variants`, async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as MovementPost;
      posts.push(body);
      const reply = (status: number, json: unknown) =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });

      // 実窓口（zod）と同じく、UUID の requestKey が無い送信は 400
      if (typeof body.requestKey !== 'string' || !UUID_PATTERN.test(body.requestKey)) {
        await reply(400, { error: 'Invalid request' });
        return;
      }
      if (options.movementStatus && options.movementStatus !== 201) {
        await reply(options.movementStatus, { error: options.movementError ?? 'error' });
        return;
      }

      const target = variants.find((variant) => variant.id === body.variantId);
      const releasing = options.releaseQuantity !== undefined && body.delta < 0;
      if (releasing) {
        const releaseQuantity = options.releaseQuantity ?? 0;
        // 確認前（外す数が無い）と、確認した数が今の数と違う送信は、何も変えずに 409 で確認を求める
        if (body.expectedReleaseQuantity !== releaseQuantity) {
          await reply(409, {
            code: 'GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED',
            error: RELEASE_CONFIRMATION_ERROR,
            releasedQuantity: releaseQuantity,
          });
          return;
        }
        if (!body.note?.trim()) {
          await reply(400, { code: 'GROUP_G_STOCK_RELEASE_REASON_REQUIRED', error: '割り当てを外す理由を入力してください。' });
          return;
        }
        if (remainingConfirmedFailures > 0) {
          remainingConfirmedFailures -= 1;
          await reply(500, { error: '在庫の記録に失敗しました' });
          return;
        }
        // 棚卸の減らし方: まず空き（F）、足りない分だけ割り当て済み（A）を外して受注生産中に戻す
        if (target) {
          target.stockQuantity += releaseQuantity + body.delta;
          target.committedQuantity -= releaseQuantity;
          target.onHandQuantity += body.delta;
          target.backorderQuantity += releaseQuantity;
        }
      } else if (target) {
        target.stockQuantity += body.delta;
        target.onHandQuantity += body.delta;
      }
      movements.unshift({
        id: nextMovementId++,
        variantId: body.variantId,
        delta: body.delta,
        reason: body.reason,
        note: body.note ?? null,
        createdAt: '2026-09-21T02:00:00Z',
        actorEmail: 'a@e.com',
        orderId: null,
        orderNumber: null,
        balanceAfter: target?.stockQuantity ?? 0,
      });
      await reply(201, { success: true });
      return;
    }

    // G-1: GET は { variants, movements, allocationEvents }（割当の履歴は、この spec では空）
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ variants, movements, allocationEvents: [] }),
    });
  });
  return { posts };
}

/** 指定した色 × サイズの行。 */
function variantRow(page: Page, label: string) {
  return page.getByTestId(`variant-row-${label}`);
}

for (const viewport of viewports) {
  test.describe(`${viewport.name}（${viewport.width}px）`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-399-AC-01: 色・サイズ・在庫数・受注生産の受注数が出る', async ({ page }) => {
      await mockAdminApis(page);
      await page.goto(`/admin/item/edit/${ITEM_ID}`);

      const row = variantRow(page, '11');
      await expect(row).toBeVisible();
      await expect(row.getByTestId('variant-color')).toHaveText('BLACK');
      await expect(row.getByTestId('variant-size')).toHaveText('M');
      await expect(row.getByTestId('variant-stock')).toHaveText('4');
      await expect(row.getByTestId('variant-backorder')).toHaveText('2');

      await expect(variantRow(page, '12').getByTestId('variant-stock')).toHaveText('0');
    });

    test('FREQ-399-AC-02: 入荷を記録すると在庫数が増える', async ({ page }) => {
      const { posts } = await mockAdminApis(page);
      await page.goto(`/admin/item/edit/${ITEM_ID}`);

      const row = variantRow(page, '12');
      await row.getByTestId('variant-delta').fill('3');
      await row.getByTestId('variant-submit').click();

      await expect(row.getByTestId('variant-stock')).toHaveText('3');
      // G-1: 送信には UUID の要求番号が付き、外す数（expectedReleaseQuantity）は付かない
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({ variantId: 12, delta: 3, reason: 'restock' });
      expect(posts[0].requestKey).toMatch(UUID_PATTERN);
      expect(posts[0].expectedReleaseQuantity).toBeUndefined();
    });

    test('FREQ-399-AC-03: 在庫を超える引き落としは断られ、在庫が変わらない', async ({ page }) => {
      await mockAdminApis(page, {
        movementStatus: 409,
        movementError: '在庫が足りないため、この数量は引けません。',
      });
      await page.goto(`/admin/item/edit/${ITEM_ID}`);

      const row = variantRow(page, '11');
      await row.getByTestId('variant-reason').selectOption('adjustment');
      await row.getByTestId('variant-delta').fill('-99');
      await row.getByTestId('variant-submit').click();

      await expect(page.getByTestId('variant-stock-error')).toContainText('在庫が足りない');
      await expect(row.getByTestId('variant-stock')).toHaveText('4');
    });

    test('FREQ-399-AC-04: 履歴が理由と増減つきで新しい順に出る', async ({ page }) => {
      await mockAdminApis(page);
      await page.goto(`/admin/item/edit/${ITEM_ID}`);

      await expect(page.getByTestId('stock-movement-row').first()).toContainText('入荷');

      const row = variantRow(page, '11');
      await row.getByTestId('variant-reason').selectOption('adjustment');
      await row.getByTestId('variant-delta').fill('-1');
      await row.getByTestId('variant-submit').click();

      const first = page.getByTestId('stock-movement-row').first();
      await expect(first).toContainText('棚卸調整');
      await expect(first).toContainText('-1');
    });

    test('FREQ-399-AC-03: 割り当て済みの品を外す棚卸は、確認前は何も変わらず、確認後は新しい要求番号と外す数と理由で送り直す', async ({ page }) => {
      // F=4・A=3 の色・サイズから 6 点減らすと、空き 4 点に加えて割り当て済み 2 点を外す（外す数 2）
      const { posts } = await mockAdminApis(page, { releaseQuantity: 2 });
      await page.goto(`/admin/item/edit/${ITEM_ID}`);

      const row = variantRow(page, '11');
      await row.getByTestId('variant-reason').selectOption('adjustment');
      await row.getByTestId('variant-delta').fill('-6');
      await row.getByTestId('variant-submit').click();

      // 確認前: 窓口は 409 で断り、数は何も変わらない。確認の画面に外す数が出る
      const dialog = page.getByRole('dialog', { name: '在庫を減らす' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText('割り当て済みの品を2点外し、受注生産中に戻します。')).toBeVisible();
      await expect(row.getByTestId('variant-stock')).toHaveText('4');
      await expect(row.getByTestId('variant-committed')).toHaveText('3');
      await expect(row.getByTestId('variant-backorder')).toHaveText('2');
      expect(posts).toHaveLength(1);
      expect(posts[0].requestKey).toMatch(UUID_PATTERN);
      expect(posts[0].expectedReleaseQuantity).toBeUndefined();

      // 理由が無ければ送らない
      await dialog.getByRole('button', { name: '在庫を減らす', exact: true }).click();
      await expect(dialog.getByRole('alert')).toHaveText('割り当てを外す理由を入力してください。');
      expect(posts).toHaveLength(1);

      // 確認後: 外す数と理由を付け、新しい要求番号で送る。通ると割り当て済みが減り、受注生産に戻る
      await dialog.getByLabel('割り当てを外す理由').fill('棚卸で実数が合わない');
      await dialog.getByRole('button', { name: '在庫を減らす', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      expect(posts).toHaveLength(2);
      expect(posts[1]).toMatchObject({ variantId: 11, delta: -6, reason: 'adjustment', expectedReleaseQuantity: 2, note: '棚卸で実数が合わない' });
      expect(posts[1].requestKey).toMatch(UUID_PATTERN);
      expect(posts[1].requestKey).not.toBe(posts[0].requestKey);
      await expect(row.getByTestId('variant-stock')).toHaveText('0');
      await expect(row.getByTestId('variant-committed')).toHaveText('1');
      await expect(row.getByTestId('variant-backorder')).toHaveText('4');
    });

    test('FREQ-399-AC-03: 確認後の送信が失敗しても、再送は同じ要求番号と本文で送り、通れば一度だけ反映する', async ({ page }) => {
      const { posts } = await mockAdminApis(page, { releaseQuantity: 2, failConfirmedSends: 1 });
      await page.goto(`/admin/item/edit/${ITEM_ID}`);

      const row = variantRow(page, '11');
      await row.getByTestId('variant-reason').selectOption('adjustment');
      await row.getByTestId('variant-delta').fill('-6');
      await row.getByTestId('variant-submit').click();
      const dialog = page.getByRole('dialog', { name: '在庫を減らす' });
      await dialog.getByLabel('割り当てを外す理由').fill('棚卸で実数が合わない');
      await dialog.getByRole('button', { name: '在庫を減らす', exact: true }).click();

      // 確定送信が 500 で失敗: 確認の画面は残り、数は変わらない
      await expect(dialog.getByRole('alert')).toHaveText('在庫の記録に失敗しました');
      await expect(row.getByTestId('variant-stock')).toHaveText('4');
      expect(posts).toHaveLength(2);

      // 再送: 同じ要求番号・同じ本文（通信の再送は新しい操作ではない）
      await dialog.getByRole('button', { name: '在庫を減らす', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      expect(posts).toHaveLength(3);
      expect(posts[2]).toEqual(posts[1]);
      expect(posts[1].requestKey).not.toBe(posts[0].requestKey);
      await expect(row.getByTestId('variant-stock')).toHaveText('0');
      await expect(row.getByTestId('variant-committed')).toHaveText('1');
    });

    test('FREQ-399-AC-05: 横スクロールが出ない', async ({ page }) => {
      await mockAdminApis(page);
      await page.goto(`/admin/item/edit/${ITEM_ID}`);
      await expect(variantRow(page, '11')).toBeVisible();

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
