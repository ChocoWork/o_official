/**
 * FR-ADMIN-110 品物のステータス（グループ G-4）
 * 対応 FREQ: FREQ-520（AC-03）、FREQ-536（AC-03）、FREQ-541（AC-05）
 *
 * 注文一覧表（/admin/orders）は、1つの明細を状態ごとの数量の行に分けて出す。12の状態の言葉と順、数量の分割、
 * 支払い手続き中・放棄の除外、色・サイズ未確定の扱い、キャンセル申請中と返品の途中の状態を、手元の DB の材料の注文で確かめる。
 * 画面 → 窓口の差し替え（e2e/order-admin-test-utils.ts の mockOrderAdminBridge）→ 手元の DB の公開関数 list_admin_order_item_rows で読む。
 * 材料の注文は試験ごとに固有のメールアドレスで作り、画面の絞り込みも DB の期待もそのメールアドレスで読む（全体の件数は使わない）。
 * 返品の材料（⑤⑥）は return-test-utils の道具と本物の入口で作る。返品の設定の1行を触るので、鍵は 14314,2 → 190520,0 の順（returnSettings）。
 * キャンセルの申し込み（⑤⑥）だけは、return-test-utils に道具が無いので、DB 材料の insertCancelRequest で直に書く。
 * 並びと「出ない」の確かめは、DB の関数の1回の呼出し（readExportSnapshot。同一時点）で行い、頁を歩かない。
 *
 * この spec が確かめない所（照合先）:
 * - 12状態の導出・数量の分割・金額の配賦の全組合せ・並行 → DB 結合 group_g1_item_states・group_g4_reads
 * - 窓口の認可・MFA・回数の制限・監査 → FR-ADMIN-123 の G-4 の節（本物の窓口の 401/403）と各 route の単体。この spec の bridge の下では DB の関数の権限の確かめを使う
 * - 状態の言葉の辞書（管理用と客向けの分かれ）→ 単体 item-state-types、E-5 の客向けの画面の FR-ORDER-001〜008（この spec ⑥ は、管理の言葉が出ず、対応するお客様の言葉が出ること）
 * - 詳細の頁・入替・返金などの操作 → FR-ADMIN-112・122
 */
import { expect, test, type Page } from '@playwright/test';
import {
  applyFilters,
  countLineOf,
  createCancelRequestMaterial,
  createOrderRowsMaterial,
  createReturnStatesMaterial,
  listRowsOf,
  mockOrderAdminBridge,
  openOrderList,
  openPaymentExceptionInDb,
  readExportSnapshot,
  RETURN_STATES_QUANTITIES,
  statusGroup,
  uniqueEmail,
  withOrderAdminScenario,
  type ListRowOnScreen,
  type OrderAdminContext,
} from './order-admin-test-utils';
import { viewports } from './order-fulfillment-test-utils';
import {
  isolateOrderStatusApiIp,
  openOrderStatusPage,
  prepareOrderStatusTestLink,
  verifyOrderStatusInPage,
} from './order-status-test-utils';
import { mockAdminSessionAs } from './refund-test-utils';
import { DEFAULT_SHIP_TO, expectNoPageOverflow } from './shipping-test-utils';

test.describe.configure({ timeout: 180_000 });

/** 管理用の12の状態の言葉（決めた順）。実装の辞書を import せず、試験が自分で持つ */
const STATUS_LABELS = [
  '未払い', '支払い期限切れ', '受注生産中', '発送準備中', '発送済み', '配達済み',
  'キャンセル申請中', 'キャンセル済み', '返品申請中', '返品受付中', '返金待ち', '返品済み',
] as const;

/** 管理の言葉のうち、お客様の画面に出てはいけない物（E-5） */
const ADMIN_ONLY_WORDS = ['返品受付中', 'キャンセル申請中', '支払い期限切れ'] as const;

/** 管理者（役割 admin）で一覧を開く。bridge の実行者は ctx.actorId（役割 admin） */
async function startList(page: Page, ctx: OrderAdminContext): Promise<void> {
  await mockAdminSessionAs(page, 'admin');
  await mockOrderAdminBridge(page, ctx.client, ctx.actorId);
  await openOrderList(page);
}

/** 行の（ステータス, 数量）の組を、画面の並びのまま */
function statusQuantities(rows: readonly ListRowOnScreen[]): Array<[string, number]> {
  return rows.map((row): [string, number] => [row.cells[11], Number(row.cells[7])]);
}

