/**
 * FR-ACCOUNT-048 返品の申し込みの「確かめる」段に返金の見込みを出す
 * 対応 FREQ: FREQ-642（AC-21・AC-30）。設計: docs/superpowers/specs/2026-11-08-exchange-unit-binding-design.md 6-1
 *
 * お客様の画面（本番ビルド）は本物のログインで動かし、見込みの窓口（POST /api/orders/{id}/return-request/estimate）も本物を通す。
 * 注文は「注文の時の写し」のある注文を手元の DB に作る（unit-binding-test-utils）。受け取りは店の側の入口（Stripe だけ偽物）で行い、
 * 画面に出た見込みと受け取りで返した額を突き合わせる。
 */
import { createActor } from './order-email-test-utils';
import { amount } from '../tests/unit/lib/discounts/fixtures';
import {
  appJson, expect, noOverflow, openRequest, test, viewports, addSizeVariant, type RR,
} from './return-request-test-utils';
import {
  approveRequested, receiveViaService, refundsOf, seedSnapshotOrder, type UbOrder,
} from './unit-binding-test-utils';

/** 注文の時の商品名と色・サイズは全部の行で同じ（材料の決まり）なので、選べる数で行を選び分ける（ジャケットは2着、パンツは1着） */
const PRODUCT_NAME = '照合テスト（BLACK / M）';
const JACKET = 2;
const PANTS = 1;
const SINGLE = 1;

async function pickLine(page: import('@playwright/test').Page, quantity: number, reason: string) {
  const groups = page.getByRole('group', { name: PRODUCT_NAME, exact: true });
  await expect(groups.first()).toBeVisible();
  const total = await groups.count();
  let row = groups.first();
  // 申し込む欄は選ぶまで見分けがつかないので、チェックして選べる数を見て、違えば外す
  for (let index = 0; index < total; index += 1) {
    const candidate = groups.nth(index);
    const checkbox = candidate.getByRole('checkbox', { name: 'この商品を申し込む', exact: true });
    await checkbox.check();
    const options = (await candidate.getByRole('combobox', { name: '数', exact: true }).locator('option').count()) || 1;
    if (total === 1 || options === quantity) { row = candidate; break; }
    await checkbox.uncheck();
  }
  await row.getByRole('combobox', { name: '理由', exact: true }).selectOption(reason);
  if (reason === 'other' || reason === 'defective') {
    await row.getByRole('textbox', { name: '詳しい内容（必須・300字まで）', exact: true }).fill('試験の詳しい内容');
  }
  return row;
}

/** ジャケット 20,000円を2着とパンツ 10,000円。組で 4,500円引き（払った額は 17,000円・20,000円・8,500円） */
async function setOrder(rr: RR, actorId: string): Promise<UbOrder> {
  return seedSnapshotOrder(rr.db, {
    actorId, buyerUserId: rr.member.userId, email: rr.member.email,
    lines: [{ price: 20_000, quantity: JACKET }, { price: 10_000, quantity: PANTS }],
    definitions: ([jacket, pants]) => [amount('set', 4500, { kind: 'set', targetMode: 'include', itemIds: [jacket, pants] })],
  });
}

