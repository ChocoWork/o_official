/**
 * FR-ADMIN-164 返品の受け取りで品ごとに返金の仕方を選ぶ
 * 対応 FREQ: FREQ-641（AC-01〜AC-06）。設計: docs/superpowers/specs/2026-11-06-return-receive-per-item-design.md
 *
 * 受け取りの画面は本番ビルドの画面を動かし、受け取り・額を決めて返金の窓口だけを差し替えて、窓口と同じ DB の関数を手元の DB に直に呼ぶ
 * （return-request-test-utils の adminScene。FR-ADMIN-096 と同じ作り）。Stripe・外へのメールには頼まず、返金の結果は手元の DB に書き、
 * お客様へのメールは手元の worker と Mailpit で確かめる。品ごとの選び・見出し・上限・ボタンの言葉は Task 3 の画面の約束（task-3-brief）。
 */
import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { createCatalogFixture, insertOrderWithLines } from '../tests/integration/db/helpers/order-fixtures';
import { hDiscount, seedHDiscount } from '../tests/integration/db/helpers/group-h-fixtures';
import { listOrderReturns } from '@/lib/orders/returns/return-store';
import { lockE2eInventory, seedE2eRestock, withGroupG1Material } from './group-g1-test-utils';
import { createActor, createFulfillment, recordRefundResult, uniqueEmail } from './order-email-test-utils';
import { fulfillJson, openOrderDetail } from './order-fulfillment-test-utils';
import {
  RETURN_MAIL,
  RETURN_TEXT,
  UNIT_STATES,
  confirmButton,
  ensureReturnSettings,
  formatYen,
  openDetailReturnsDialog,
  openReceiveDialog,
  openReturnRefundDialog,
  receiptRows,
  refundData,
  refundReturnInDb,
  returnEmailRows,
  returnLabelOf,
  returnRefundRows,
  setUnitState,
  unitRows,
  waitForMails,
  type ReturnFixture,
} from './return-test-utils';
import { adminScene, expect, noOverflow, test, viewports, type RR } from './return-request-test-utils';

/** Task 3 の受け取りの画面の言葉（task-3-brief・設計 3-1〜3-3）。実装の定数を import せず、試験が自分で持つ */
const PER_ITEM = {
  now: '今すぐ返金',
  consult: '額を相談',
  nowHeading: (count: number) => `今すぐ返金（${count}点）`,
  consultHeading: (count: number) => `額を相談（${count}点）`,
  consultNote: '返金待ちになります。額はあとで「額を決めて返金する」で決めます。',
  amountLabel: '返金額',
  cap: (yen: string) => `上限 ${yen}`,
  capError: (yen: string) =>
    `この受け取りの商品の額と送料（${yen}）を超えて入れられません。ほかの受け取りの分は、返品の画面の「額を決めて返金する」で返してください。`,
  mixedButton: (nowCount: number, yen: string, consultCount: number) => `受け取る（${nowCount}点を ${yen} 返金・${consultCount}点は相談）`,
  mixedButtonAny: /^受け取る（\d+点を ￥[\d,]+ 返金・\d+点は相談）$/,
  /** 返金のメールで相談の品に添える一文（設計 6） */
  consultMail: 'ご返金の額は、確かめてから改めてご連絡いたします。',
} as const;

type Seed = {
  /** H の1着ごとの額（安い順）。省くと割引なしの旧注文（単価 price） */
  amounts?: number[];
  price?: number;
  quantity?: number;
  /** 返品の行ごとの数（同じ注文商品を返品の行に分ける時）。省くと1行 */
  lines?: number[];
  percent?: number;
  shipping?: number;
  source?: 'customer_request' | 'shop';
};
type Seeded = ReturnFixture & { returnId: string; lineIds: string[]; label: string };

/**
 * 発送済みの注文と、承認済みの返品（受け取り待ち）を手元の DB に作る。DB 結合の試験（return-receive-per-item.integration）と同じ形で、
 * 返品の行の番号は昇順に並べ、承認が安い着から行へ結ぶ。注文・在庫・発送は1つの G-1 の取引。商品は非公開（他の購入の試験に混ざらない）
 */
