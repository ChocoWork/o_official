import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  cancelRefund,
  failRefund,
  seedCancelRefund,
  seedPreShipmentCancel,
  shipUnits,
  succeedRefund,
} from '../tests/integration/db/helpers/accounting-returns-fixtures';
import {
  ledgerRowCells,
  selectAccountingPeriod,
  selectLedgerAccount,
  withAccountingScenario,
  type AccountingScenario,
} from './accounting-test-utils';
import { CHECKOUT_VIEWPORTS, expectNoHorizontalOverflow } from './checkout-flow-helpers';

// FREQ-577 / FREQ-579 / FREQ-583（計画3）: 返金の仕訳（発送前の返金・失敗と振込・取り消しの区分・消費税用の返金の一覧）を、本物の route・本物の画面・手元の Supabase で確かめる。
// 返金は DB の道具で始める（begin_order_refund・record_order_refund_result は本物の関数）。Stripe は呼ばず、stripe_refunds と stripe_balance_transactions の行を
// 手元の DB へ直に入れる。これは「画面と帳簿の表示の証拠」であって、実 Stripe の証拠ではない（本物の Stripe の読みは確かめない）。
// 計上は本物の係（accounting_run_posting）、取り消しの区分・振込の記録・一覧は本物の画面と route。E2E は今日の日付だけを使う。
// 仕訳・返金・計上待ちは消せないので db reset してから流す。

test.use({ trace: 'off', locale: 'ja-JP' });
// 仕訳・計上待ち・返金は全体で共有する状態なので、このファイルの中は1つずつ流す（他のファイルとは並列）。
test.describe.configure({ mode: 'default' });

const yen = (value: number) => value.toLocaleString('ja-JP');
const orderNumberOf = (orderId: string) => `ORD-${orderId.slice(0, 8).toUpperCase()}`;
const nowIso = () => new Date().toISOString();

/** 注文の勘定の残高（貸方−借方。sub を渡すと補助を絞る） */
async function balanceOf(s: AccountingScenario, orderId: string, account: string, sub: string | null = null): Promise<number> {
  return Number((await s.db.query('select private.accounting_order_account_balance($1,$2,$3) as n', [orderId, account, sub])).rows[0].n);
}

/** 注文の仕訳の行（入った順）。event_kind つき */
async function orderEntries(s: AccountingScenario, orderId: string, kind: string) {
  return (await s.db.query(
    `select e.id, to_char(e.entry_date, 'YYYY-MM-DD') as entry_date, l.account_code as account, l.debit::int as debit, l.credit::int as credit, l.sub_account as sub
       from public.accounting_journal_entries e join public.accounting_journal_lines l on l.entry_id = e.id
      where l.order_id = $1 and e.event_kind = $2 order by e.entry_no, l.line_no`,
    [orderId, kind],
  )).rows as Array<{ id: string; entry_date: string; account: string; debit: number; credit: number; sub: string | null }>;
}

const shape = (rows: Array<{ account: string; debit: number; credit: number; sub: string | null }>) => rows.map((row) => [row.account, row.debit, row.credit, row.sub]);

/** 計上待ち・借りの一覧は50件ずつ。自分の行が出るまで「さらに読み込む」を押す */
async function showRow(page: Page, row: Locator): Promise<void> {
  for (let i = 0; i < 30 && (await row.count()) === 0; i += 1) {
    const more = page.getByRole('button', { name: 'さらに読み込む', exact: true });
    if ((await more.count()) === 0) break;
    await more.first().click();
  }
  await expect(row.first()).toBeVisible({ timeout: 30_000 });
}

/** 帳簿の仕訳・元帳で、科目と伝票番号の行の欄を読む */
async function ledgerCells(page: Page, periodName: string, account: { code: string; name: string }, entryNo: number): Promise<string[]> {
  await page.getByRole('tab', { name: '帳簿', exact: true }).click();
  await selectAccountingPeriod(page, periodName);
  await selectLedgerAccount(page, account);
  return ledgerRowCells(page, entryNo);
}

