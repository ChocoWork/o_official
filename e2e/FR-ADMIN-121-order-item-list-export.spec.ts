/**
 * FR-ADMIN-121 注文一覧表と全件CSV（グループ G-4）
 * 対応 FREQ: FREQ-536（AC-01〜AC-05）、FREQ-537（AC-01・AC-03・AC-04）、FREQ-538（AC-01〜AC-05）
 *
 * 注文一覧表（/admin/orders）の12列・金額の分割・絞り込み・20行の頁・行から詳細への移動・CSV（全行・形式・権限・上限）・
 * 全期間から始まること・一覧の注文の上限の注記を、手元の DB の材料の注文で確かめる。
 * 画面 → 窓口の差し替え（e2e/order-admin-test-utils.ts の mockOrderAdminBridge）→ 手元の DB の公開関数
 * （list_admin_order_item_rows・export_admin_order_item_rows）で読む。権限の許否は DB の関数が決める（bridge は決めない）。
 * 材料の注文は試験ごとに固有のメールアドレスで作り、画面の絞り込みも DB の期待もそのメールアドレスで読む（全体の件数は使わない）。
 * 並びと全行の確かめは、DB の関数の1回の呼出し（readExportSnapshot。同一時点）で行い、頁を歩かない。
 *
 * この spec が確かめない所（照合先）:
 * - 金額の配賦の全組合せ・割引・交換の行の額・返金の種類ごとの配り方 → DB 結合 group_g4_reads（この spec ③ は3点100円の33・33・34と返金の付く行だけ）
 * - 窓口の認可・MFA・回数の制限（CSV 20回/600秒）・監査 → FR-ADMIN-123 の G-4 の節（本物の窓口の 401/403）と各 route の単体。bridge の下では DB の関数の権限の確かめを使う
 * - CSV の式の無害化の全パターン（先頭の = + - @ タブ 改行）・引用符・CRLF の純粋な組立て → 単体 admin-order-csv（この spec ⑦ は画面から出した実物で確かめる）
 * - 詳細の頁の中身・操作 → FR-ADMIN-122（この spec は行から詳細へ移ることと、戻って条件が戻ることだけ）
 */
import { expect, test, type Page } from '@playwright/test';
import { buildOrderItemCsv } from '@/lib/orders/admin-orders/admin-order-csv';
import {
  applyFilters,
  clearFilters,
  columnHeadersOf,
  countLineOf,
  createOrderRowsMaterial,
  downloadCsv,
  expectedCellsOf,
  filterForm,
  goToListPage,
  jstDateOf,
  listRowsOf,
  mockOrderAdminBridge,
  openOrderList,
  openPaymentExceptionInDb,
  pageIndicatorOf,
  parseCsv,
  readExportSnapshot,
  refundLineInDb,
  resetExportCapInDb,
  resetListCapInDb,
  rowLabelOf,
  setExportCapInDb,
  setListCapInDb,
  statusGroup,
  uniqueEmail,
  withOrderAdminScenario,
  type ListFilterFields,
  type OrderAdminContext,
  type OrderRowsLine,
  type OrderRowsMaterial,
} from './order-admin-test-utils';
import { adminOrderDetail, mockOrderDetail, viewports } from './order-fulfillment-test-utils';
import { createPermissionActor, deactivatePermissionActor } from './permission-settings-test-utils';
import { mockAdminSessionAs } from './refund-test-utils';
import { createCatalogMaterial, createExchangeFeeMaterial, expectNoPageOverflow } from './shipping-test-utils';

test.describe.configure({ timeout: 180_000 });

const COLUMN_HEADERS = ['注文ID', '注文日', '顧客名', 'メールアドレス', '商品名', '色', 'サイズ', '数量', '単価', '合計金額', '返金額', 'ステータス'];
const TOO_LARGE_TEXT = '条件に合う行が多すぎます（上限 20,000 行）。「注文日（から）」「注文日（まで）」で期間を絞ってください。';
const CAP_NOTE_TEST_ID = 'cap-note';

/** 管理者（役割 admin）で一覧を開く。bridge の実行者は ctx.actorId（役割 admin） */
async function startList(page: Page, ctx: OrderAdminContext): Promise<void> {
  await mockAdminSessionAs(page, 'admin');
  await mockOrderAdminBridge(page, ctx.client, ctx.actorId);
  await openOrderList(page);
}

/** 受注生産（割当なし）の明細を n 個。名前は試験ごとに固有で、並びの確かめに使える */
function backorderLines(count: number, suffix: string): OrderRowsLine[] {
  return Array.from({ length: count }, (_, index) => ({
    itemName: `E2E行${String(index + 1).padStart(2, '0')}-${suffix}`,
    fulfillmentType: 'backorder' as const,
  }));
}