test.use({ trace: 'off', locale: 'ja-JP' });
for (const viewport of viewports) {
  test.describe('FR-ACCOUNT-048 ' + viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-642-AC-21: 確かめる段に返金の見込み 5,500円が出て、受け取りで返った額と同じ', async ({ page, rr }) => {
      test.setTimeout(240_000);
      const actorId = await createActor(rr.db);
      const order = await setOrder(rr, actorId);
      await openRequest(page, rr, order.orderId);
      await pickLine(page, PANTS, 'other'); // パンツ（お客様のご都合の理由で返金）
      await page.getByRole('button', { name: '内容を確かめる', exact: true }).click();
      const summary = page.getByRole('region', { name: 'お申し込みの内容', exact: true });
      await expect(summary).toContainText('ご希望: 返金');
      const estimate = page.getByText(/^返金の見込み: /);
      await expect(estimate).toHaveText('返金の見込み: 5,500円');
      await noOverflow(page);

      await page.getByRole('button', { name: '申し込む', exact: true }).click();
      await expect(page.getByTestId('return-request-accepted')).toBeVisible();
      const requested = (await rr.db.query("select id from public.order_returns where order_id=$1 and status='requested'", [order.orderId])).rows;
      expect(requested).toHaveLength(1);
      const returnId = requested[0].id as string;
      const lineIds = await approveRequested(rr.db, returnId, actorId);
      const received = await receiveViaService(returnId, actorId, {
        units: lineIds.map((returnLineId) => ({ returnLineId, disposition: 'not_restocked' as const, quantity: 1, refundChoice: 'now' as const })),
        refundChoice: 'now',
      });
      expect(received.refund?.amount).toBe(5_500);
      expect((await refundsOf(rr.db, order.orderId)).map((r) => r.amount)).toEqual([5_500]);
    });

    test('FREQ-642-AC-21: 交換だけの申し込みは「お金のやり取りはありません」と出て、返金の見込みは出ない', async ({ page, rr }) => {
      test.setTimeout(240_000);
      const actorId = await createActor(rr.db);
      const order = await seedSnapshotOrder(rr.db, {
        actorId, buyerUserId: rr.member.userId, email: rr.member.email, lines: [{ price: 20_000, quantity: 2 }],
        definitions: ([jacket]) => [amount('repeat', 3000, { kind: 'repeat', targetMode: 'include', itemIds: [jacket], repeatInOrder: true })],
      });
      const variant = await addSizeVariant(rr.db, order.catalogs[0].itemId, 'BLACK', 'L', 3);
      await openRequest(page, rr, order.orderId);
      const row = await pickLine(page, SINGLE, 'size_too_small');
      await expect(row.getByRole('combobox', { name: 'ご希望', exact: true })).toHaveValue('exchange');
      await row.getByRole('combobox', { name: '交換する色・サイズ', exact: true }).selectOption(String(variant));
      await page.getByRole('button', { name: '内容を確かめる', exact: true }).click();
      await expect(page.getByRole('region', { name: 'お申し込みの内容', exact: true })).toContainText('ご希望: 交換（BLACK / L）');
      await expect(page.getByText('お金のやり取りはありません', { exact: true })).toBeVisible();
      await expect(page.getByText(/^返金の見込み: /)).toHaveCount(0);
      await noOverflow(page);
    });

    test('FREQ-642-AC-30: 破損・不良と注文と違う品が届いた、を選ぶとご希望は交換だけで、返金は出ない', async ({ page, rr }) => {
      test.setTimeout(240_000);
      const actorId = await createActor(rr.db);
      const order = await seedSnapshotOrder(rr.db, {
        actorId, buyerUserId: rr.member.userId, email: rr.member.email, lines: [{ price: 20_000, quantity: 1 }], definitions: () => [],
      });
      await addSizeVariant(rr.db, order.catalogs[0].itemId, 'BLACK', 'L', 3);
      await openRequest(page, rr, order.orderId);
      for (const reason of ['defective', 'wrong_item']) {
        const row = await pickLine(page, SINGLE, reason);
        const wish = row.getByRole('combobox', { name: 'ご希望', exact: true });
        await expect(wish).toBeDisabled();
        await expect(wish).toHaveValue('exchange');
        const options = await wish.locator('option').evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value));
        expect(options).toEqual(['exchange']);
        expect(options).not.toContain('refund');
        await noOverflow(page);
      }
      // 店長が設定の画面で変えられる値のまま。申し込みの窓口の材料も、この2つの理由は交換だけを返す
      const materials = await appJson<{ data: { reasons: Array<{ reason: string; resolutions: string }> } }>(page, '/api/orders/' + order.orderId + '/return-request');
      const settings = Object.fromEntries(materials.body.data.reasons.map((r) => [r.reason, r.resolutions]));
      expect([settings.defective, settings.wrong_item]).toEqual(['exchange_only', 'exchange_only']);
    });
  });
}
