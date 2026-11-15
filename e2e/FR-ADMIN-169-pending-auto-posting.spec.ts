import { expect, test } from '@playwright/test';
import { succeedRefund } from '../tests/integration/db/helpers/accounting-returns-fixtures';
import {
  postConfirmed,
  postSales,
  postWithdrawal,
  seedAnotherReturn,
  seedArrival,
  seedAutoOrder,
  seedLost,
  seedRefundInFlight,
  seedWithdrawn,
  seedZeroClose,
  setCreatedOn,
} from '../tests/integration/db/helpers/accounting-pending-auto-fixtures';
import { ledgerRowCells, selectAccountingPeriod, selectLedgerAccount, withAccountingScenario } from './accounting-test-utils';
import { CHECKOUT_VIEWPORTS, expectNoHorizontalOverflow } from './checkout-flow-helpers';

// FREQ-643（計画3 S27）: カード会社に負けた後の返品の0円の終わりが、計上係で自動で入る流れを、本物の route・本物の画面・手元の Supabase で確かめる。
// 材料（注文・返品・取り消し・返金・Stripe の残高の取引）は手元の DB へ直に入れる。Stripe は呼ばない。入れた stripe_* の行は表示の証拠で、実 Stripe の証拠ではない。
// 切り替えの日（db reset の日）より前の出来事は before_cutover になるので、E2E は今日の日付だけを使う。仕訳は消せないので db reset してから流す。
// 場面（円）: 注文 20,000（品 A・B 各 10,000）。返品 A・B が届く。引かれた額 5,000 で負け（C: pay=5,000、2130 は 15,000）。
// 返品 B の返金 10,000 が requested（負けた日以前に作った）。返品 A を0円で終える（c=10,000）。
// A の決定は dispute_refund_overlap で待ち、返金が成功して成功の仕訳が入ると、P=5,000 で借 2130 5,000／貸 4020 5,000 が入る。
// 「もう一度計上する」は2回: 1回目で返金の計上係が成功を入れ、2回目で返品の計上係が A の決定を入れる（DB で確かめた回数）。

test.use({ trace: 'off', locale: 'ja-JP' });
// 仕訳・計上待ちは全体で共有する状態なので、このファイルの中は1つずつ流す（他のファイルとは並列）。
test.describe.configure({ mode: 'default' });

/** dispute_refund_overlap の文の頭（画面の文は pending-view の REASON_TEXT） */
const OVERLAP_TEXT = 'カード会社からの支払いの取り消しがある注文に、終わっていない返金か、成功したのに仕訳がまだ入っていない返金があります。二重に費用にしないため止めています。';
const CLOSE_KIND = '返品の額の決定';
/** 日本時間の0時まで6分（360秒）を切っている（1本の試験は最長300秒で、今日の日付と期間を最初に読むので、0時をまたぐとずれる。FR-ADMIN-137 と同じ） */
const nearJstMidnight = () => ((Date.now() + 9 * 3_600_000) % 86_400_000) > 86_400_000 - 360_000;