for (const viewport of CHECKOUT_VIEWPORTS) {
  test.describe(`FR-ADMIN-138 (${viewport.width}px)`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport);
    });

    test('FREQ-577-AC-03: 発送前に取り消したパンツが出荷の売上から引かれ、前受金が0になる（本物のroute。額は交換の設計の割り振りのまま）', async ({ page }) => {
      test.setTimeout(300_000);
      await withAccountingScenario('pre-shipment-refund', async (s) => {
        const period = await s.todayPeriod();
        // 20,000円と17,000円の2着の注文（支払いの仕訳つき）。2着のうち1着（17,000円）を発送前に取り消す。取り消した1着はパンツ
        const f = await s.seedRefundFlow(false);
        const total = 37_000;
        expect(await balanceOf(s, f.orderId, '2150')).toBe(total);
        const cancel = await s.material(() => seedPreShipmentCancel(s.db, f, { itemId: f.itemId, quantity: 1 }));
        expect(cancel.amount).toBe(17_000);
        const txn = await s.material(() => succeedRefund(s.db, cancel.refundId, { at: nowIso() }));
        await s.runPosting(200);

        // 発送前の返金の仕訳: 返金した日（今日）に「前受金／Stripe未収金」。前受金の残りは取り消した分だけ減る
        const refundEntry = await s.entryByKey(`pre_shipment_refund:${txn}`);
        expect(refundEntry).toMatchObject({ eventKind: 'pre_shipment_refund', entryDate: s.today, periodId: period.id });
        expect(await s.linesOf(refundEntry!.id)).toEqual([
          { account: '2150', debit: cancel.amount, credit: 0, orderId: f.orderId, subAccount: null },
          { account: '1160', debit: 0, credit: cancel.amount, orderId: f.orderId, subAccount: null },
        ]);
        expect(await balanceOf(s, f.orderId, '2150')).toBe(total - cancel.amount);

        // 残りの1着を発送して計上すると、出荷の売上は取り消した分を引いた額で、前受金は0になる
        await s.material(() => shipUnits(s.db, f.orderId, f.itemId, 1, f.actor));
        await s.runPosting(200);
        const shipment = await orderEntries(s, f.orderId, 'shipment_confirmed');
        expect(shipment.filter((line) => line.account === '4010').map((line) => line.credit)).toEqual([total - cancel.amount]);
        expect(shipment.every((line) => line.entry_date === s.today)).toBe(true);
        expect(await s.deferredBalance(f.orderId)).toBe(0);
        expect(await balanceOf(s, f.orderId, '4010')).toBe(total - cancel.amount);

        // 本物の journal route にも、発送前の返金の仕訳と出荷の仕訳が出る
        const journal = await s.journalBetween(period.id, s.today, s.today);
        expect(journal.entries.find((row) => row.dedupeKey === `pre_shipment_refund:${txn}`)).toMatchObject({ eventKind: 'pre_shipment_refund', entryDate: s.today });
        expect(journal.entries.filter((row) => row.lines.some((line) => line.orderId === f.orderId && line.accountCode === '4010')).length).toBe(1);

        // 画面: 帳簿の前受金の元帳に、発送前の返金（借方）が出る
        await s.openAccounting(page, '帳簿');
        const cells = await ledgerCells(page, period.name, { code: '2150', name: '前受金' }, refundEntry!.entryNo);
        expect(cells[5]).toBe(yen(cancel.amount));
        await expectNoHorizontalOverflow(page);
      }, { period: 'none' });
    });

    test('FREQ-579-AC-02: 失敗した返金は返金の未払いに立ち、振込で返すと消える', async ({ page }) => {
      test.setTimeout(300_000);
      await withAccountingScenario('refund-failed-bank-transfer', async (s) => {
        await s.todayPeriod();
        const f = await s.seedRefundFlow(false);
        const cancel = await s.material(() => seedPreShipmentCancel(s.db, f, { itemId: f.itemId, quantity: 1 }));
        // Stripe が返金の失敗を知らせた（引かれる前の失敗）。計上係を流すと、前受金を戻して返金の未払いが立つ
        await s.material(() => failRefund(s.db, cancel.refundId));
        await s.runPosting(200);
        const failed = await orderEntries(s, f.orderId, 'refund_failed');
        expect(shape(failed)).toEqual([['2150', 17_000, 0, null], ['2130', 0, 17_000, 'refund_owed_pre']]);
        expect(failed.every((line) => line.entry_date === s.today)).toBe(true);
        expect(await balanceOf(s, f.orderId, '2130', 'refund_owed_pre')).toBe(17_000);

        // 画面: 借りが残る返金に出る。振込で返した分を記録すると、借りの行は消える
        await s.openAccounting(page, '財務概要');
        const panel = page.getByRole('region', { name: '返金の借りと振込の記録', exact: true });
        const row = panel.getByRole('list', { name: '借りが残る返金の一覧' }).getByRole('listitem').filter({ hasText: orderNumberOf(f.orderId) });
        await showRow(page, row);
        await expect(row.first()).toContainText(`出荷前の分の借り ¥${yen(17_000)}`);
        await expectNoHorizontalOverflow(page);
        await row.first().getByRole('button', { name: '振込を記録する', exact: true }).click();
        const form = panel.getByRole('group', { name: '振込で返した分を記録する' });
        await form.getByLabel('額（円）', { exact: true }).fill('17000');
        await form.getByLabel('振込の日', { exact: true }).fill(s.today);
        await form.getByLabel('銀行の取引の番号', { exact: true }).fill(`E2E-${randomUUID().slice(0, 12)}`);
        await form.getByRole('button', { name: '振込を記録する', exact: true }).click();
        await expect(form.getByText('振込の記録を入れました。')).toBeVisible({ timeout: 60_000 });
        await expect(row).toHaveCount(0, { timeout: 30_000 });
        await expectNoHorizontalOverflow(page);

        // 返金の未払いは0になり、振込の仕訳（前受金を戻さない形で未払いを消す）が今日の日で入る
        expect(await balanceOf(s, f.orderId, '2130', 'refund_owed_pre')).toBe(0);
        const owedLines = (await s.db.query(
          `select to_char(e.entry_date, 'YYYY-MM-DD') as d, l.debit::int as debit from public.accounting_journal_entries e join public.accounting_journal_lines l on l.entry_id = e.id
            where l.order_id = $1 and l.account_code = '2130' and l.sub_account = 'refund_owed_pre' and l.debit > 0`, [f.orderId])).rows;
        expect(owedLines).toEqual([{ d: s.today, debit: 17_000 }]);
      }, { period: 'none' });
    });

    test('FREQ-579-AC-03: 取り消された返金は計上待ちに出て、「店が返金をやめた」を選ぶと仕訳が取り消される', async ({ page }) => {
      test.setTimeout(300_000);
      await withAccountingScenario('refund-canceled-abandoned', async (s) => {
        await s.todayPeriod();
        const f = await s.seedRefundFlow(false);
        const cancel = await s.material(() => seedPreShipmentCancel(s.db, f, { itemId: f.itemId, quantity: 1 }));
        const txn = await s.material(() => succeedRefund(s.db, cancel.refundId, { at: nowIso() }));
        await s.runPosting(200);
        const original = await s.entryByKey(`pre_shipment_refund:${txn}`);
        expect(original).not.toBeNull();
        expect(await balanceOf(s, f.orderId, '2150')).toBe(37_000 - 17_000);

        // Stripe が返金を取り消した（引かれた後に戻された）。区分を選ぶまで計上待ちに出て、仕訳は動かない
        await s.material(() => cancelRefund(s.db, cancel.refundId, { pulled: true, at: nowIso() }));
        await s.runPosting(200);
        const event = await s.db.query("select id::text as id from public.accounting_refund_events where refund_id = $1 and state = 'canceled'", [cancel.refundId]);
        expect(event.rows).toHaveLength(1);
        expect(await s.pendingOf('refund_abandoned', event.rows[0].id)).toMatchObject({ reason: 'refund_cancel_undecided', resolvedAt: null });
        expect(await s.reversalOf(original!.id)).toBeNull();

        await s.openAccounting(page, '計上待ち');
        const list = page.getByRole('list', { name: '計上待ちの一覧' });
        // 取り消しの区分待ちの行には注文へのリンクが無い。一覧は新しく見つけた物が先なので、自分の返金の行は先頭の区分待ち。取り違えは DB の状態で確かめる
        const row = list.getByRole('listitem').filter({ hasText: 'Stripe 側で取り消されました' }).filter({ has: page.getByRole('button', { name: '取り消しの区分を選ぶ', exact: true }) });
        await showRow(page, row);
        await expectNoHorizontalOverflow(page);
        await row.first().getByRole('button', { name: '取り消しの区分を選ぶ', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: '返金の取り消しの区分を選ぶ', exact: true });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByTestId('abandon-note')).toBeVisible({ timeout: 30_000 });
        await dialog.getByRole('radio', { name: '店が返金をやめた', exact: true }).check();
        await dialog.getByLabel('理由（必須）').fill('店が返金をやめた（E2E）');
        await expectNoHorizontalOverflow(page);
        await dialog.getByRole('button', { name: '区分を決める', exact: true }).click();
        await expect(page.getByText('取り消しの区分を決めました。')).toBeVisible({ timeout: 60_000 });
        const decided = await s.db.query("select state from public.accounting_refund_events where refund_id = $1 and state = 'abandoned'", [cancel.refundId]);
        expect(decided.rows).toHaveLength(1);

        // 区分を選ぶと、計上係が元の返金の仕訳を取り消し、前受金が元に戻る
        await s.runPosting(200);
        const reversal = await s.reversalOf(original!.id);
        expect(reversal).not.toBeNull();
        expect(reversal!.entryDate).toBe(s.today);
        expect(await balanceOf(s, f.orderId, '2150')).toBe(37_000);
        expect((await s.pendingOf('refund_abandoned', event.rows[0].id))?.resolvedAt).not.toBeNull();
        expect(await orderEntries(s, f.orderId, 'refund_failed')).toEqual([]);
      }, { period: 'none' });
    });

    test('FREQ-583-AC-01: 消費税用の返金の一覧に返金が出て、免税の売上の返金は対象外になる', async ({ page }) => {
      test.setTimeout(300_000);
      await withAccountingScenario('tax-refund-list', async (s) => {
        const period = await s.todayPeriod();
        // 今日を含む期間は免税のまま（免税の期間の売上の返金は対象外）
        const status = await s.db.query('select consumption_tax_status from public.accounting_periods where id = $1', [period.id]);
        expect(status.rows[0].consumption_tax_status).toBe('exempt');
        const o = await s.seedSlotOrder([[18_750], [11_250]]);
        const [shirt] = o.orderItemIds;
        await s.seedConfirmedSlip({ orders: [{ orderId: o.orderId, lines: [{ orderItemId: shirt, quantity: 1 }] }] });
        await s.runPosting(200);
        // シャツの出荷後の返金 2,000円（返送不要の値引き）を、今日成功させる
        const refundId = await s.material(() => seedCancelRefund(s.db, o.orderId, null, 2_000, [{ item: shirt, before: false, amount: 2_000 }]));
        await s.material(() => succeedRefund(s.db, refundId, { at: nowIso() }));
        await s.runPosting(200);
        const month = s.today.slice(0, 7);

        // 本物の route: 続きの目印を最後までたどって、自分の注文の行を探す
        type TaxRow = { orderId: string; amount: number; refundDate: string; originalSaleDate: string | null; exclusion: string; salePeriodStatus: string | null };
        let cursor = '';
        let mine: TaxRow[] = [];
        for (let page = 0; page < 50; page += 1) {
          const reply = await s.api(s.admin, `/api/admin/accounting/tax-refunds?from=${month}&to=${month}&limit=100${cursor}`);
          expect(reply.status, reply.text.slice(0, 200)).toBe(200);
          mine = mine.concat((reply.body.data.rows as TaxRow[]).filter((row) => row.orderId === o.orderId));
          if (!reply.body.data.nextAfterDate || !reply.body.data.nextAfterKey) break;
          cursor = `&afterDate=${reply.body.data.nextAfterDate}&afterKey=${encodeURIComponent(reply.body.data.nextAfterKey)}`;
        }
        expect(mine).toHaveLength(1);
        expect(mine[0]).toMatchObject({ amount: 2_000, refundDate: s.today, originalSaleDate: s.today, exclusion: 'exempt_sale_14_1_6', salePeriodStatus: 'exempt' });

        // 画面: 照合のタブの消費税用の返金で、今月を出す。免税の売上の返金は、対象外の理由つきで出る
        await s.openAccounting(page, '照合');
        const section = page.getByRole('region', { name: '消費税用の返金', exact: true });
        await section.getByLabel('期間の始まり', { exact: true }).fill(month);
        await section.getByLabel('期間の終わり', { exact: true }).fill(month);
        await section.getByRole('button', { name: '一覧を出す', exact: true }).click();
        const row = section.getByRole('table', { name: '消費税用の返金の一覧' }).getByRole('row').filter({ hasText: orderNumberOf(o.orderId) });
        await expect(section.getByRole('group', { name: '合計' })).toBeVisible({ timeout: 60_000 });
        await showRow(page, row);
        await expect(row.first()).toContainText(`¥${yen(2_000)}`);
        await expect(row.first()).toContainText('元の売上が免税の期間です');
        await expect(section.getByTestId('tax-refund-retention-note')).toContainText('7年間保存する');
        await expectNoHorizontalOverflow(page);
      }, { period: 'none' });
    });
  });
}