async function seedReturn(rr: RR, label: string, o: Seed): Promise<Seeded> {
  const db = rr.db;
  await ensureReturnSettings(db);
  return withGroupG1Material(db, async () => {
    const quantity = o.amounts?.length ?? o.quantity ?? 2;
    const price = o.price ?? (o.amounts ? Math.max(...o.amounts) : 999);
    const discount = o.amounts ? price * quantity - o.amounts.reduce((sum, n) => sum + n, 0) : 0;
    const shipping = o.shipping ?? 0;
    const actorId = await createActor(db);
    const email = uniqueEmail(`fr164-${label}`);
    const catalog = await createCatalogFixture(db, { stock: 0, itemStatus: 'private' });
    await seedE2eRestock(db, { itemId: catalog.itemId, variantId: catalog.variantId, quantity });
    await lockE2eInventory(db, { variantIds: [catalog.variantId] });
    const order = await insertOrderWithLines(db, {
      status: 'paid', shippingEmail: email, shippingAmount: shipping, discountAmount: discount,
      paidAmount: price * quantity - discount + shipping, paymentIntentId: `pi_e2e164_${randomUUID().replaceAll('-', '')}`,
      lines: [{ itemId: catalog.itemId, variantId: catalog.variantId, quantity, itemPrice: price, fulfillmentType: 'stock' }],
    });
    const orderItemId = order.orderItemIds[0];
    if (o.amounts) {
      if (discount > 0) {
        // 止めた割引（どの注文にも新しく当たらない）。割り振りの最低額は割引より大きくする（DB 結合の試験と同じ）
        const discountId = await seedHDiscount(db, hDiscount({ value: { type: 'amount', value: discount },
          minimum: { type: 'amount', value: price * quantity }, stopped: true }));
        await db.query('insert into public.order_line_discount_allocations(order_id,order_item_id,discount_id,amount) values($1,$2,$3,$4)',
          [order.orderId, orderItemId, discountId, discount]);
      }
      for (const [index, amount] of o.amounts.entries()) {
        await db.query('insert into public.order_line_unit_amounts(order_id,order_item_id,unit_index,paid_amount) values($1,$2,$3,$4)',
          [order.orderId, orderItemId, index, amount]);
      }
    }
    const shipment = await createFulfillment(db, order.orderId, actorId, {
      trackingNumber: `E2E-164-${randomUUID().slice(0, 8)}`, notify: false, lines: [{ orderItemId, quantity }],
    });
    const returnId = (await db.query(`insert into public.order_returns
      (order_id,number,source,status,request_key,request_fingerprint,requested_at,requested_by,return_method,return_shipping_payer,notify_customer)
      values($1,1,$2,'requested',$3,'fr-admin-164',now(),$4,'customer_ships','customer',false) returning id`,
    [order.orderId, o.source ?? 'customer_request', randomUUID(), actorId])).rows[0].id as string;
    const groups = o.lines ?? [quantity];
    const lineIds = groups.map(() => randomUUID()).sort();
    for (const [index, lineQuantity] of groups.entries()) {
      await db.query(`insert into public.order_return_lines
        (id,return_id,fulfillment_id,order_item_id,quantity,reason,requested_resolution,requested_exchange_variant_id,resolution,exchange_variant_id,exchange_method)
        values($1,$2,$3,$4,$5,'unknown','refund',null,'refund',null,null)`,
      [lineIds[index], returnId, shipment.fulfillmentId, orderItemId, lineQuantity]);
    }
    const approval = lineIds.map((id) => ({ return_line_id: id, resolution: 'refund', exchange_variant_id: null, exchange_method: null }));
    await db.query("select * from public.admin_approve_return($1,$2,$3::jsonb,'customer_ships','customer',null,null,0,$4,0,0,null,false)",
      [returnId, actorId, JSON.stringify(approval), o.percent ?? 0]);
    return {
      orderId: order.orderId, email, actorId, itemId: catalog.itemId, variantId: catalog.variantId, orderItemIds: [orderItemId],
      fulfillmentId: shipment.fulfillmentId, fulfillmentIds: [shipment.fulfillmentId], returnId, lineIds, label: returnLabelOf(order.orderId, 1),
    };
  });
}

/** 注文の詳細 → 返品の画面 → 受け取りの画面まで開く。返せる額・送料は手元の DB の値を返品の窓口の答えに入れる */
async function openReceive(page: Page, rr: RR, fx: Seeded, role: 'admin' | 'supporter', settleRefund = true) {
  const scene = await adminScene(page, rr, fx, role, { settleRefund });
  await syncRefundable(rr, fx, scene.state);
  await openDetailReturnsDialog(page, fx.orderId, '受け取る');
  const dialog = await openReceiveDialog(page, fx.orderId, fx.label);
  return { scene, dialog };
}