function suffixOf(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** 25行・3注文の材料（頁・CSV・復元の確かめ用）。新しい順に second, first, bulk（23行） */
async function createTwentyFiveRows(
  ctx: OrderAdminContext,
  email: string,
  suffix: string,
  names: { first?: string; second?: string } = {},
): Promise<{ bulk: OrderRowsMaterial; first: OrderRowsMaterial; second: OrderRowsMaterial }> {
  const bulk = await createOrderRowsMaterial(ctx, { email, orderedDaysAgo: 5, lines: backorderLines(23, suffix) });
  const first = await createOrderRowsMaterial(ctx, {
    email, orderedDaysAgo: 3, customerName: names.first,
    lines: [{ itemName: `E2E新A-${suffix}`, fulfillmentType: 'backorder' }],
  });
  const second = await createOrderRowsMaterial(ctx, {
    email, orderedDaysAgo: 2, customerName: names.second,
    lines: [{ itemName: `E2E新B-${suffix}`, fulfillmentType: 'backorder' }],
  });
  return { bulk, first, second };
}

const amountOf = (cell: string): number => Number(cell.replace(/[¥,]/g, ''));

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-121 order item list and export (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('12列の見出しが決めた順に並ぶ', async ({ page }) => {
      // FREQ-536-AC-01、FREQ-538-AC-01（CSV と共通の見出し）
      await withOrderAdminScenario(async (ctx) => {
        const email = uniqueEmail('g4-121-columns');
        await createOrderRowsMaterial(ctx, { email });
        await startList(page, ctx);
        await applyFilters(page, { email });
        expect(await columnHeadersOf(page)).toEqual(COLUMN_HEADERS);
        await expect(page.getByTestId('order-item-row')).toHaveCount(1);
        await expectNoPageOverflow(page);
      });
    });

    test('注文日・顧客名・メールアドレスが全行に入り、交換の品の行に（交換品）の印が付き、金額は ¥12,800 の形', async ({ page }) => {
      // FREQ-536-AC-01、FREQ-537-AC-04（交換の行の単価・金額は 0 円）
      await withOrderAdminScenario(async (ctx) => {
        const email = uniqueEmail('g4-121-cells');
        const suffix = suffixOf();
        const customerName = `山田 ${suffix}`;
        const plain = await createOrderRowsMaterial(ctx, {
          email, customerName, orderedDaysAgo: 3, lines: [{ itemName: `E2E通常-${suffix}`, unitPrice: 12800, quantity: 1 }],
        });
        const exchange = await createExchangeFeeMaterial(ctx.client, ctx.actorId, {
          customer: { kind: 'guest', email }, shipTo: { fullName: customerName }, orderedDaysAgo: 2, quantity: 3,
        });
        await startList(page, ctx);
        await applyFilters(page, { email });

        const rows = await listRowsOf(page);
        const snapshot = await readExportSnapshot(ctx.client, ctx.actorId, { email });
        // 画面の12のセルは、DB の1回の読み（同一時点）と同じ並び・同じ値（注文日は日本時間 YYYY-MM-DD HH:mm、金額は ¥ と桁区切り）
        expect(rows.map((row) => row.cells)).toEqual(snapshot.rows.map(expectedCellsOf));
        for (const row of rows) {
          expect(row.cells[1]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
          expect(row.cells[2]).toBe(customerName);
          expect(row.cells[3]).toBe(email);
        }
        // 交換の品の行: 商品名に（交換品）の印。単価と金額は ¥0
        const exchangeRow = rows.find((row) => row.cells[4] === `${exchange.exchangeName}（交換品）`);
        expect(exchangeRow, '交換の品の行が出る').toBeDefined();
        expect(exchangeRow?.cells[8]).toBe('¥0');
        expect(exchangeRow?.cells[9]).toBe('¥0');
        expect(rows.filter((row) => row.cells[4].endsWith('（交換品）'))).toHaveLength(snapshot.rows.filter((row) => row.isExchange).length);
        // 金額は ¥12,800 の形
        const plainRow = rows.find((row) => row.cells[0] === plain.orderNumber);
        expect(plainRow?.cells[8]).toBe('¥12,800');
        expect(plainRow?.cells[9]).toBe('¥12,800');
        await expectNoPageOverflow(page);
      });
    });

    test('金額の分割: 3点100円の明細は 33・33・34 の行に分かれ〔発送済み1・発送準備中1・受注生産中1〕、行の合計の和が100。返金は返金した行だけに付き、別の明細の行は ¥0', async ({ page }) => {
      // FREQ-537-AC-01（累積の切り捨てで分け、総和が正味額に一致）、FREQ-537-AC-03（返金はその明細の行だけ）
      await withOrderAdminScenario(async (ctx) => {
        const email = uniqueEmail('g4-121-split');
        const suffix = suffixOf();
        // A（割当2のうち1点を発送し、1点が受注生産中の待ち）と B（返金で在庫が戻る）は別の商品にする。同じ商品だと、B の返金で戻った在庫を
        // 本物の入口の FIFO が A の待ちへ割り当て、A の受注生産中が発送準備中に変わる
        const order = await createOrderRowsMaterial(ctx, {
          email,
          lines: [
            { itemName: `E2E分割A-${suffix}`, quantity: 3, unitPrice: 33, lineTotal: 100, allocated: 2, shipped: 1 },
            { itemName: `E2E分割B-${suffix}`, quantity: 2, allocated: 2, catalog: await createCatalogMaterial(ctx.client) },
          ],
        });
        // 別の明細（B）の1点を発送前に返金する。返金は B の行だけに付く
        await refundLineInDb(ctx, order, { lineIndex: 1, quantity: 1, amount: 5000 });
        await startList(page, ctx);
        await applyFilters(page, { email });

        const rows = await listRowsOf(page);
        const partsA = rows.filter((row) => row.cells[4] === order.lines[0].itemName);
        const partsB = rows.filter((row) => row.cells[4] === order.lines[1].itemName);
        // A: 状態ごとに1点ずつの3行。金額は 33・33・34 で、和は 100。返金は付かない
        expect(partsA.map((row) => [row.cells[11], row.cells[7]]).sort()).toEqual([['受注生産中', '1'], ['発送準備中', '1'], ['発送済み', '1']].sort());
        expect(partsA.map((row) => amountOf(row.cells[9])).sort((a, b) => a - b)).toEqual([33, 33, 34]);
        expect(partsA.reduce((sum, row) => sum + amountOf(row.cells[9]), 0)).toBe(100);
        expect(partsA.map((row) => row.cells[10])).toEqual(['¥0', '¥0', '¥0']);
        // B: 返金した1点（キャンセル済み）の行だけに ¥5,000 が付き、残りの行は ¥0
        expect(partsB.map((row) => [row.cells[11], row.cells[9], row.cells[10]]).sort()).toEqual(
          [['キャンセル済み', '¥5,000', '¥5,000'], ['発送準備中', '¥5,000', '¥0']].sort(),
        );
        // DB の1回の読み（同一時点）と同じ
        const snapshot = await readExportSnapshot(ctx.client, ctx.actorId, { email });
        const lineA = snapshot.rows.filter((row) => row.orderItemId === order.lines[0].orderItemId);
        expect(lineA.reduce((sum, row) => sum + row.lineAmount, 0)).toBe(100);
        expect(snapshot.rows.filter((row) => row.orderItemId === order.lines[1].orderItemId).reduce((sum, row) => sum + row.refundAmount, 0)).toBe(5000);
        await expectNoPageOverflow(page);
      });
    });

    test('絞り込み: 日付・注文ID〔注文番号と、決済ID pi_… の前方一致。大文字小文字を問わない〕・顧客名・メールアドレス・商品名・色・サイズ・ステータス〔複数〕・要対応のみ。商品/色/サイズ/ステータスは合う行だけ、ほかは注文単位。条件をクリアすると戻る。注文日（から）・（まで）は注文日の境目〔日本時間〕で効く', async ({ page }) => {
      // FREQ-536-AC-02。メールアドレスで材料の注文だけに絞ったうえで、条件ごとに出る行を確かめる
      await withOrderAdminScenario(async (ctx) => {
        const email = uniqueEmail('g4-121-filters');
        const suffix = suffixOf();
        const blouse = `ブラウス${suffix}`;
        const skirt = `スカート${suffix}`;
        const o1 = await createOrderRowsMaterial(ctx, {
          email, customerName: `Alice${suffix}`, orderedDaysAgo: 30,
          lines: [
            { itemName: blouse, color: 'ホワイト', size: 'M', quantity: 2 },
            { itemName: skirt, color: 'ブラック', size: 'L', quantity: 1, fulfillmentType: 'backorder' },
          ],
        });
        const o2 = await createOrderRowsMaterial(ctx, {
          email, customerName: `Bob${suffix}`, orderedDaysAgo: 10, lines: [{ itemName: blouse, color: 'ブラック', size: 'S', quantity: 1 }],
        });
        await openPaymentExceptionInDb(ctx.client, o2.orderId);
        // 日本時間の日付の境目: 2026-03-14 23:59（JST）と 2026-03-15 00:01（JST）。UTC では同じ 3/14 の 14:59 と 15:01
        const before = await createOrderRowsMaterial(ctx, {
          email, customerName: `Carol${suffix}`, orderedAt: '2026-03-14T14:59:00.000Z',
          lines: [{ itemName: `境目前${suffix}`, fulfillmentType: 'backorder' }],
        });
        const after = await createOrderRowsMaterial(ctx, {
          email, customerName: `Dave${suffix}`, orderedAt: '2026-03-14T15:01:00.000Z',
          lines: [{ itemName: `境目後${suffix}`, fulfillmentType: 'backorder' }],
        });
        const keyOf = (material: { orderNumber: string }, itemName: string, status: string): string => `${material.orderNumber}|${itemName}|${status}`;
        const O1_BLOUSE = keyOf(o1, blouse, '発送準備中');
        const O1_SKIRT = keyOf(o1, skirt, '受注生産中');
        const O2_BLOUSE = keyOf(o2, blouse, '発送準備中');
        const BEFORE = keyOf(before, `境目前${suffix}`, '受注生産中');
        const AFTER = keyOf(after, `境目後${suffix}`, '受注生産中');
        const ALL = [O1_BLOUSE, O1_SKIRT, O2_BLOUSE, BEFORE, AFTER];

        await startList(page, ctx);
        const reads: URL[] = [];
        page.on('request', (request) => {
          const url = new URL(request.url());
          if (url.pathname === '/api/admin/order-items') reads.push(url);
        });
        const BASE: ListFilterFields = {
          dateFrom: '', dateTo: '', orderNumber: '', customer: '', email, product: '', color: '', size: '', statuses: [], attentionOnly: false,
        };
        const expectRows = async (fields: ListFilterFields, expected: string[]): Promise<void> => {
          await applyFilters(page, { ...BASE, ...fields });
          const rows = await listRowsOf(page);
          expect(rows.map((row) => `${row.cells[0]}|${row.cells[4]}|${row.cells[11]}`).sort(), JSON.stringify(fields)).toEqual([...expected].sort());
        };

        await expectRows({}, ALL);
        // 注文単位: 注文ID（注文番号は ORD- の有無・大文字小文字を問わない）、決済ID（pi_… の前方一致。大文字小文字を問わない）、顧客名、メールアドレス
        await expectRows({ orderNumber: o1.orderNumber.toLowerCase() }, [O1_BLOUSE, O1_SKIRT]);
        await expectRows({ orderNumber: o1.orderNumber.slice('ORD-'.length) }, [O1_BLOUSE, O1_SKIRT]);
        await expectRows({ orderNumber: (o2.paymentIntentId ?? '').slice(0, 16).toUpperCase() }, [O2_BLOUSE]);
        await expectRows({ customer: `alice${suffix}` }, [O1_BLOUSE, O1_SKIRT]);
        await expectRows({ email: email.split('@')[0] }, ALL);
        // 行単位: 商品名・色・サイズ・ステータスは合う行だけ
        await expectRows({ product: blouse }, [O1_BLOUSE, O2_BLOUSE]);
        await expectRows({ color: 'ブラック' }, [O1_SKIRT, O2_BLOUSE]);
        await expectRows({ size: 'L' }, [O1_SKIRT]);
        await expectRows({ statuses: ['発送準備中'] }, [O1_BLOUSE, O2_BLOUSE]);
        await expectRows({ statuses: ['受注生産中'] }, [O1_SKIRT, BEFORE, AFTER]);
        await expectRows({ statuses: ['受注生産中', '発送準備中'] }, ALL);
        // ステータスを複数選ぶと、問合せに status が繰り返し載る
        expect(reads.at(-1)?.searchParams.getAll('status')).toEqual(['in_production', 'ready']);
        await expectRows({ product: blouse, color: 'ブラック' }, [O2_BLOUSE]);
        // 要対応のみ: 未解決の要対応を持つ注文（o2）の行だけ。印も付く
        await expectRows({ attentionOnly: true }, [O2_BLOUSE]);
        expect((await listRowsOf(page)).every((row) => row.needsAttention)).toBe(true);
        // 注文日の境目（日本時間）: 3/15 0:01 は 3/15、3/14 23:59 は 3/14（UTC の日付では逆になる）
        await expectRows({ dateFrom: '2026-03-15', dateTo: '2026-03-15' }, [AFTER]);
        await expectRows({ dateFrom: '2026-03-14', dateTo: '2026-03-14' }, [BEFORE]);
        await expectRows({ dateTo: '2026-03-14' }, [BEFORE]);
        await expectRows({ dateFrom: '2026-03-15', dateTo: '2026-03-31' }, [AFTER]);
        await expectRows({ dateFrom: jstDateOf(o2.orderedAt) }, [O2_BLOUSE]);
        await expectRows({ dateTo: jstDateOf(o1.orderedAt) }, [O1_BLOUSE, O1_SKIRT, BEFORE, AFTER]);

        // 条件をクリアすると、欄・ステータス・要対応のみが全部戻り、条件なしで読み直す
        await applyFilters(page, { ...BASE, product: blouse, statuses: ['発送準備中'], attentionOnly: true, dateFrom: '2026-03-15' });
        await clearFilters(page);
        const form = filterForm(page);
        for (const label of ['注文日（から）', '注文日（まで）', '注文ID', '顧客名', 'メールアドレス', '商品名', '色', 'サイズ']) {
          await expect(form.getByLabel(label, { exact: true })).toHaveValue('');
        }
        const buttons = statusGroup(page).getByRole('button');
        for (let index = 0; index < 12; index += 1) await expect(buttons.nth(index)).toHaveAttribute('aria-pressed', 'false');
        await expect(form.getByRole('button', { name: '要対応のみ', exact: true })).toHaveAttribute('aria-pressed', 'false');
        const lastRead = reads.at(-1);
        expect([...(lastRead?.searchParams.keys() ?? [])]).toEqual(['page']);
        // クリアの後も、もう一度絞り込める
        await expectRows({}, ALL);
        await expectNoPageOverflow(page);
      });
    });

    test('25行の条件で1頁が20行、2頁目が5行になり、総行数と注文数が頁に依らず同じ。前へ・次へ', async ({ page }) => {
      // FREQ-536-AC-03（20行ずつの頁・総行数と注文数は頁に依存しない・安定した並び）
      await withOrderAdminScenario(async (ctx) => {
        const email = uniqueEmail('g4-121-pages');
        const suffix = suffixOf();
        await createTwentyFiveRows(ctx, email, suffix);
        // 並びと総行数は DB の1回の読み（同一時点）。頁を歩いて探さない
        const snapshot = await readExportSnapshot(ctx.client, ctx.actorId, { email });
        expect(snapshot.rowCount).toBe(25);
        expect(snapshot.orderCount).toBe(3);
        const labels = snapshot.rows.map(rowLabelOf);
        await startList(page, ctx);
        await applyFilters(page, { email });

        const previous = page.getByRole('button', { name: '前の頁', exact: true });
        const next = page.getByRole('button', { name: '次の頁', exact: true });
        expect(await countLineOf(page)).toBe('25行（3件の注文）');
        expect(await pageIndicatorOf(page)).toBe('1 / 2ページ');
        expect((await listRowsOf(page)).map((row) => row.label)).toEqual(labels.slice(0, 20));
        await expect(previous).toBeDisabled();
        await expect(next).toBeEnabled();

        await goToListPage(page, 'next');
        expect(await countLineOf(page)).toBe('25行（3件の注文）');
        expect(await pageIndicatorOf(page)).toBe('2 / 2ページ');
        expect((await listRowsOf(page)).map((row) => row.label)).toEqual(labels.slice(20));
        await expect(next).toBeDisabled();
        await expect(previous).toBeEnabled();

        await goToListPage(page, 'previous');
        expect(await pageIndicatorOf(page)).toBe('1 / 2ページ');
        expect((await listRowsOf(page)).map((row) => row.label)).toEqual(labels.slice(0, 20));
        await expectNoPageOverflow(page);
      });
    });

    test('行をキーボードで開く: Tab で行に着き Enter で /admin/orders/{id} へ移る。注文IDのリンクを押しても1回だけ移る', async ({ page }) => {
      // FREQ-536-AC-04（行はリンクとしてキーボードで詳細を開く。リンクと行で二重に移らない）
      await withOrderAdminScenario(async (ctx) => {
        const email = uniqueEmail('g4-121-keys');
        const newer = await createOrderRowsMaterial(ctx, { email, orderedDaysAgo: 1, lines: [{ fulfillmentType: 'backorder' }] });
        const older = await createOrderRowsMaterial(ctx, { email, orderedDaysAgo: 2, lines: [{ fulfillmentType: 'backorder' }] });
        // history.pushState の回数を数える（頁を開く前から。画面の移動の記録に使う）
        await page.addInitScript(() => {
          const w = window as unknown as { __e2ePushes?: number };
          w.__e2ePushes = 0;
          const original = window.history.pushState;
          window.history.pushState = function pushStateCounted(this: History, ...args: Parameters<History['pushState']>) {
            w.__e2ePushes = (w.__e2ePushes ?? 0) + 1;
            return original.apply(this, args);
          };
        });
        await mockAdminSessionAs(page, 'admin');
        await mockOrderAdminBridge(page, ctx.client, ctx.actorId);
        const detail = await mockOrderDetail(page, (orderId) => adminOrderDetail({ id: orderId }));
        const listReads: string[] = [];
        page.on('request', (request) => {
          if (new URL(request.url()).pathname === '/api/admin/order-items') listReads.push(request.url());
        });
        await openOrderList(page);
        await applyFilters(page, { email });

        const rows = page.getByTestId('order-item-row');
        await expect(rows).toHaveCount(2);

        // 注文IDのリンクを押すと、1回だけ詳細へ移る。「戻る」の前（進む側の履歴の項目が無い状態）で測る。戻った後に押すと、
        // 押した移動が進む側の項目を捨てるので history.length は増えない。ここなら数え方が厳密になる:
        // pushState・履歴の項目（history.length）・詳細の窓口の読みがちょうど1つ増え、一覧の窓口は読み直されない
        const pushesBefore = await page.evaluate(() => (window as unknown as { __e2ePushes?: number }).__e2ePushes ?? 0);
        const historyBefore = await page.evaluate(() => window.history.length);
        const detailReadsBefore = detail.urls.length;
        const listReadsBefore = listReads.length;
        const link = rows.nth(1).getByRole('link', { name: older.orderNumber, exact: true });
        await expect(link).toHaveAttribute('href', `/admin/orders/${older.orderId}`);
        await link.click();
        await expect(page).toHaveURL(new RegExp(`/admin/orders/${older.orderId}$`));
        await expect(page.getByRole('heading', { name: `注文 ${older.orderNumber}`, level: 1, exact: true })).toBeVisible();
        const pushesAfter = await page.evaluate(() => (window as unknown as { __e2ePushes?: number }).__e2ePushes ?? 0);
        expect(pushesAfter - pushesBefore, 'リンクを押して移る回数（pushState）').toBe(1);
        expect((await page.evaluate(() => window.history.length)) - historyBefore, 'リンクを押して増える履歴の項目').toBe(1);
        expect(detail.urls.length - detailReadsBefore, 'リンクを押して読む詳細の数').toBe(1);
        expect(listReads.length - listReadsBefore, 'リンクを押した後に一覧を読み直さない').toBe(0);

        // 戻ると、条件が戻った一覧に帰る。Tab で行に着く: 表の領域（フォーカスできる）から Tab を1回押すと、最初の行（新しい注文）に着く
        await page.goBack();
        await expect(page.getByRole('heading', { name: '注文一覧表', level: 1, exact: true })).toBeVisible();
        await expect(rows).toHaveCount(2);
        await page.getByRole('region', { name: '注文一覧表', exact: true }).focus();
        await page.keyboard.press('Tab');
        await expect(rows.nth(0)).toBeFocused();
        await expect(rows.nth(0)).toHaveAttribute('aria-label', `${newer.orderNumber} ${newer.lines[0].itemName} の詳細を開く`);
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(new RegExp(`/admin/orders/${newer.orderId}$`));
        await expect(page.getByRole('heading', { name: `注文 ${newer.orderNumber}`, level: 1, exact: true })).toBeVisible();
        await expectNoPageOverflow(page);
      });
    });

    test('CSV: 25行の条件を出力すると頁の外の行も全部入り〔DB の export の snapshot と行数・値・並びが一致〕、先頭が BOM、見出しが12列、行区切りが CRLF、顧客名の =HYPERLINK(…) が \' で始まり、" と改行を含む顧客名が壊れない。ファイル名は order-items_日付.csv', async ({ page }) => {
      // FREQ-538-AC-02（絞り込みの全行を頁に関係なく同じ時点で）、AC-03（BOM・引用符・改行・CRLF）、AC-04（式の無害化）
      await withOrderAdminScenario(async (ctx) => {
        const email = uniqueEmail('g4-121-csv');
        const suffix = suffixOf();
        const formulaName = '=HYPERLINK("http://example.com","クリック")';
        const quotedName = `山田 "太郎"\n${suffix}`;
        const { first, second } = await createTwentyFiveRows(ctx, email, suffix, { first: formulaName, second: quotedName });
        const snapshot = await readExportSnapshot(ctx.client, ctx.actorId, { email });
        expect(snapshot.rowCount).toBe(25);
        await startList(page, ctx);
        await applyFilters(page, { email });
        expect(await countLineOf(page)).toBe('25行（3件の注文）');

        const csv = await downloadCsv(page);
        // ファイル名は order-items_<日本時間の日付>.csv（日付をまたいで流れた時のために前日も許す）
        const jstToday = jstDateOf(new Date().toISOString());
        const jstYesterday = jstDateOf(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
        expect([`order-items_${jstToday}.csv`, `order-items_${jstYesterday}.csv`]).toContain(csv.filename);
        // 先頭が BOM。行区切りは CRLF（セルの中の改行だけが LF）。DB の1回の読みから組み立てた CSV と一字一句同じ
        expect(csv.text.startsWith('\uFEFF')).toBe(true);
        expect(csv.text).toBe(buildOrderItemCsv(snapshot.rows));
        expect(csv.text.split('\r\n').length - 1, '行（見出し + 25行）ごとに CRLF').toBe(26);
        expect((csv.text.match(/(?<!\r)\n/g) ?? []).length, 'CRLF でない改行はセルの中の1つだけ').toBe(1);
        // 見出しが12列。頁の外の行も全部入り、行数・値・並びが DB の読みと一致する
        const records = parseCsv(csv.text);
        expect(records).toHaveLength(26);
        expect(records[0]).toEqual(COLUMN_HEADERS);
        expect(records.every((record) => record.length === 12)).toBe(true);
        const body = records.slice(1);
        expect(body.map((record) => record[4])).toEqual(snapshot.rows.map((row) => row.itemName));
        expect(body.map((record) => record[7])).toEqual(snapshot.rows.map((row) => String(row.quantity)));
        // 式として評価される先頭の文字は ' を足す。引用符と改行を含む顧客名は壊れない
        const formulaRecord = body.find((record) => record[0] === first.orderNumber);
        expect(formulaRecord?.[2]).toBe(`'${formulaName}`);
        const quotedRecord = body.find((record) => record[0] === second.orderNumber);
        expect(quotedRecord?.[2]).toBe(quotedName);
        await expectNoPageOverflow(page);
      });
    });

    test('権限: サポーター〔初期値〕は一覧と CSV を使える。orders.read を持たない実行者は権限の文だけで CSV が出ない', async ({ page }) => {
      // FREQ-536-AC-05、FREQ-538-AC-05（権限は DB の関数が毎回確かめる。bridge は決めない）
      await withOrderAdminScenario(async (ctx) => {
        const email = uniqueEmail('g4-121-perm');
        const order = await createOrderRowsMaterial(ctx, { email });
        const supporter = await createPermissionActor(ctx.client, 'supporter');
        const nobody = await createPermissionActor(ctx.client, 'supporter');
        await deactivatePermissionActor(ctx.client, nobody);

        // サポーター（初期値）は一覧と CSV を使える
        await mockAdminSessionAs(page, 'supporter');
        await mockOrderAdminBridge(page, ctx.client, supporter);
        await openOrderList(page);
        await applyFilters(page, { email });
        expect((await listRowsOf(page)).map((row) => row.cells[0])).toEqual([order.orderNumber]);
        const csv = await downloadCsv(page);
        const records = parseCsv(csv.text);
        expect(records).toHaveLength(2);
        expect(records[1][0]).toBe(order.orderNumber);
        await expectNoPageOverflow(page);

        // orders.read を持たない実行者: DB の関数が断り、一覧は権限の文だけ、CSV は権限の文が出てダウンロードされない
        const denied = await page.context().newPage();
        try {
          await denied.setViewportSize({ width: viewport.width, height: viewport.height });
          await mockAdminSessionAs(denied, 'supporter');
          await mockOrderAdminBridge(denied, ctx.client, nobody);
          let downloads = 0;
          denied.on('download', () => { downloads += 1; });
          await denied.goto('/admin/orders');
          await expect(denied.getByText('注文一覧を見る権限がありません。', { exact: true })).toBeVisible();
          await expect(denied.getByTestId('order-item-row')).toHaveCount(0);
          await expect(denied.getByTestId('order-item-count')).toHaveCount(0);
          await denied.getByRole('button', { name: 'CSV出力', exact: true }).click();
          await expect(denied.getByText('注文を見る権限がありません。', { exact: true })).toBeVisible();
          expect(downloads).toBe(0);
          await expectNoPageOverflow(denied);
        } finally {
          await denied.close();
        }
      });
    });

    test('上限: 橋渡しの接続で app.group_g_export_cap_rows=2 にすると CSV は断りの文〔「条件に合う行が多すぎます（上限 20,000 行）。「注文日（から）」「注文日（まで）」で期間を絞ってください。」。注文日で絞るよう案内する〕を出し、何もダウンロードされない。設定は取引の中の SET LOCAL〔set_config(…, true)〕で行い、取引を終えるか finally で RESET して、同じワーカーの接続を使う別の case に漏らさない', async ({ page }) => {
      // FREQ-538-AC-05（20,000行超は黙って切らず断る。ここでは上限を 2 に下げて確かめる）
      await withOrderAdminScenario(async (ctx) => {
        const email = uniqueEmail('g4-121-export-cap');
        for (const days of [3, 2, 1]) await createOrderRowsMaterial(ctx, { email, orderedDaysAgo: days, lines: [{ fulfillmentType: 'backorder' }] });
        await startList(page, ctx);
        await applyFilters(page, { email });
        await expect(page.getByTestId('order-item-row')).toHaveCount(3);

        let downloads = 0;
        page.on('download', () => { downloads += 1; });
        const exportButton = page.getByRole('button', { name: 'CSV出力', exact: true });
        // 書き出しの上限を 2 にする（bridge の書き出しだけに、取引の中の SET LOCAL で効かせる）。3注文の条件は上限を超えるので断る
        setExportCapInDb(ctx.client, 2);
        try {
          await exportButton.click();
          await expect(page.getByRole('alert').filter({ hasText: TOO_LARGE_TEXT })).toBeVisible();
          expect(downloads, '断った時は何もダウンロードされない').toBe(0);
          await expect(exportButton).toBeEnabled();
          await expect(page.getByTestId('order-item-row')).toHaveCount(3);
        } finally {
          resetExportCapInDb(ctx.client);
        }
        // 上限を戻すと、同じ条件で出力できる（設定が接続に残らない）
        const csv = await downloadCsv(page);
        expect(parseCsv(csv.text)).toHaveLength(4);
        expect(downloads).toBe(1);
        // 下げた設定が接続に残っていないこと（取引の中の SET LOCAL なので、取引を終えると戻る）
        const leaked = await ctx.client.query("select pg_catalog.current_setting('app.group_g_export_cap_rows', true) as value");
        expect(leaked.rows[0].value ?? '').toBe('');
        await expectNoPageOverflow(page);
      });
    });

    test('頁全体が横にはみ出さず、表は見出しを保ったスクロール領域に収まる', async ({ page }) => {
      // FREQ-536-AC-01・AC-04（表は見出しを保つスクロール領域。頁全体は横にはみ出さない）
      await withOrderAdminScenario(async (ctx) => {
        const email = uniqueEmail('g4-121-layout');
        await createTwentyFiveRows(ctx, email, suffixOf());
        await startList(page, ctx);
        await applyFilters(page, { email });
        await expect(page.getByTestId('order-item-row')).toHaveCount(20);
        await expectNoPageOverflow(page);

        const region = page.getByRole('region', { name: '注文一覧表', exact: true });
        await expect(region).toHaveCSS('overflow-x', 'auto');
        await expect(region).toHaveCSS('overflow-y', 'auto');
        const box = await region.boundingBox();
        expect(box?.width ?? Number.POSITIVE_INFINITY, '領域が画面の幅の中に収まる').toBeLessThanOrEqual(viewport.width);
        // 狭い画面では、表の幅（12列）は頁ではなく領域の中で横に動く
        if (viewport.width < 1200) {
          expect(await region.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
        }
        // キーボードで領域をスクロールしても、見出しの行は領域の上に残る
        const header = region.getByRole('columnheader').first();
        await expect(header).toHaveCSS('position', 'sticky');
        await region.focus();
        await page.keyboard.press('PageDown');
        await expect.poll(() => region.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        const regionBox = await region.boundingBox();
        const headerBox = await header.boundingBox();
        expect(Math.abs((headerBox?.y ?? 0) - (regionBox?.y ?? 0)), '見出しの行が領域の上に残る').toBeLessThanOrEqual(3);
        await expectNoPageOverflow(page);
      });
    });

    test('詳細から「注文一覧表へ戻る」で開き直すと、適用していた条件と頁が戻る〔sessionStorage。URL に載らない〕', async ({ page }) => {
      // FREQ-536-AC-02（条件と頁はこのタブの sessionStorage にだけ持つ。詳細から戻ると同じ条件と頁で読む）
      await withOrderAdminScenario(async (ctx) => {
        const email = uniqueEmail('g4-121-restore');
        await createTwentyFiveRows(ctx, email, suffixOf());
        await mockAdminSessionAs(page, 'admin');
        await mockOrderAdminBridge(page, ctx.client, ctx.actorId);
        await mockOrderDetail(page, (orderId) => adminOrderDetail({ id: orderId }));
        await openOrderList(page);
        await applyFilters(page, { email });
        await goToListPage(page, 'next');
        expect(await pageIndicatorOf(page)).toBe('2 / 2ページ');
        const [target] = await listRowsOf(page);
        // 条件も頁も URL に載らない。このタブの sessionStorage の admin-order-list-state にだけ持つ（localStorage には持たない）
        expect(new URL(page.url()).search).toBe('');
        expect(page.url()).not.toContain(email);
        const stored = await page.evaluate(() => ({
          session: window.sessionStorage.getItem('admin-order-list-state'),
          local: window.localStorage.getItem('admin-order-list-state'),
        }));
        expect(JSON.parse(stored.session ?? 'null')).toMatchObject({ filters: { email }, page: 2 });
        expect(stored.local).toBeNull();

        // 詳細へ移り、「注文一覧表へ戻る」で開き直すと、同じ条件と頁が戻る
        await page.getByTestId('order-item-row').first().getByRole('link').click();
        await expect(page).toHaveURL(new RegExp(`/admin/orders/${target.href?.split('/').pop()}$`));
        await expect(page.getByRole('heading', { name: `注文 ${target.cells[0]}`, level: 1, exact: true })).toBeVisible();
        await page.getByRole('link', { name: '注文一覧表へ戻る', exact: true }).click();
        await expect(page).toHaveURL(/\/admin\/orders$/);
        await expect(page.getByRole('heading', { name: '注文一覧表', level: 1, exact: true })).toBeVisible();
        await expect(filterForm(page).getByLabel('メールアドレス', { exact: true })).toHaveValue(email);
        await expect(page.getByTestId('order-item-row')).toHaveCount(5);
        expect(await pageIndicatorOf(page)).toBe('2 / 2ページ');
        expect(await countLineOf(page)).toBe('25行（3件の注文）');
        expect(new URL(page.url()).search).toBe('');
        expect(page.url()).not.toContain(email);
        await expectNoPageOverflow(page);
      });
    });

    test('全期間から始まる（owner の決定）: 初めて開くと「注文日（から）」は空で、最初の読みの問合せに dateFrom が付かず、120日前・400日前の注文もそのメールアドレスで絞ると出る。期間の注記は出ない。CSV の説明は「現在の絞り込みに合う全行を出力します。」', async ({ page }) => {
      // FREQ-536-AC-02（初めて開いた時は全期間）、FREQ-538-AC-01（CSV の説明）
      await withOrderAdminScenario(async (ctx) => {
        const email = uniqueEmail('g4-121-all-periods');
        const recent = await createOrderRowsMaterial(ctx, { email, lines: [{ fulfillmentType: 'backorder' }] });
        const older = await createOrderRowsMaterial(ctx, { email, orderedDaysAgo: 120, lines: [{ fulfillmentType: 'backorder' }] });
        const oldest = await createOrderRowsMaterial(ctx, { email, orderedDaysAgo: 400, lines: [{ fulfillmentType: 'backorder' }] });
        await mockAdminSessionAs(page, 'admin');
        await mockOrderAdminBridge(page, ctx.client, ctx.actorId);
        const reads: URL[] = [];
        page.on('request', (request) => {
          const url = new URL(request.url());
          if (url.pathname === '/api/admin/order-items') reads.push(url);
        });
        await openOrderList(page);

        // 最初の読みの問合せに日付が付かない（全期間）。注文日（から）は空
        expect(reads.length).toBeGreaterThanOrEqual(1);
        expect(reads[0].searchParams.has('dateFrom')).toBe(false);
        expect(reads[0].searchParams.has('dateTo')).toBe(false);
        await expect(filterForm(page).getByLabel('注文日（から）', { exact: true })).toHaveValue('');
        await expect(filterForm(page).getByLabel('注文日（まで）', { exact: true })).toHaveValue('');
        await expect(page.getByText('現在の絞り込みに合う全行を出力します。', { exact: true })).toBeVisible();

        // 120日前・400日前の注文も、そのメールアドレスで絞ると出る。期間の注記（上限の注記）は出ない
        await applyFilters(page, { email });
        expect(new Set((await listRowsOf(page)).map((row) => row.cells[0]))).toEqual(
          new Set([recent.orderNumber, older.orderNumber, oldest.orderNumber]),
        );
        expect(await countLineOf(page)).toBe('3行（3件の注文）');
        await expect(page.getByTestId(CAP_NOTE_TEST_ID)).toHaveCount(0);
        await expect(page.getByRole('status').filter({ hasText: '期間' })).toHaveCount(0);
        await expectNoPageOverflow(page);
      });
    });

    test('一覧の注文の上限は断らず注記で知らせる: 専用の接続で set_config(\'app.group_g_list_cap_orders\', \'2\', false) し、case の最後に finally で RESET して、同じ固有メールの4注文〔注文日を1日ずつずらす〕を絞り込むと、新しい2注文の行だけが出て、件数の行が「${行数}行（新しい2件の注文の中で）」になり、その近くに「新しい2件の注文だけを表示しています。それより前の注文は「注文日（まで）」で期間を絞ると表示されます。」が出る〔本番の上限では「新しい5,000件の注文だけを表示しています。…」。文の数は応答の ordersCap〕。「注文日（まで）」を3番目の注文の日にして絞り込むと、残りの2注文が出て注記が消え、件数の行は「${行数}行（2件の注文）」に戻る。上限で切っている間も CSV は4注文の行を全部出す〔DB の export の snapshot と行数・値・並びが一致〕。上限の設定を戻した後は注記が出ない', async ({ page }) => {
      // FREQ-536-AC-03（新しい5000件の注文で切る時は断らず注記で知らせる）、FREQ-538-AC-02（CSV は一覧の上限を受けない）
      await withOrderAdminScenario(async (ctx) => {
        const email = uniqueEmail('g4-121-list-cap');
        const suffix = suffixOf();
        // 注文日を1日ずつずらした4注文（古い順に o4, o3, o2, o1）
        const made: OrderRowsMaterial[] = [];
        for (const days of [4, 3, 2, 1]) {
          made.push(await createOrderRowsMaterial(ctx, { email, orderedDaysAgo: days, lines: [{ itemName: `E2E上限${days}-${suffix}`, fulfillmentType: 'backorder' }] }));
        }
        const [o4, o3, o2, o1] = made;
        const CAP_NOTE = '新しい2件の注文だけを表示しています。それより前の注文は「注文日（まで）」で期間を絞ると表示されます。';
        await startList(page, ctx);
        try {
          await setListCapInDb(ctx.client, 2);
          await applyFilters(page, { email });

          // 新しい2注文の行だけが出て、件数の行は「新しい2件の注文の中で」、近くに上限の注記が出る
          expect(new Set((await listRowsOf(page)).map((row) => row.cells[0]))).toEqual(new Set([o1.orderNumber, o2.orderNumber]));
          expect(await countLineOf(page)).toBe('2行（新しい2件の注文の中で）');
          const note = page.getByTestId(CAP_NOTE_TEST_ID);
          await expect(note).toHaveText(CAP_NOTE);
          await expect(note).toHaveAttribute('role', 'status');

          // 「注文日（まで）」を3番目の注文の日にすると、残りの2注文が出て注記が消え、件数の行は元の書き方に戻る
          await applyFilters(page, { email, dateTo: jstDateOf(o3.orderedAt) });
          expect(new Set((await listRowsOf(page)).map((row) => row.cells[0]))).toEqual(new Set([o3.orderNumber, o4.orderNumber]));
          expect(await countLineOf(page)).toBe('2行（2件の注文）');
          await expect(page.getByTestId(CAP_NOTE_TEST_ID)).toHaveCount(0);

          // 上限で切っている間も、CSV は4注文の行を全部出す（DB の export の snapshot と行数・値・並びが一致）
          await applyFilters(page, { email, dateTo: '' });
          await expect(page.getByTestId(CAP_NOTE_TEST_ID)).toHaveText(CAP_NOTE);
          const csv = await downloadCsv(page);
          const snapshot = await readExportSnapshot(ctx.client, ctx.actorId, { email });
          expect(snapshot.rowCount).toBe(4);
          expect(snapshot.orderCount).toBe(4);
          expect(csv.text).toBe(buildOrderItemCsv(snapshot.rows));
          expect(parseCsv(csv.text).slice(1).map((record) => record[0])).toEqual([o1, o2, o3, o4].map((order) => order.orderNumber));
        } finally {
          await resetListCapInDb(ctx.client);
        }
        // 上限の設定を戻した後は、4注文が全部出て、注記が出ない
        await applyFilters(page, { email });
        expect(await countLineOf(page)).toBe('4行（4件の注文）');
        await expect(page.getByTestId(CAP_NOTE_TEST_ID)).toHaveCount(0);
        await expectNoPageOverflow(page);
      });
    });
  });
}