/** 1つの注文の行を、ステータス → 数量の対応にする */
function quantitiesByStatus(rows: readonly ListRowOnScreen[], orderNumber: string): Record<string, number> {
  return Object.fromEntries(rows.filter((row) => row.cells[0] === orderNumber).map((row) => [row.cells[11], Number(row.cells[7])]));
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-110 item statuses (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('ステータスの絞り込みに12の状態が、決めた順と管理の言葉で並ぶ（未払い・支払い期限切れ・受注生産中・発送準備中・発送済み・配達済み・キャンセル申請中・キャンセル済み・返品申請中・返品受付中・返金待ち・返品済み）', async ({ page }) => {
      // FREQ-520-AC-03（12状態の言葉と順）、FREQ-536-AC-02（ステータスのトグル）
      await withOrderAdminScenario(async (ctx) => {
        await startList(page, ctx);
        const buttons = statusGroup(page).getByRole('button');
        await expect(buttons).toHaveCount(STATUS_LABELS.length);
        expect(await buttons.allInnerTexts()).toEqual([...STATUS_LABELS]);
        // 初めはどれも押していない。複数選べて、押すと印が付き、もう一度押すと外れる
        for (let index = 0; index < STATUS_LABELS.length; index += 1) {
          await expect(buttons.nth(index)).toHaveAttribute('aria-pressed', 'false');
        }
        await buttons.nth(0).click();
        await buttons.nth(5).click();
        await expect(buttons.nth(0)).toHaveAttribute('aria-pressed', 'true');
        await expect(buttons.nth(5)).toHaveAttribute('aria-pressed', 'true');
        await buttons.nth(0).click();
        await expect(buttons.nth(0)).toHaveAttribute('aria-pressed', 'false');
        await expect(buttons.nth(5)).toHaveAttribute('aria-pressed', 'true');
        // キーボード: Space で押せて、Tab で次のトグルへ移れる
        await buttons.nth(1).focus();
        await page.keyboard.press('Space');
        await expect(buttons.nth(1)).toHaveAttribute('aria-pressed', 'true');
        await page.keyboard.press('Tab');
        await expect(buttons.nth(2)).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(buttons.nth(2)).toHaveAttribute('aria-pressed', 'true');
        await expectNoPageOverflow(page);
      });
    });

    test('1つの明細が受注生産中・発送準備中・発送済みに分かれると、状態ごとに別の行になり、数量の和が元の数量に一致する（5点の明細に割当3・うち1点を発送）', async ({ page }) => {
      // FREQ-520-AC-03、FREQ-536-AC-03
      await withOrderAdminScenario(async (ctx) => {
        const email = uniqueEmail('g4-110-split');
        const order = await createOrderRowsMaterial(ctx, { email, lines: [{ quantity: 5, allocated: 3, shipped: 1 }] });
        const line = order.lines[0];
        await startList(page, ctx);
        await applyFilters(page, { email });

        // 状態の定義順（受注生産中 → 発送準備中 → 発送済み）で別の行になり、数量の和が元の数量に一致する
        const rows = await listRowsOf(page);
        expect(statusQuantities(rows)).toEqual([['受注生産中', 2], ['発送準備中', 2], ['発送済み', 1]]);
        expect(rows.reduce((sum, row) => sum + Number(row.cells[7]), 0)).toBe(line.quantity);
        for (const row of rows) {
          expect(row.cells[0]).toBe(order.orderNumber);
          expect(row.cells[4]).toBe(line.itemName);
        }
        expect(await countLineOf(page)).toBe('3行（1件の注文）');

        // DB の1回の読み（同一時点）と同じ
        const snapshot = await readExportSnapshot(ctx.client, ctx.actorId, { email });
        expect(snapshot.rows.map((row) => [row.status, row.quantity])).toEqual([['in_production', 2], ['ready', 2], ['shipped', 1]]);

        // 状態で絞ると、その状態の行だけ
        await applyFilters(page, { email, statuses: ['発送準備中'] });
        expect(statusQuantities(await listRowsOf(page))).toEqual([['発送準備中', 2]]);
        await expectNoPageOverflow(page);
      });
    });

    test('支払い手続き中と放棄の注文は一覧にも要対応の件数にも出ない', async ({ page }) => {
      // FREQ-520-AC-03（payment_in_progress・abandoned は行と注文数から除く）
      await withOrderAdminScenario(async (ctx) => {
        const email = uniqueEmail('g4-110-hidden');
        const visible = await createOrderRowsMaterial(ctx, { email, lines: [{ quantity: 2 }] });
        const inProgress = await createOrderRowsMaterial(ctx, { email, status: 'payment_in_progress', lines: [{ quantity: 2 }] });
        const abandoned = await createOrderRowsMaterial(ctx, { email, status: 'abandoned', lines: [{ quantity: 2 }] });
        // 3つとも未解決の要対応を持つ。支払い手続き中と放棄の分は、一覧にも要対応の絞り込みの件数にも入らない
        for (const material of [visible, inProgress, abandoned]) await openPaymentExceptionInDb(ctx.client, material.orderId);
        await startList(page, ctx);

        await applyFilters(page, { email });
        let rows = await listRowsOf(page);
        expect([...new Set(rows.map((row) => row.cells[0]))]).toEqual([visible.orderNumber]);
        expect(await countLineOf(page)).toBe('1行（1件の注文）');

        await applyFilters(page, { email, attentionOnly: true });
        rows = await listRowsOf(page);
        expect([...new Set(rows.map((row) => row.cells[0]))]).toEqual([visible.orderNumber]);
        expect(rows.every((row) => row.needsAttention)).toBe(true);
        expect(await countLineOf(page)).toBe('1行（1件の注文）');

        // DB の1回の読み（同一時点）でも、支払い手続き中と放棄の注文は無い
        for (const filters of [{ email }, { email, attention: true }]) {
          const snapshot = await readExportSnapshot(ctx.client, ctx.actorId, filters);
          expect([...new Set(snapshot.rows.map((row) => row.orderId))]).toEqual([visible.orderId]);
        }
        await expectNoPageOverflow(page);
      });
    });

    test('色・サイズが未確定の入金済みの注文は受注生産中のままで、発送準備中の行に出ない', async ({ page }) => {
      // FREQ-520-AC-03（variant_id が NULL の明細は割当の対象外で、受注生産中のまま）
      await withOrderAdminScenario(async (ctx) => {
        const email = uniqueEmail('g4-110-variant');
        const normal = await createOrderRowsMaterial(ctx, { email, lines: [{ quantity: 2 }] });
        const missing = await createOrderRowsMaterial(ctx, { email, lines: [{ quantity: 2, variantMissing: true }] });
        await startList(page, ctx);

        await applyFilters(page, { email });
        let rows = await listRowsOf(page);
        expect(quantitiesByStatus(rows, normal.orderNumber)).toEqual({ 発送準備中: 2 });
        expect(quantitiesByStatus(rows, missing.orderNumber)).toEqual({ 受注生産中: 2 });

        // 発送準備中に絞ると、色・サイズ未確定の注文の行は出ない
        await applyFilters(page, { email, statuses: ['発送準備中'] });
        rows = await listRowsOf(page);
        expect(rows.map((row) => row.cells[0])).toEqual([normal.orderNumber]);

        // DB の1回の読みでも、未確定の注文に発送準備中の行は無い
        const snapshot = await readExportSnapshot(ctx.client, ctx.actorId, { email });
        expect(snapshot.rows.filter((row) => row.orderId === missing.orderId).map((row) => row.status)).toEqual(['in_production']);
        await expectNoPageOverflow(page);
      });
    });

    test('キャンセル申請中と返品の途中の状態〔返品申請中・返品受付中・返金待ち・返品済み〕が数量の行として出て、元の発送済みの数と二重に数えない（返品の材料は return-test-utils）', async ({ page }) => {
      // FREQ-520-AC-03。返品は return-test-utils の道具と本物の入口（お客様の申し込み・admin_create_return・受け取り・返金の結果）で作る
      // （Stripe には頼まない）。返品の設定を触るので、鍵は 14314,2 → 190520,0 の順（returnSettings）
      await withOrderAdminScenario(async (ctx) => {
        const email = uniqueEmail('g4-110-returns');
        const returns = await createReturnStatesMaterial(ctx, { email });
        const cancel = await createCancelRequestMaterial(ctx, { email });
        await startList(page, ctx);
        await applyFilters(page, { email });

        const quantities = RETURN_STATES_QUANTITIES;
        const rows = await listRowsOf(page);
        // 10点を送った注文: 返品の途中の数だけが返品の行になり、残りが発送済み。全部で元の10点
        expect(quantitiesByStatus(rows, returns.orderNumber)).toEqual({
          発送済み: quantities.shipped,
          返品申請中: quantities.requested,
          返品受付中: quantities.inProgress,
          返金待ち: quantities.refundWaiting,
          返品済み: quantities.returned,
        });
        const returnsTotal = rows.filter((row) => row.cells[0] === returns.orderNumber).reduce((sum, row) => sum + Number(row.cells[7]), 0);
        expect(returnsTotal).toBe(quantities.total);
        // キャンセルの申し込みのある注文: 1点がキャンセル申請中、残り2点が発送準備中
        expect(quantitiesByStatus(rows, cancel.orderNumber)).toEqual({ キャンセル申請中: 1, 発送準備中: 2 });

        // 状態で絞ると、その状態の行だけ（元の発送済みの行は出ない）
        await applyFilters(page, { email, statuses: ['キャンセル申請中', '返品申請中', '返品受付中', '返金待ち', '返品済み'] });
        const filtered = await listRowsOf(page);
        expect(filtered.map((row) => row.cells[11]).sort()).toEqual(['キャンセル申請中', '返品受付中', '返品申請中', '返品済み', '返金待ち'].sort());
        expect(await countLineOf(page)).toBe('5行（2件の注文）');

        // DB の1回の読み（同一時点）と同じ数量
        const snapshot = await readExportSnapshot(ctx.client, ctx.actorId, { email });
        const sumOf = (orderId: string): number => snapshot.rows.filter((row) => row.orderId === orderId).reduce((sum, row) => sum + row.quantity, 0);
        expect(sumOf(returns.orderId)).toBe(quantities.total);
        expect(sumOf(cancel.orderId)).toBe(3);
        await expectNoPageOverflow(page);
      }, { returnSettings: true });
    });

    test('お客様の注文状況の画面に、管理の言葉〔返品受付中・キャンセル申請中・支払い期限切れ〕が出ない（E-5。入り方は 120 ⑥ と同じ）', async ({ page }) => {
      // FREQ-541-AC-05。本物のお客様の注文状況の頁（/order-status/{リンク}）と本物の窓口を使う。管理画面は開かない
      await withOrderAdminScenario(async (ctx) => {
        const returns = await createReturnStatesMaterial(ctx);
        const cancel = await createCancelRequestMaterial(ctx);
        const expired = await createOrderRowsMaterial(ctx, { status: 'payment_expired', lines: [{ quantity: 2 }] });
        await isolateOrderStatusApiIp(page);
        // 管理の言葉に当たる、お客様の画面の言葉（E-5。画面の辞書: 返品は CUSTOMER_RETURN_STATUS_TEXT、キャンセルの申し込みは
        // OrderReturnsSection、注文の進み具合は ORDER_PROGRESS_LABELS）。試験が自分で持つ
        const targets = [
          {
            word: '返品受付中',
            material: returns,
            verify: true,
            // 4つの返品: 申し込み中（返品申請中）・受付済み（返品受付中）・ご返金の準備中（返金待ち）・返品済み
            expectCustomer: async (): Promise<void> => {
              await expect(page.getByTestId('order-return-status')).toHaveCount(4);
              const labels = await page.getByTestId('order-return-status').allInnerTexts();
              expect([...labels].sort()).toEqual(['お申し込み中', '返品の受付済み', 'ご返金の準備中', '返品済み'].sort());
            },
          },
          {
            word: 'キャンセル申請中',
            material: cancel,
            verify: true,
            expectCustomer: async (): Promise<void> => {
              await expect(page.getByTestId('order-cancel-request-status')).toHaveText('キャンセルのお申し込み中');
            },
          },
          {
            word: '支払い期限切れ',
            material: expired,
            verify: false,
            // 期限切れで閉じた注文のお客様の言葉は、注文の進み具合の「決済失敗」
            expectCustomer: async (): Promise<void> => {
              await expect(page.locator('.account-status').filter({ hasText: '決済失敗' }).first()).toBeVisible();
            },
          },
        ] as const;
        for (const target of targets) {
          const token = await prepareOrderStatusTestLink(ctx.client, target.material.orderId);
          await openOrderStatusPage(page, token);
          await expect(page.getByRole('heading', { name: 'ご注文の状況', level: 1, exact: true })).toBeVisible();
          // 注文の持ち主でない人は、電話番号の下4桁を確かめると、返品・申し込みの記録まで見える
          if (target.verify) await verifyOrderStatusInPage(page, DEFAULT_SHIP_TO.phone.slice(-4));
          // お客様の言葉は出ている（状態の欄が描かれている）うえで、管理の言葉は出ない
          await target.expectCustomer();
          const text = await page.locator('body').innerText();
          for (const word of ADMIN_ONLY_WORDS) {
            expect(text, `お客様の画面（${target.word}の注文）に管理の言葉「${word}」が出ない`).not.toContain(word);
          }
          await expectNoPageOverflow(page);
        }
      }, { returnSettings: true });
    });
  });
}