async function syncRefundable(rr: RR, fx: Seeded, state: { refundableAmount: number; refundableShipping: number }) {
  const row = (await rr.db.query('select refundable_amount, refundable_shipping from private.order_refund_amounts($1)', [fx.orderId])).rows[0];
  state.refundableAmount = Number(row.refundable_amount);
  state.refundableShipping = Number(row.refundable_shipping);
}

/** 品ごとの選びのラジオ（受け取りの画面の全部の品）。前の受け取り全体の選び（計算どおり…・額を相談してから返金する）には当たらない */
const choiceRadios = (dialog: Locator) => dialog.getByRole('radio', { name: /^(今すぐ返金|額を相談)$/ });

/** 状態を選べる i 番目の品の行の、返金の選び */
function unitChoice(dialog: Locator, index: number, name: string): Locator {
  return unitRows(dialog).filter({ has: dialog.page().getByRole('combobox', { name: '品の状態', exact: true }) }).nth(index)
    .getByRole('radio', { name, exact: true });
}

/** i 番目の品を、キーボード（矢印）で「今すぐ返金」から「額を相談」へ変え、選びとフォーカスが移ることを確かめる */
async function chooseConsultByKeyboard(dialog: Locator, index: number): Promise<void> {
  const now = unitChoice(dialog, index, PER_ITEM.now);
  const consult = unitChoice(dialog, index, PER_ITEM.consult);
  await expect(now).toBeChecked();
  await now.focus();
  await expect(now).toBeFocused();
  await dialog.page().keyboard.press('ArrowDown');
  await expect(consult).toBeChecked();
  await expect(consult).toBeFocused();
}

/** 確定のボタンにフォーカスを移し、Enter で押す */
async function submitByKeyboard(button: Locator): Promise<void> {
  await expect(button).toBeEnabled();
  await button.focus();
  await expect(button).toBeFocused();
  await button.press('Enter');
}

/** 確定する前の画面で、ページ全体と開いている dialog 自体の横はみ出しを確かめる */
async function expectNoOverflow(page: Page, dialog: Locator): Promise<void> {
  await expect(dialog).toBeVisible();
  await noOverflow(page);
  const { scrollWidth, clientWidth } = await dialog.evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
}

const unitChoices = (body: Record<string, unknown>) =>
  ((body.units ?? []) as Array<{ refundChoice?: string }>).map((unit) => unit.refundChoice ?? null);
const amountInputs = (dialog: Locator) => dialog.getByRole('spinbutton', { name: /^返金額/ });
const shippingInputs = (dialog: Locator) => dialog.getByRole('spinbutton', { name: /^送料/ });

async function waitingQuantity(db: PgClient, returnId: string): Promise<number> {
  return Number((await db.query('select coalesce(sum(refund_waiting),0)::int n from private.order_return_line_progress($1)', [returnId])).rows[0].n);
}
async function waitingAmount(db: PgClient, returnId: string): Promise<number> {
  const detail = (await db.query('select private.return_detail_json($1) j', [returnId])).rows[0].j as { lines: Array<{ refund_waiting_amount: number }> };
  return detail.lines.reduce((sum, line) => sum + Number(line.refund_waiting_amount), 0);
}
async function refundWaivedQuantity(db: PgClient, returnId: string): Promise<number> {
  return Number((await db.query(`select coalesce(sum(l.quantity),0)::int n from public.order_return_receipt_lines l
    join public.order_return_receipts r on r.id=l.receipt_id where r.return_id=$1 and l.disposition='refund_waived'`, [returnId])).rows[0].n);
}
/** 注文の履歴の「返品の受け取り」の元になる行（受け取りの記録の kind=receive）。履歴は受け取りの記録1つにつき1行（Task 4） */
async function historyReceiveRows(db: PgClient, orderId: string) {
  return (await db.query(`select r.id from public.order_return_receipts r join public.order_returns o on o.id=r.return_id
    where o.order_id=$1 and r.kind='receive'`, [orderId])).rows;
}
async function shopNoticeCount(db: PgClient, returnId: string): Promise<number> {
  return Number((await db.query("select count(*)::int n from private.order_email_outbox where return_id=$1 and kind='return_refund_pending_shop'", [returnId])).rows[0].n);
}
/** お客様へのメールの予定（店への知らせを除く）。1回の受け取りでお客様へは1通 */
async function customerOutboxRows(db: PgClient, orderId: string) {
  return (await returnEmailRows(db, orderId)).filter((row) => row.kind !== 'return_refund_pending_shop');
}

