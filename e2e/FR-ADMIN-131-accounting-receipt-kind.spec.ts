import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { CHECKOUT_VIEWPORTS, expectNoHorizontalOverflow } from './checkout-flow-helpers';
import { selectAccountingPeriod, withAccountingScenario } from './accounting-test-utils';

// FREQ-559-AC-03: 領収書の種類（電子・紙）。本物の route・本物の Storage（手元）・本物の画面。応答は作り物にしない。
// 証憑のファイルは手元の Storage に残る（db reset で消える）。取引は終わりに論理削除する。

const PDF = { name: 'e2e-receipt.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% e2e\n%%EOF\n') };
// 1x1 の PNG
const PNG = {
  name: 'e2e-paper.png',
  mimeType: 'image/png',
  buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'),
};

test.use({ trace: 'off', locale: 'ja-JP' });
for (const viewport of CHECKOUT_VIEWPORTS) {
  test.describe(`FR-ADMIN-131 (${viewport.width}px)`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport);
    });

    test('FREQ-559-AC-03: 領収書を電子で添付でき紙を選ぶと原本の確認が必須になる', async ({ page }) => {
      test.setTimeout(240_000);
      await withAccountingScenario('receipt-kind', async (s) => {
        const item = `E2E 領収書 ${randomUUID().slice(0, 8)}`;
        const id = await s.createExpense({ date: s.day(7, 7), amount: 1980, item });
        const receiptRows = async () => (await s.db.query(
          'select evidence_kind, paper_original_kept from public.admin_finance_receipts where entry_id = $1 order by id', [id])).rows;

        // route: 種類が無い・紙で原本の有無が無い・電子で原本の有無がある、は断る（非 ok の本文も最後まで読む）。何も保存しない
        for (const bad of [{}, { evidenceKind: 'paper' as const }, { evidenceKind: 'electronic' as const, paperOriginalKept: true }]) {
          const refused = await s.postReceipt(s.admin, id, bad);
          expect({ bad, status: refused.status, error: refused.body?.error }).toEqual({ bad, status: 400, error: 'Invalid evidenceKind' });
        }
        expect(await receiptRows()).toEqual([]);

        await s.openAccounting(page, '取引管理');
        await selectAccountingPeriod(page, s.period.name);
        await page.getByRole('button', { name: `${item}の証憑` }).click();
        const dropZone = page.getByLabel(`${item}に証憑を添付`);
        // 種類を選ぶまで添付できない
        await expect(page.getByText('種類を選ぶと添付できます。', { exact: true })).toBeVisible();
        await expect(dropZone).toBeDisabled();

        // 紙: 原本を残してあることを確かめるまで添付できない。確かめると添付でき、種類は紙・原本ありで保存される
        await page.getByLabel('紙あり（画像は写し）').check();
        await expect(page.getByText('紙の原本を残してあることを確かめると添付できます。', { exact: true })).toBeVisible();
        await expect(dropZone).toBeDisabled();
        await page.getByLabel('紙の原本を残してある').check();
        await expect(dropZone).toBeEnabled();
        await dropZone.setInputFiles(PNG);
        await expect(page.getByText(`${PNG.name} を添付しました。`)).toBeVisible();
        expect(await receiptRows()).toEqual([{ evidence_kind: 'paper', paper_original_kept: true }]);

        // 種類は取引ごとに選び直す（前の選択を持ち越さない）
        await expect(dropZone).toBeDisabled();

        // 電子: 種類を選ぶだけで添付でき、原本の有無は持たない
        await page.getByLabel('電子で受け取った（PDF など）').check();
        await expect(dropZone).toBeEnabled();
        await dropZone.setInputFiles(PDF);
        await expect(page.getByText(`${PDF.name} を添付しました。`)).toBeVisible();
        expect(await receiptRows()).toEqual([
          { evidence_kind: 'paper', paper_original_kept: true },
          { evidence_kind: 'electronic', paper_original_kept: null },
        ]);
        // 種類を確かめた証憑に「確かめてください」の促しは出ない
        await expect(page.getByText('種類を確かめてください', { exact: true })).toHaveCount(0);
        await expectNoHorizontalOverflow(page);
      });
    });

    test('FREQ-559-AC-03: 種類が未確認の領収書に促しが出る', async ({ page }) => {
      test.setTimeout(240_000);
      await withAccountingScenario('receipt-unconfirmed', async (s) => {
        const item = `E2E 未確認 ${randomUUID().slice(0, 8)}`;
        const id = await s.createExpense({ date: s.day(8, 8), amount: 2500, item });
        // 種類を持つ前（移行前）の証憑と同じ形: evidence_kind を入れずに足す（既定は unconfirmed）
        const legacyName = `legacy-${randomUUID().slice(0, 8)}.pdf`;
        await s.db.query(
          `insert into public.admin_finance_receipts (entry_id, storage_path, file_name, mime_type, file_size, uploaded_by)
           values ($1, $2, $3, 'application/pdf', 1024, $4::uuid)`,
          [id, `e2e-legacy/${id}/${randomUUID()}.pdf`, legacyName, s.admin.userId],
        );
        // 種類を選んで足した証憑（電子）。促しは未確認の1件にだけ付く
        const electronic = await s.postReceipt(s.admin, id, { evidenceKind: 'electronic' });
        expect(electronic.status, electronic.text).toBe(200);

        const reply = await s.api(s.admin, `/api/admin/kpi/cost-profit?periodId=${s.periodId}`);
        expect(reply.status).toBe(200);
        const entry = (reply.body.data.expenses as Array<{ id: number; receipts: Array<{ fileName: string; evidenceKind: string }> }>).find((row) => row.id === id);
        expect(entry?.receipts.map((receipt) => [receipt.fileName === legacyName, receipt.evidenceKind])).toEqual([[true, 'unconfirmed'], [false, 'electronic']]);

        await s.openAccounting(page, '取引管理');
        await selectAccountingPeriod(page, s.period.name);
        await page.getByRole('button', { name: `${item}の証憑` }).click();
        await expect(page.getByRole('button', { name: `${legacyName}を開く` })).toBeVisible();
        await expect(page.getByText('種類を確かめてください', { exact: true })).toHaveCount(1);
        await expectNoHorizontalOverflow(page);
      });
    });
  });
}
