/**
 * FR-ADMIN-120 同梱の発送票の発送メール（グループ G-3）
 * 対応 FREQ: FREQ-533（AC-05）、FREQ-534（AC-01）、FREQ-541（AC-03）
 *
 * 同じ会員の2つの注文（宛先のメールアドレスは注文ごとに別）を1つの発送票で確定し、注文ごとにメールが 1 通届くことを手元の Mailpit で確かめる。
 * 材料の注文と票は DB の公開関数で作り（e2e/shipping-test-utils.ts）、メールは起動したアプリの毎分の定期処理が送る。宛先は試験ごとの新しいアドレスだけで探す。
 * 伝票番号の後入力は発送票の画面（bridge 経由の DB の関数）で操作する。お客様の画面は本物のお客様のログインと本物の窓口・画面を使う。
 *
 * この spec が確かめない所（照合先）:
 * - メール本文の全文・番号ありの完全一致・番号なしの組み立て → 単体 order-email-compose-shipped・order-email-compose-delivery
 * - 同じ request_key の再送・並行の確定でメールの予定が増えないこと → DB 結合 group_g3_confirm・group_g3_concurrency
 * - 追跡（17TRACK）の登録・読み直し → FR-ACCOUNT-042・FR-ADMIN-102（追跡オフでもこの spec の確かめは成立する）
 */
import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { SHIPMENT_SLIP_TEXT } from '@/lib/orders/shipment-slips/shipment-slip-types';
import { SHIPPING_CARRIERS } from '@/lib/orders/shipping-carriers';
import {
  customerApi,
  customerShipment,
  expectMailCountStays,
  expectNoHorizontalOverflow,
  loginCustomer,
  openCustomerOrder,
  pollMails,
} from './delivery-tracking-test-utils';
import { mailsTo, uniqueEmail } from './order-email-test-utils';
import { viewports } from './order-fulfillment-test-utils';
import {
  isolateOrderStatusApiIp,
  openOrderStatusPage,
  prepareOrderStatusTestLink,
  verifyOrderStatusInPage,
} from './order-status-test-utils';
import {
  confirmSlipInDb,
  createDraftInDb,
  createMemberUser,
  createShippingMaterial,
  expectNoPageOverflow,
  fulfillmentsOf,
  jstToday,
  noticeOf,
  openSlip,
  outboxCount,
  prepareShippingPage,
  shipMaterialsInDb,
  withShippingScenario,
  type ShippingContext,
  type ShippingMaterial,
} from './shipping-test-utils';

// 会員のログインは確認コードとログインの Cookie をブラウザの通信に載せるので、通信記録（trace）を残さない
// （trace は worker 単位の設定なので、ファイルの最上位に置く）
test.use({ trace: 'off' });
test.describe.configure({ timeout: 300_000 });

const SHIPPED = '商品を発送いたしました';
const UPDATED = '発送の情報を更新しました';
const REMAINING = '残りの商品は、準備ができ次第お送りします。';
const LATER = '伝票番号が決まりましたら、あらためてお知らせいたします。';
const SUPERSEDED = '先にお知らせした伝票番号は使えません';

/** 同じ会員の2つの注文（メールアドレスは注文ごとに別。a は 4 点、b は 3 点） */
async function createBundle(ctx: ShippingContext): Promise<{ a: ShippingMaterial; b: ShippingMaterial }> {
  const member = await createMemberUser(ctx.client, 'g3mail');
  const a = await createShippingMaterial(ctx.client, {
    quantity: 4, orderedDaysAgo: 20, customer: { kind: 'member', userId: member.userId, email: uniqueEmail('g3-mail-a') },
  });
  const b = await createShippingMaterial(ctx.client, {
    quantity: 3, orderedDaysAgo: 10, customer: { kind: 'member', userId: member.userId, email: uniqueEmail('g3-mail-b') },
  });
  return { a, b };
}

/** その宛先へのメールがちょうど 1 通（件名が指定の物）。本文を返す */
async function onlyMail(request: APIRequestContext, material: ShippingMaterial, subject: string): Promise<string> {
  const mails = await pollMails(request, material.email, subject, 1);
  return mails[0].Text;
}