test.use({ trace: 'off' });
for (const viewport of viewports) {
  test.describe('FR-ADMIN-164 ' + viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-641-AC-01: 同じ受け取りの2点を1点返金と1点相談にする', async ({ page, request, rr }) => {
      // FREQ-641-AC-01。999円2点・返品の手数料10%・送料0。今すぐの1点は 999 − 99 = 900円
      test.setTimeout(180_000);
      const fx = await seedReturn(rr, `ac01-${viewport.name}`, { price: 999, quantity: 2, percent: 10 });
      const { scene, dialog } = await openReceive(page, rr, fx, 'admin');
      await setUnitState(dialog, 0, UNIT_STATES.keep);
      await setUnitState(dialog, 1, UNIT_STATES.keep);
      await expect(choiceRadios(dialog)).toHaveCount(4);
      await chooseConsultByKeyboard(dialog, 1);
      await expect(dialog.getByText(PER_ITEM.nowHeading(1), { exact: true })).toBeVisible();
      await expect(dialog.getByText(PER_ITEM.consultHeading(1), { exact: true })).toBeVisible();
      await expect(dialog.getByText(PER_ITEM.consultNote, { exact: true })).toBeVisible();
      await expectNoOverflow(page, dialog);
      await submitByKeyboard(confirmButton(dialog, PER_ITEM.mixedButton(1, formatYen(900), 1)));
      await expect.poll(() => scene.state.posts.receive.length).toBe(1);
      const post = scene.state.posts.receive[0].body;
      expect(post.refundChoice).toBe('mixed');
      expect(unitChoices(post).sort()).toEqual(['consult', 'now']);

      const receipts = await receiptRows(rr.db, fx.returnId);
      expect(receipts).toHaveLength(1);
      expect(receipts[0].refund_choice).toBe('mixed');
      const refundRows = await returnRefundRows(rr.db, fx.orderId);
      expect(refundRows).toHaveLength(1);
      expect(refundRows[0].amount).toBe(900); // 999円2点、p10%、送料0
      expect(await waitingQuantity(rr.db, fx.returnId)).toBe(1);
      expect(await historyReceiveRows(rr.db, fx.orderId)).toHaveLength(1);
      expect(await customerOutboxRows(rr.db, fx.orderId)).toHaveLength(1);

      // 手元の worker が送る返金のお知らせは1通で、相談の品に一文が添えられる
      const mails = await waitForMails(request, fx.email, RETURN_MAIL.refund);
      expect(mails).toHaveLength(1);
      expect(mails[0].Text).toContain(PER_ITEM.consultMail);
      expect(mails[0].Text.split(PER_ITEM.consultMail)).toHaveLength(2);
    });

    test('FREQ-641-AC-02: 今すぐ分と送料の上限を超えると押せずちょうどなら返せる', async ({ page, rr }) => {
      // FREQ-641-AC-02。H の着 17000・20000 を同じ行で今すぐ1点・相談1点。今すぐは安い 17000 の着、送料 500 で上限 17500
      const fx = await seedReturn(rr, `ac02-${viewport.name}`, { amounts: [17_000, 20_000], percent: 10, shipping: 500 });
      const { scene, dialog } = await openReceive(page, rr, fx, 'admin');
      await setUnitState(dialog, 0, UNIT_STATES.keep);
      await setUnitState(dialog, 1, UNIT_STATES.keep);
      await chooseConsultByKeyboard(dialog, 1);
      await dialog.getByRole('spinbutton', { name: RETURN_TEXT.shippingAmountLabel(formatYen(500)), exact: true }).fill('500');
      await expect(dialog.getByText(PER_ITEM.cap(formatYen(17_500)), { exact: true })).toBeVisible();
      const amount = dialog.getByRole('spinbutton', { name: PER_ITEM.amountLabel, exact: true });
      await expect(amount).toHaveAttribute('max', '17500');

      await amount.fill('17501');
      await expect(amount).toHaveValue('17501');
      await expect(dialog.getByText(PER_ITEM.capError(formatYen(17_500)), { exact: true })).toBeVisible();
      await expect(amount).toHaveAttribute('aria-invalid', 'true');
      const submitOver17500 = dialog.getByRole('button', { name: PER_ITEM.mixedButtonAny });
      await expect(submitOver17500).toBeDisabled();
      await amount.press('Enter');
      await expect(amount).toHaveValue('17501');
      await expect(submitOver17500).toBeDisabled();
      const postCountBeforeFix = scene.state.posts.receive.length;
      expect(postCountBeforeFix).toBe(0);

      await amount.fill('17500');
      await expect(dialog.getByText(PER_ITEM.capError(formatYen(17_500)), { exact: true })).toHaveCount(0);
      await expectNoOverflow(page, dialog);
      await submitByKeyboard(confirmButton(dialog, PER_ITEM.mixedButton(1, formatYen(17_500), 1)));
      await expect.poll(() => scene.state.posts.receive.length).toBe(1);
      expect(scene.state.posts.receive[0].body).toMatchObject({ refundChoice: 'mixed', refundAmount: 17_500, refundShippingAmount: 500 });

      const refunds = await returnRefundRows(rr.db, fx.orderId);
      expect(refunds).toHaveLength(1);
      const savedRefundAmount = refunds[0].amount;
      expect(savedRefundAmount).toBe(17500);
      expect(await receiptRows(rr.db, fx.returnId)).toHaveLength(1);
      expect(await customerOutboxRows(rr.db, fx.orderId)).toHaveLength(1);
    });

    test('FREQ-641-AC-03: 返金権限なしのP9でも品ごとに選べ金額入力は出ない', async ({ page, rr }) => {
      // FREQ-641-AC-03。お客様の申し込みで返送不要でない返品（P9）を、返金の権限を持たないサポートの人が受け取る
      const fx = await seedReturn(rr, `ac03-${viewport.name}`, { price: 999, quantity: 2, source: 'customer_request' });
      const { scene, dialog } = await openReceive(page, rr, fx, 'supporter');
      await setUnitState(dialog, 0, UNIT_STATES.keep);
      await setUnitState(dialog, 1, UNIT_STATES.keep);
      await expect(choiceRadios(dialog)).toHaveCount(4);
      const refundAmountInputCount = await amountInputs(dialog).count();
      const shippingAmountInputCount = await shippingInputs(dialog).count();
      expect(refundAmountInputCount).toBe(0);
      expect(shippingAmountInputCount).toBe(0);
      await chooseConsultByKeyboard(dialog, 1);
      await expectNoOverflow(page, dialog);
      await submitByKeyboard(confirmButton(dialog, PER_ITEM.mixedButton(1, formatYen(999), 1)));
      await expect.poll(() => scene.state.posts.receive.length).toBe(1);
      const post = scene.state.posts.receive[0].body;
      expect(post).toMatchObject({ refundChoice: 'mixed', refundAmount: null, refundShippingAmount: 0 });
      expect(unitChoices(post).sort()).toEqual(['consult', 'now']);

      const receipts = await receiptRows(rr.db, fx.returnId);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({ refund_choice: 'mixed', actor_can_refund: false });
      expect((await returnRefundRows(rr.db, fx.orderId)).map((row) => row.amount)).toEqual([999]);
      const p9ShopNoticeCount = await shopNoticeCount(rr.db, fx.returnId);
      expect(p9ShopNoticeCount).toBe(1);
      expect(await customerOutboxRows(rr.db, fx.orderId)).toHaveLength(1);
    });

    test('FREQ-641-AC-04: 同じ注文商品の別行で印が逆に付いても1点分を返し相談分が残る', async ({ page, rr }) => {
      // FREQ-641-AC-04。同じ注文商品の返品行 A（17000 の着）を相談、B（20000 の着）を今すぐ。案イの印は逆に付いてもよい（設計 5-1）
      test.setTimeout(180_000);
      const fx = await seedReturn(rr, `ac04-${viewport.name}`, { amounts: [17_000, 20_000], lines: [1, 1] });
      const [lineA, lineB] = fx.lineIds;
      const { scene, dialog } = await openReceive(page, rr, fx, 'admin', false);
      await setUnitState(dialog, 0, UNIT_STATES.keep);
      await setUnitState(dialog, 1, UNIT_STATES.keep);
      await chooseConsultByKeyboard(dialog, 0);
      await expect(unitChoice(dialog, 1, PER_ITEM.now)).toBeChecked();
      await expectNoOverflow(page, dialog);
      await submitByKeyboard(confirmButton(dialog, PER_ITEM.mixedButton(1, formatYen(20_000), 1)));
      await expect.poll(() => scene.state.posts.receive.length).toBe(1);
      const units = scene.state.posts.receive[0].body.units as Array<{ returnLineId: string; refundChoice?: string }>;
      expect(units.find((unit) => unit.returnLineId === lineA)?.refundChoice).toBe('consult');
      expect(units.find((unit) => unit.returnLineId === lineB)?.refundChoice).toBe('now');

      // Stripe の返事待ちの間
      const refunds = await returnRefundRows(rr.db, fx.orderId);
      expect(refunds).toHaveLength(1);
      expect(refunds[0].status).toBe('awaiting_response');
      const nowAmount = refunds[0].amount;
      expect(nowAmount).toBe(20000);
      expect(await waitingQuantity(rr.db, fx.returnId)).toBe(1);
      const waitingAmountWhileAwaitingResponse = await waitingAmount(rr.db, fx.returnId);
      expect(waitingAmountWhileAwaitingResponse).toBe(17000);

      // Stripe が受け付けた後、相談の品の「額を決めて返金する」
      await recordRefundResult(rr.db, refunds[0].id);
      scene.state.returns = await listOrderReturns(rr.client, fx.orderId);
      await syncRefundable(rr, fx, scene.state);
      const later: { made: { refundId: string | null; amount: number } | null } = { made: null };
      const receiveAnswer = scene.state.answerAction;
      scene.state.answerAction = async (route, action, post) => {
        if (action !== 'refund') return receiveAnswer(route, action, post);
        const body = post.body;
        const made = await refundReturnInDb(rr.db, post.returnId, fx.actorId, {
          requestKey: body.requestKey as string, amount: (body.amount as number | null | undefined) ?? null,
          shippingAmount: (body.shippingAmount as number | undefined) ?? 0, notify: body.notifyCustomer as boolean,
        });
        later.made = { refundId: made.refundId, amount: made.amount };
        if (made.refundId) await recordRefundResult(rr.db, made.refundId);
        scene.state.returns = await listOrderReturns(rr.client, fx.orderId);
        await fulfillJson(route, { data: refundData({ amount: made.amount, refundId: made.refundId, status: made.refundId ? 'succeeded' : 'waived' }) });
      };
      await openOrderDetail(page, fx.orderId);
      await openDetailReturnsDialog(page, fx.orderId, '受け取る');
      const refundDialog = await openReturnRefundDialog(page, fx.orderId, fx.label);
      const refundDialogPreview = refundDialog.getByRole('group', { name: '返金の内訳', exact: true });
      await expect(refundDialogPreview).toContainText('￥17,000');
      const refundDialogButton = confirmButton(refundDialog, RETURN_TEXT.refundButton(formatYen(17_000)));
      await expect(refundDialogButton).toHaveAccessibleName('￥17,000 を返金する');
      await expectNoOverflow(page, refundDialog);
      await submitByKeyboard(refundDialogButton);
      await expect.poll(() => scene.state.posts.refund.length).toBe(1);
      await expect.poll(() => later.made?.amount ?? null).not.toBeNull();
      const laterConsultAmount = later.made?.amount;
      expect(laterConsultAmount).toBe(17000);
      const actual = (await rr.db.query('select amount, status from public.order_refunds where id=$1', [later.made?.refundId ?? null])).rows[0];
      const actualConsultRefundAmount = Number(actual.amount);
      expect(actual.status).toBe('succeeded');
      expect(actualConsultRefundAmount).toBe(17000); // 画面の見込みと実額が一致
    });

    test('FREQ-641-AC-05: 今すぐ0円と相談を1回受け取り相談だけを待ちに残す', async ({ page, request, rr }) => {
      // FREQ-641-AC-05。H の着 0・20000 を同じ行で今すぐ1点（安い 0円の着）・相談1点
      test.setTimeout(180_000);
      const fx = await seedReturn(rr, `ac05-${viewport.name}`, { amounts: [0, 20_000] });
      const { scene, dialog } = await openReceive(page, rr, fx, 'admin');
      await setUnitState(dialog, 0, UNIT_STATES.keep);
      await setUnitState(dialog, 1, UNIT_STATES.keep);
      await chooseConsultByKeyboard(dialog, 1);
      await expectNoOverflow(page, dialog);
      await submitByKeyboard(confirmButton(dialog, PER_ITEM.mixedButton(1, formatYen(0), 1)));
      await expect.poll(() => scene.state.posts.receive.length).toBe(1);
      expect(scene.state.posts.receive[0].body.refundChoice).toBe('mixed');

      const refundRows = await returnRefundRows(rr.db, fx.orderId);
      expect(refundRows).toHaveLength(0);
      expect(await receiptRows(rr.db, fx.returnId)).toHaveLength(1);
      expect(await refundWaivedQuantity(rr.db, fx.returnId)).toBe(1);
      expect(await waitingQuantity(rr.db, fx.returnId)).toBe(1);
      const customerOutboxKinds = (await customerOutboxRows(rr.db, fx.orderId)).map((row) => row.kind);
      expect(customerOutboxKinds).toEqual(['return_received']);

      // 受け取りのメールは1通で、今すぐ返金の品と額を相談の品を分けて書く
      const mails = await waitForMails(request, fx.email, RETURN_MAIL.received);
      expect(mails).toHaveLength(1);
      const mailText = mails[0].Text.replaceAll('\r\n', '\n');
      expect(mailText).toContain('今すぐ返金する商品:\n・照合テスト（BLACK / M） × 1\n');
      expect(mailText).toContain('額を相談する商品:\n・照合テスト（BLACK / M） × 1\n');
      expect(mailText.indexOf('今すぐ返金する商品:')).toBeLessThan(mailText.indexOf('額を相談する商品:'));
      expect(mailText.split(PER_ITEM.consultMail)).toHaveLength(2);
    });

    test('FREQ-641-AC-06: P9外の権限なしには選びも金額入力も出ず全品相談になる', async ({ page, rr }) => {
      // FREQ-641-AC-06。お店が作った返品（P9 外）を、返金の権限を持たないサポートの人が受け取る
      const fx = await seedReturn(rr, `ac06-${viewport.name}`, { price: 999, quantity: 2, source: 'shop' });
      const { scene, dialog } = await openReceive(page, rr, fx, 'supporter');
      await setUnitState(dialog, 0, UNIT_STATES.keep);
      await setUnitState(dialog, 1, UNIT_STATES.keep);
      await expect(dialog.getByText(RETURN_TEXT.supportRefundNote, { exact: true })).toBeVisible();
      const refundChoiceRadioCount = await choiceRadios(dialog).count();
      const refundAmountInputCount = await amountInputs(dialog).count();
      expect(refundChoiceRadioCount).toBe(0);
      expect(refundAmountInputCount).toBe(0);
      await expect(shippingInputs(dialog)).toHaveCount(0);
      await expectNoOverflow(page, dialog);
      await submitByKeyboard(confirmButton(dialog, RETURN_TEXT.supportConsultButton));
      await expect.poll(() => scene.state.posts.receive.length).toBe(1);
      const post = scene.state.posts.receive[0].body;
      expect(post.refundChoice).toBe('consult');
      const choices = unitChoices(post);
      // 同じ返品行・同じ状態・同じ選びの品は1要素にまとめ、数量で送る
      const sentQuantity = ((post.units ?? []) as Array<{ quantity?: number }>).reduce(
        (sum, unit) => sum + (unit.quantity ?? 0),
        0,
      );
      expect(choices.length).toBeGreaterThan(0);
      expect(sentQuantity).toBe(2);
      expect(choices.every((choice) => choice === 'consult')).toBe(true);

      const receipts = await receiptRows(rr.db, fx.returnId);
      expect(receipts).toHaveLength(1);
      expect(receipts[0].refund_choice).toBe('consult');
      expect(await returnRefundRows(rr.db, fx.orderId)).toHaveLength(0);
      expect(await shopNoticeCount(rr.db, fx.returnId)).toBe(1);
      expect((await customerOutboxRows(rr.db, fx.orderId)).map((row) => row.kind)).toEqual(['return_received']);
    });
  });
}