for (const viewport of CHECKOUT_VIEWPORTS) {
  test.describe(`FR-ADMIN-169 (${viewport.width}px)`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport);
    });

    test('FREQ-643-AC-13: 負けた後の0円の終わりは返金の成功を待って計上待ちに出て、自動で入り、仕訳帳に注文つきで出る', async ({ page }) => {
      test.skip(nearJstMidnight(), '日本時間の0時の直前は、日付と期間が入れ替わるので流さない');
      test.setTimeout(300_000);
      await withAccountingScenario('pending-auto-posting', async (s) => {
        const period = await s.todayPeriod();
        const today = s.today;
        const now = new Date().toISOString();

        // 場面を作る（G の鍵の中。返品の到着は計上係で仕訳にする）
        const scene = await s.material(async () => {
          const a = await seedAutoOrder(s.db, [10_000, 10_000], now);
          const b = await seedAnotherReturn(s.db, a, 2);
          await seedArrival(s.db, a, 10_000, 0, today);
          await seedArrival(s.db, b, 10_000, 0, today);
          await s.runPosting(200);
          await postSales(s.db, a.orderId, 20_000, today);
          const w = await seedWithdrawn(s.db, a.orderId, 5_000, now);
          await seedLost(s.db, w.disputeId, now);
          await postWithdrawal(s.db, w.disputeId, w.txnId, 5_000, today);
          await postConfirmed(s.db, a.orderId, w.disputeId, today, { pay: 5_000 });
          const refund = await seedRefundInFlight(s.db, b, 10_000, ['requested'], { decided: 10_000, covers: 10_000, on: today });
          await setCreatedOn(s.db, refund.refundId, today);
          const closeA = await seedZeroClose(s.db, a, 10_000, 0, today);
          return { orderId: a.orderId, refundId: refund.refundId, closeFactId: closeA.factId };
        });
        const decisionEntry = async () => (await s.db.query(
          "select id, entry_no from public.accounting_journal_entries where dedupe_key = private.accounting_event_key('return_amount_decided', ARRAY[$1::text])",
          [scene.closeFactId],
        )).rows[0] as { id: string; entry_no: string } | undefined;

        // 返金が途中のうちは A の決定は入らず、dispute_refund_overlap で待つ
        await s.runPosting(200);
        expect(await s.pendingOf('return_amount_decided', scene.closeFactId)).toMatchObject({ reason: 'dispute_refund_overlap', detail: { why: 'refund' }, resolvedAt: null });
        expect(await decisionEntry()).toBeUndefined();

        // 画面: 計上待ちの一覧に、設計の文で出る。ボタンは無く、閉じられない旨が出る。
        // この理由の行には注文のリンクも名前も出ないので、FR-ADMIN-132 と同じ形で、画面を開き直すたびに「画面の行の数」を同じ瞬間の
        // 計上待ちの route（画面と同じ問い合わせ）の1ページ目の該当の数と比べ、この試験の1行は route に元の記録の番号で名指しして出る・消えるを確かめる。
        const rows = page.getByRole('list', { name: '計上待ちの一覧' }).getByRole('listitem')
          .filter({ hasText: CLOSE_KIND })
          .filter({ hasText: OVERLAP_TEXT });
        const firstPage = async () => {
          const reply = await s.api(s.admin, '/api/admin/accounting/pending-events?includeResolved=false&limit=50');
          expect(reply.status, reply.text.slice(0, 200)).toBe(200);
          return (reply.body.data.events as Array<{ sourceId: string; eventKind: string; reason: string }>)
            .filter((event) => event.eventKind === 'return_amount_decided' && event.reason === 'dispute_refund_overlap');
        };
        const screenMatchesRoute = async () => {
          let matched: Awaited<ReturnType<typeof firstPage>> = [];
          await expect
            .poll(async () => {
              await s.openAccounting(page, '計上待ち');
              await expect(page.getByText(/^未解決 \d+件$/)).toBeVisible({ timeout: 30_000 });
              const fromRoute = await firstPage();
              const onScreen = await rows.count();
              matched = fromRoute;
              return onScreen === fromRoute.length;
            }, { timeout: 90_000, intervals: [500, 1_000, 2_000] })
            .toBe(true);
          return matched;
        };
        const open = await screenMatchesRoute();
        expect(open.filter((event) => event.sourceId === scene.closeFactId)).toHaveLength(1);
        await expect(rows.first()).toContainText('仕訳が入るまで閉じられません');
        await expect(rows.getByRole('button')).toHaveCount(0);
        await expectNoHorizontalOverflow(page);

        // 返金が成功する。「もう一度計上する」を2回押す（1回目で返金の成功の仕訳、2回目で A の決定）
        await s.material(() => succeedRefund(s.db, scene.refundId, { at: new Date().toISOString() }));
        const run = page.getByRole('button', { name: 'もう一度計上する', exact: true });
        for (let click = 0; click < 2; click += 1) {
          await run.click();
          await expect(page.getByText(/件を計上しました/)).toBeVisible({ timeout: 90_000 });
          await expect(run).toBeEnabled();
        }
        // 計上係は1回に、止まっている返品の行を止め直した日の古い順に10件しか見直さない（設計どおり）。ほかの試験が止めた行が多い時は、
        // 回数を行の数から決めた上限（切り上げ(n/10)+1）まで、同じ本物の route で足す。書き込みは600秒に30回までなので、上限が28回を超えるなら流さず分かる文で落とす。
        const openReturnRows = Number((await s.db.query(
          `select count(*)::int as n from public.accounting_pending_events
            where resolved_at is null and event_kind in ('return_arrived', 'return_amount_decided', 'return_arrival_redated')`,
        )).rows[0].n);
        const maxReruns = Math.ceil(openReturnRows / 10) + 1;
        if (maxReruns > 28) throw new Error(`返品の止まっている行が ${openReturnRows} 件あり、足す回数の上限 ${maxReruns} が書き込みの制限（600秒に30回）に近い。db reset してから流す`);
        let reruns = 0;
        while ((await decisionEntry()) === undefined && reruns < maxReruns) {
          const rerun = await s.api(s.admin, '/api/admin/accounting/posting/run', 'POST', {});
          expect(rerun.status, `posting/run の ${reruns + 1} 回目の足し（上限 ${maxReruns}）: ${rerun.text.slice(0, 200)}`).toBe(200);
          reruns += 1;
        }
        const entry = await decisionEntry();
        expect(entry, `A の決定の仕訳が、ボタン2回と足し ${reruns} 回（止まっている返品の行 ${openReturnRows} 件）で入らない`).toBeDefined();
        // 2回で足りること（足しが要らないこと）は DB の試験が確かめる。ここは足しの回数に上限があることだけを見る
        expect((await s.pendingOf('return_amount_decided', scene.closeFactId))?.resolvedAt).not.toBeNull();
        const entryLines = await s.linesOf(entry!.id);
        expect(entryLines.length).toBeGreaterThanOrEqual(2);
        expect(entryLines.every((line) => line.orderId === scene.orderId)).toBe(true);

        // 画面: 一覧から消える（route の1ページ目にもこの1行が無い）
        const gone = await screenMatchesRoute();
        expect(gone.filter((event) => event.sourceId === scene.closeFactId)).toHaveLength(0);
        await expectNoHorizontalOverflow(page);

        // 画面: 仕訳帳（4020 の元帳）に、注文つきの自動の仕訳が出る
        await page.getByRole('tab', { name: '帳簿', exact: true }).click();
        await selectAccountingPeriod(page, period.name);
        await selectLedgerAccount(page, { code: '4020', name: '売上値引・返品' });
        const cells = await ledgerRowCells(page, Number(entry!.entry_no));
        expect(cells.join(' ')).toContain('額の決定');
        await expectNoHorizontalOverflow(page);
      }, { period: 'none' });
    });
  });
}