function itemLine(material: ShippingMaterial, quantity: number): string {
  return `・${material.itemName}（${material.colorName} / ${material.sizeLabel}） x${quantity}`;
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-120 combined shipment emails (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('同梱の票で、注文ごとに発送メールが1通（宛先はその注文のメールアドレス）届く（手元のMailpit）', async ({ request }) => {
      // FREQ-533-AC-05
      await withShippingScenario(async (ctx) => {
        const { a, b } = await createBundle(ctx);
        const confirmed = await shipMaterialsInDb(ctx, [a, b], {
          quantities: [2, 3], carrier: 'yamato', trackingNumber: `E2E-MAIL-${randomUUID().slice(0, 8).toUpperCase()}`, notifyCustomer: true,
        });
        expect(confirmed.fulfillments).toHaveLength(2);

        // 予定は注文ごとに 1 つ。各宛先に 1 通ずつだけ届く（その注文のメールアドレス宛）
        expect(await outboxCount(ctx.client, [a.orderId], ['shipped'])).toBe(1);
        expect(await outboxCount(ctx.client, [b.orderId], ['shipped'])).toBe(1);
        const toA = await pollMails(request, a.email, SHIPPED, 1);
        const toB = await pollMails(request, b.email, SHIPPED, 1);
        expect(toA[0].Subject).toBe(`【Le Fil des Heures】商品を発送いたしました（${a.orderNumber}）`);
        expect(toB[0].Subject).toBe(`【Le Fil des Heures】商品を発送いたしました（${b.orderNumber}）`);
        expect(await mailsTo(request, a.email)).toHaveLength(1);
        expect(await mailsTo(request, b.email)).toHaveLength(1);
      });
    });

    test('各メールにはその注文の品物と数・残りの案内だけがあり、同じ票の別の注文の注文番号・品物・氏名・住所が無い', async ({ request }) => {
      // FREQ-533-AC-05, FREQ-541-AC-03
      await withShippingScenario(async (ctx) => {
        const { a, b } = await createBundle(ctx);
        await shipMaterialsInDb(ctx, [a, b], {
          quantities: [2, 3], carrier: 'yamato', trackingNumber: `E2E-MAIL-${randomUUID().slice(0, 8).toUpperCase()}`, notifyCustomer: true,
        });
        const textA = await onlyMail(request, a, SHIPPED);
        const textB = await onlyMail(request, b, SHIPPED);

        // a は 4 点のうち 2 点を送ったので、残りの案内がある。b は 3 点とも送ったので、残りの案内が無い
        expect(textA).toContain(`注文番号: ${a.orderNumber}`);
        expect(textA).toContain(itemLine(a, 2));
        expect(textA).toContain(REMAINING);
        expect(textB).toContain(`注文番号: ${b.orderNumber}`);
        expect(textB).toContain(itemLine(b, 3));
        expect(textB).not.toContain(REMAINING);

        // 同じ票の別の注文の情報は入らない（注文番号・品物・メールアドレス）。配送先（住所・郵便番号・電話）はこのメールに載らない。
        // 氏名は別に確かめない: 同梱できるのは配送先7項目（氏名を含む）が完全に一致する注文だけなので、別の注文の氏名は自分の氏名と同じで、
        // 「別の注文の氏名が入っていない」ことを区別して確かめようがない（宛名の挨拶は自分の注文の氏名）。氏名以外の配送先が載らないことで、配送先の漏れを見る
        for (const [text, other] of [[textA, b], [textB, a]] as const) {
          expect(text).not.toContain(other.orderNumber);
          expect(text).not.toContain(other.itemName);
          expect(text).not.toContain(other.email);
          expect(text).not.toContain(other.orderId);
        }
        for (const text of [textA, textB]) {
          expect(text).not.toContain(a.shipTo.address);
          expect(text).not.toContain(a.shipTo.postalCode);
          expect(text).not.toContain(a.shipTo.phone);
        }
        // 荷物の情報は票の共通の値（運送会社と追跡番号）
        for (const text of [textA, textB]) {
          expect(text).toContain(`配送業者: ${SHIPPING_CARRIERS.yamato.label}`);
          expect(text).toContain('追跡番号: E2E-MAIL-');
        }
      });
    });

    test('同じ要求の再送・画面の再読込でメールが増えない', async ({ page, request }) => {
      // FREQ-533-AC-03, FREQ-533-AC-05
      await withShippingScenario(async (ctx) => {
        const { a, b } = await createBundle(ctx);
        const requestKey = randomUUID();
        const shipmentDate = jstToday();
        const draft = await createDraftInDb(ctx, [a, b], [2, 3]);
        const options = {
          carrier: 'yamato' as const, trackingNumber: `E2E-MAIL-${randomUUID().slice(0, 8).toUpperCase()}`,
          notifyCustomer: true, shipmentDate, requestKey,
        };
        await confirmSlipInDb(ctx.client, ctx.actorId, draft, options);
        await pollMails(request, a.email, SHIPPED, 1);
        await pollMails(request, b.email, SHIPPED, 1);

        // 同じ要求番号・同じ内容の再送は前の結果を返し（replayed）、予定も発送も増えない
        const replay = await confirmSlipInDb(ctx.client, ctx.actorId, draft, options);
        expect(replay.replayed).toBe(true);
        expect(await outboxCount(ctx.client, [a.orderId, b.orderId], ['shipped'])).toBe(2);
        expect(await fulfillmentsOf(ctx.client, a.orderId)).toHaveLength(1);
        expect(await fulfillmentsOf(ctx.client, b.orderId)).toHaveLength(1);

        // 画面の再読込でも増えない
        await prepareShippingPage(page, ctx);
        await openSlip(page, draft.id);
        await page.reload();
        await expect(page.getByTestId('slip-stage')).toContainText('発送済み');
        await expectNoPageOverflow(page);

        // 毎分の処理を重ねても、各宛先 1 通のまま
        await expectMailCountStays(request, a.email, SHIPPED, 1);
        await expectMailCountStays(request, b.email, SHIPPED, 1);
      });
    });

    test('通知を外した票にはメールが届かない', async ({ request }) => {
      // FREQ-533-AC-05
      await withShippingScenario(async (ctx) => {
        const { a, b } = await createBundle(ctx);
        await shipMaterialsInDb(ctx, [a, b], { quantities: [2, 3], notifyCustomer: false });
        expect(await outboxCount(ctx.client, [a.orderId, b.orderId], ['shipped'])).toBe(0);
        expect(await fulfillmentsOf(ctx.client, a.orderId)).toHaveLength(1);
        expect(await fulfillmentsOf(ctx.client, b.orderId)).toHaveLength(1);
        await expectMailCountStays(request, a.email, SHIPPED, 0);
        await expectMailCountStays(request, b.email, SHIPPED, 0);
        expect(await mailsTo(request, a.email)).toHaveLength(0);
        expect(await mailsTo(request, b.email)).toHaveLength(0);
      });
    });

    test('伝票番号なしの票のメールには配送業者・追跡番号・追跡リンクが無く、後から番号を入れると更新メールが注文ごとに1通届き、「先にお知らせした伝票番号は使えません」は入らない', async ({ page, request }) => {
      // FREQ-533-AC-05, FREQ-534-AC-01
      await withShippingScenario(async (ctx) => {
        const { a, b } = await createBundle(ctx);
        const confirmed = await shipMaterialsInDb(ctx, [a, b], { quantities: [2, 3], notifyCustomer: true });

        // 番号なしの発送メール: 追跡の欄が無く、番号が決まったらお知らせする案内がある
        for (const material of [a, b]) {
          const text = await onlyMail(request, material, SHIPPED);
          expect(text).not.toContain('配送業者:');
          expect(text).not.toContain('追跡番号:');
          expect(text).not.toContain('追跡はこちら:');
          expect(text).toContain(LATER);
        }

        // 発送票の画面で、後から運送会社と伝票番号を入れる（更新のメールは最初からオン）
        await prepareShippingPage(page, ctx);
        await openSlip(page, confirmed.id);
        await expect(page.getByText('伝票番号は未入力です', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: SHIPMENT_SLIP_TEXT.trackingEnter, exact: true }).click();
        const dialog = page.getByRole('dialog', { name: SHIPMENT_SLIP_TEXT.trackingEnter, exact: true });
        await expect(dialog).toBeVisible();
        const trackingNumber = `E2E-LATE-${randomUUID().slice(0, 8).toUpperCase()}`;
        // 運送会社の選択欄は、ラベルの文字に選択肢の文字が混ざる（getByLabel の exact が当たらない）ので、役割と名前で探す
        await dialog.getByRole('combobox', { name: SHIPMENT_SLIP_TEXT.carrierLabel, exact: true }).selectOption('sagawa');
        await dialog.getByLabel(SHIPMENT_SLIP_TEXT.trackingNumberLabel, { exact: true }).fill(trackingNumber);
        await dialog.getByRole('checkbox', { name: SHIPMENT_SLIP_TEXT.trackingNotify, exact: true }).check();
        await dialog.getByRole('button', { name: SHIPMENT_SLIP_TEXT.trackingSubmitEnter, exact: true }).click();
        await expect(noticeOf(page, SHIPMENT_SLIP_TEXT.trackingUpdated)).toBeVisible();
        await expect(page.getByText(`${SHIPPING_CARRIERS.sagawa.label} ${trackingNumber}`, { exact: true })).toBeVisible();
        await expectNoPageOverflow(page);

        // 更新メールが注文ごとに 1 通。番号を初めて入れたので、使えなくなる番号の行は入らない
        for (const material of [a, b]) {
          const text = await onlyMail(request, material, UPDATED);
          expect(text).toContain(`注文番号: ${material.orderNumber}`);
          expect(text).toContain(`配送業者: ${SHIPPING_CARRIERS.sagawa.label}`);
          expect(text).toContain(`追跡番号: ${trackingNumber}`);
          expect(text).toContain('追跡はこちら:');
          expect(text).not.toContain(SUPERSEDED);
        }
        expect(await outboxCount(ctx.client, [a.orderId, b.orderId], ['shipping_update'])).toBe(2);
        // 最初の発送メールは 1 通のまま
        await expectMailCountStays(request, a.email, SHIPPED, 1);
        await expectMailCountStays(request, b.email, SHIPPED, 1);
        await expectMailCountStays(request, a.email, UPDATED, 1);
        await expectMailCountStays(request, b.email, UPDATED, 1);
      });
    });

    test('お客様の注文画面・注文状況の頁に、同じ票の別の注文の情報が出ない', async ({ page, browser }) => {
      // FREQ-541-AC-03。本物のお客様のログイン（確認コードは Mailpit から読む）と本物の窓口・画面を使う
      await withShippingScenario(async (ctx) => {
        const member = await loginCustomer(page, 'g3cust');
        const a = await createShippingMaterial(ctx.client, {
          quantity: 2, orderedDaysAgo: 8, customer: { kind: 'member', userId: member.userId, email: member.email },
        });
        const b = await createShippingMaterial(ctx.client, {
          quantity: 2, orderedDaysAgo: 4, customer: { kind: 'member', userId: member.userId, email: uniqueEmail('g3-cust-b') },
        });
        const confirmed = await shipMaterialsInDb(ctx, [a, b], {
          carrier: 'yamato', trackingNumber: `E2E-CUST-${randomUUID().slice(0, 8).toUpperCase()}`, notifyCustomer: false,
        });
        const fulfillmentOfB = confirmed.fulfillments.find((entry) => entry.orderId === b.orderId)?.fulfillmentId ?? '';
        expect(fulfillmentOfB).not.toBe('');
        const foreign = [b.orderId, b.orderNumber, b.itemName, b.email, fulfillmentOfB];

        // 窓口の答え: a の注文だけ。b の注文番号・品物・メールアドレス・発送の番号は無い
        const api = await customerApi(page, `/api/orders/${a.orderId}`);
        expect(api.status).toBe(200);
        const text = JSON.stringify(api.body);
        expect(text).toContain(a.itemName);
        for (const value of foreign) expect(text, '窓口の答えに別の注文の情報が無い').not.toContain(value);
        expect(api.body.shipments).toHaveLength(1);

        // お客様の注文の画面: a の発送だけが出る
        await openCustomerOrder(page, a.orderId);
        await expect(customerShipment(page, 1)).toBeVisible();
        const body = await page.locator('body').innerText();
        expect(body).toContain(a.itemName);
        for (const value of foreign) expect(body, '注文の画面に別の注文の情報が無い').not.toContain(value);
        await expectNoHorizontalOverflow(page);

        // 注文状況の頁。持ち主の会員は、リンクを開くと下4桁の確認なしで個人情報の欄まで見える（FREQ-501-AC-01）。別の注文の情報は出ない
        const token = await prepareOrderStatusTestLink(ctx.client, a.orderId);
        await isolateOrderStatusApiIp(page);
        await openOrderStatusPage(page, token);
        await expect(page.getByRole('heading', { name: 'ご注文の状況', level: 1, exact: true })).toBeVisible();
        await expect(page.getByRole('region', { name: '配送情報（1回目）', exact: true })).toBeVisible();
        const ownerHtml = await page.content();
        expect(ownerHtml).toContain(a.itemName);
        for (const value of foreign) expect(ownerHtml, '注文状況の頁（持ち主の会員）に別の注文の情報が無い').not.toContain(value);
        await expectNoHorizontalOverflow(page);

        // ログインしていない人（別の文脈）は、リンクを開いても下4桁を確かめるまでは個人情報が出ない。確かめる前も後も、別の注文の情報は出ない
        const guest = await browser.newContext({ viewport: page.viewportSize() ?? undefined });
        try {
          const guestPage = await guest.newPage();
          await isolateOrderStatusApiIp(guestPage);
          await openOrderStatusPage(guestPage, token);
          await expect(guestPage.getByRole('button', { name: '確かめる', exact: true })).toBeVisible();
          const publicHtml = await guestPage.content();
          for (const value of foreign) expect(publicHtml, '注文状況の頁（確認前）に別の注文の情報が無い').not.toContain(value);
          await verifyOrderStatusInPage(guestPage, a.shipTo.phone.slice(-4));
          const privateHtml = await guestPage.content();
          expect(privateHtml).toContain(a.itemName);
          for (const value of foreign) expect(privateHtml, '注文状況の頁（確認後）に別の注文の情報が無い').not.toContain(value);
          await expectNoHorizontalOverflow(guestPage);
        } finally {
          await guest.close();
        }
      });
    });
  });
}
