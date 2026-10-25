/**
 * FR-ADMIN-119 発注書の取引書類（見積書・請求書の原本）の保存・訂正・差し替え・無効化・検索・閲覧と、途中で止まった保存の続き（グループ G-2）
 * 対応 FREQ: FREQ-530（AC-01・AC-02・AC-03）
 *
 * 画面 → 窓口の差し替え（e2e/purchasing-test-utils.ts）→ 手元の DB の関数で確かめる。原本の置き場（Storage）の部分だけは本物の手元の Storage を使う:
 * 署名つきの送り先の発行・読戻し・閲覧のリンクの発行は bridge が手元の鍵で行い、ブラウザは本物の署名つきの送り先へ PUT する
 * （本番ビルドの CSP を通ることは ① が確かめる）。鍵・署名つきの URL・保存先の鍵・ファイルの中身は出力しない。
 * 置き場に置いたファイルと追記専用の行は、製品が消す道を持たないので残る（試験ごとに新しい発注書で作り、干渉させない）。
 *
 * この spec が確かめない所（照合先）:
 * - 窓口の認可・CSRF・回数の制限・監査 → FR-ADMIN-123 の G-2 の節（本物の窓口の 401/403）と各 route の単体
 * - 置き場の検査の全場合（先頭のバイト・種類・大きさ・ハッシュの不一致）・予約の期限・同じ request_key の再送 → 単体 purchase-order-documents と DB 結合 group_g2_purchase_documents
 * - 7表が owner と service_role でも UPDATE・DELETE・TRUNCATE を断ること → DB 結合 group_g2_purchase_model（ここでは代表の1表の UPDATE・DELETE だけ）
 * - 閲覧の popup が PDF を表示するか保存するか（ブラウザの設定で変わる）。ここでは新しいタブが署名つきリンクへ向かい、リンクが原本を返すことまで
 */
import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { viewports } from './order-fulfillment-test-utils';
import {
  attachDocumentInDb,
  contentAlerts,
  createCatalogMaterial,
  createPurchaseOrderInDb,
  documentCountsOf,
  expectNoPageOverflow,
  pdfBytes,
  pngBytes,
  preparePurchasingPage,
  readPurchaseOrder,
  reservationObjectExists,
  sha256Of,
  withPurchasingScenario,
  type PurchasingContext,
} from './purchasing-test-utils';

test.describe.configure({ timeout: 150_000 });
// 原本を開く署名つきの URL（60秒。手元の置き場の物）が、通信の記録（trace）に残らないようにする
test.use({ trace: 'off' });

const tagOf = (): string => randomUUID().slice(0, 8);

async function newOrder(ctx: PurchasingContext): Promise<{ id: string; number: string }> {
  const material = await createCatalogMaterial(ctx.client);
  return createPurchaseOrderInDb(ctx, { lines: [{ variantId: material.variantId, quantity: 1 }] });
}

async function openDetail(page: Page, ctx: PurchasingContext, order: { id: string; number: string }): Promise<void> {
  await preparePurchasingPage(page, ctx);
  await page.goto(`/admin/purchase-orders/${order.id}`);
  await expect(page.getByRole('heading', { name: `発注書 ${order.number}`, level: 1, exact: true })).toBeVisible();
}

const notice = (page: Page, text: string): Locator => page.getByRole('status').filter({ hasText: text });
const docItem = (page: Page, fileName: string): Locator => page.getByTestId('purchase-order-document').filter({ hasText: fileName });
const pendingItems = (page: Page): Locator => page.getByTestId('purchase-order-pending-upload');

type Meta = { date: string; amount: string; counterparty: string };

/** 書類の追加・差し替え・続きから保存の入力欄に、取引日・金額・取引先を入れる */
async function fillMeta(dialog: Locator, meta: Meta): Promise<void> {
  await dialog.getByLabel('取引日', { exact: true }).fill(meta.date);
  await dialog.getByLabel('金額（円）', { exact: true }).fill(meta.amount);
  await dialog.getByLabel('取引先', { exact: true }).fill(meta.counterparty);
}

const pdfFile = (name: string, label: string) => ({ name, mimeType: 'application/pdf', buffer: pdfBytes(label) });

/** 検索の画面を開き、発注書番号で絞って検索する（他の試験の書類が混ざらないように、条件に発注書番号を入れる） */
async function search(page: Page, number: string, extra: { counterparty?: string; includeHistory?: boolean } = {}): Promise<void> {
  await page.getByLabel('発注書番号', { exact: true }).fill(number);
  await page.getByLabel('取引先', { exact: true }).fill(extra.counterparty ?? '');
  const history = page.getByLabel('訂正前の情報も探す', { exact: true });
  if (extra.includeHistory) await history.check();
  else await history.uncheck();
  await page.getByRole('button', { name: '検索', exact: true }).click();
}

// 画面を描かない（本物の窓口の HTTP と DB だけ）ので、画面幅ごとには繰り返さない（FR-ADMIN-123 の 401/403 の確かめと同じ）
test('削除・上書きの窓口が無い（DELETE・PUTは405）', async ({ playwright, baseURL }) => {
  // FREQ-530-AC-01。差し替えの無い request context（cookie なし）で本物の窓口へ送る。窓口の認可より前に、方法が無いことで断られる
  if (!baseURL) throw new Error('baseURL が無い（playwright.config.ts）');
  const order = randomUUID();
  const attachment = randomUUID();
  const targets: Array<{ path: string; methods: string[] }> = [
    { path: `/api/admin/purchase-orders/${order}/attachments`, methods: ['DELETE', 'PUT', 'PATCH', 'GET'] },
    { path: `/api/admin/purchase-orders/${order}/attachments/reservations`, methods: ['DELETE', 'PUT', 'PATCH', 'GET'] },
    { path: `/api/admin/purchase-orders/${order}/attachments/${attachment}/revisions`, methods: ['DELETE', 'PUT', 'PATCH', 'GET'] },
    { path: `/api/admin/purchase-orders/${order}/attachments/${attachment}/url`, methods: ['DELETE', 'PUT', 'PATCH', 'POST'] },
  ];
  const api = await playwright.request.newContext({ baseURL });
  try {
    for (const target of targets) {
      for (const method of target.methods) {
        const response = await api.fetch(target.path, { method, headers: { origin: new URL(baseURL).origin }, data: method === 'GET' ? undefined : {} });
        expect(response.status(), `${method} ${target.path.replace(order, '<id>').replace(attachment, '<id>')}`).toBe(405);
      }
    }
  } finally {
    await api.dispose();
  }

  // 追記専用: 保存した添付の行は、DB の持ち主でも UPDATE・DELETE できない（7表の全部は DB 結合が確かめる）
  await withPurchasingScenario(async (ctx) => {
    const created = await newOrder(ctx);
    const tag = tagOf();
    const stored = await attachDocumentInDb(ctx, {
      purchaseOrderId: created.id, fileName: `fixed-${tag}.pdf`, bytes: pdfBytes(tag), contentType: 'application/pdf',
      transactionDate: '2026-10-01', amountYen: 1, counterparty: `E2E固定-${tag}`,
    });
    for (const statement of [
      `update public.purchase_order_attachments set original_file_name = 'x.pdf' where id = $1::uuid`,
      'delete from public.purchase_order_attachments where id = $1::uuid',
    ]) {
      const error = await ctx.client.query(statement, [stored.attachmentId]).then(() => null, (failure: unknown) => failure as { message?: string });
      expect(error?.message).toBe('GROUP_G_HISTORY_IMMUTABLE');
    }
    expect((await readPurchaseOrder(ctx.client, ctx.actorId, created.id)).attachments).toHaveLength(1);
  });
});

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-119 purchase order attachments (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('見積書のPDFを添付し、取引日・金額・取引先で検索して原本を開ける', async ({ page }) => {
      // FREQ-530-AC-02, FREQ-530-AC-03
      await withPurchasingScenario(async (ctx) => {
        const order = await newOrder(ctx);
        const tag = tagOf();
        const fileName = `quote-${tag}.pdf`;
        const counterparty = `E2E見積先-${tag}`;
        await openDetail(page, ctx, order);
        const cspViolations: boolean[] = [];
        page.on('console', (message) => {
          if (/Content.Security.Policy/i.test(message.text())) cspViolations.push(true);
        });

        // 追加: 種類・取引日・金額・取引先を入れてファイルを選び、保存する。置き場への PUT は本物の署名つきの送り先へ向かい、成功する
        await page.getByRole('button', { name: '書類を追加', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: '書類を追加', exact: true });
        await expect(dialog).toBeVisible();
        await dialog.getByLabel('種類', { exact: true }).selectOption('quote');
        await fillMeta(dialog, { date: '2026-10-20', amount: '123456', counterparty });
        await dialog.getByLabel('ファイル', { exact: true }).setInputFiles(pdfFile(fileName, tag));
        const putResponse = page.waitForResponse((response) => response.request().method() === 'PUT' && response.url().includes('/storage/v1/object/upload/sign/'));
        await dialog.getByRole('button', { name: '保存する', exact: true }).click();
        expect((await putResponse).ok()).toBe(true);
        await expect(notice(page, '書類を保存しました。')).toBeVisible();
        expect(cspViolations).toEqual([]);

        const item = docItem(page, fileName);
        await expect(item).toHaveCount(1);
        await expect(item).toContainText('見積書');
        await expect(item).toContainText('取引日 2026/10/20');
        await expect(item).toContainText('¥123,456');
        await expect(item).toContainText(counterparty);
        await expect(pendingItems(page)).toHaveCount(0);
        await expectNoPageOverflow(page);

        // 検索: 取引日・金額の範囲と取引先（と、他の書類が混ざらないための発注書番号）で見つかる
        await page.goto('/admin/purchase-orders/documents');
        await expect(page.getByRole('heading', { name: '取引書類の検索', level: 1, exact: true })).toBeVisible();
        await page.getByLabel('取引日（から）', { exact: true }).fill('2026-10-20');
        await page.getByLabel('取引日（まで）', { exact: true }).fill('2026-10-20');
        await page.getByLabel('金額（円）（から）', { exact: true }).fill('123000');
        await page.getByLabel('金額（円）（まで）', { exact: true }).fill('124000');
        await page.getByLabel('種類', { exact: true }).selectOption('quote');
        await search(page, order.number, { counterparty });
        const rows = page.getByTestId('purchase-order-document-row');
        await expect(rows).toHaveCount(1);
        await expect(rows.first()).toContainText(order.number);
        await expect(rows.first()).toContainText(fileName);
        await expect(rows.first()).toContainText('123,456');
        await expect(rows.first()).toContainText('有効');
        await expectNoPageOverflow(page);

        // 範囲の外の金額では見つからない
        await page.getByLabel('金額（円）（から）', { exact: true }).fill('124001');
        await page.getByLabel('金額（円）（まで）', { exact: true }).fill('');
        await page.getByRole('button', { name: '検索', exact: true }).click();
        await expect(page.getByText('該当する書類はありません。', { exact: true })).toBeVisible();
        await page.getByLabel('金額（円）（から）', { exact: true }).fill('');
        await page.getByRole('button', { name: '検索', exact: true }).click();
        await expect(rows).toHaveCount(1);

        // 印刷: 結果の表のスクロール領域は高さの上限もスクロールも外れ、表を切る（clip・scroll する）祖先が無く、条件欄と「原本」の列は紙に出ない。
        // 印刷の頁は紙の幅（A4 縦 = 96dpi で 794px）で組まれる。emulateMedia だけでは画面の幅（390px など）のままなので、紙の幅に合わせて測る。
        // 表の自然な幅は紙の幅の内側の枠より少し広い（794px の頁で 753px 対 枠 696px）が、枠も祖先も overflow: visible なので表は切られず、
        // 印刷の機能（Chrome の縮小）が頁に収める。画面の幅（390px など）のままの「頁の横のはみ出し」は紙の頁では起きないので、判定に使わない
        const screenSize = page.viewportSize();
        await page.setViewportSize({ width: 794, height: 1123 });
        await page.emulateMedia({ media: 'print' });
        const region = page.getByRole('region', { name: '検索結果', exact: true });
        const printed = await region.evaluate((element) => {
          const style = getComputedStyle(element);
          const clippingAncestors: string[] = [];
          for (let node: Element | null = element; node; node = node.parentElement) {
            const { overflowX, overflowY } = getComputedStyle(node);
            if ([overflowX, overflowY].some((value) => value !== 'visible')) clippingAncestors.push(node.tagName);
          }
          return {
            maxHeight: style.maxHeight, overflowX: style.overflowX, overflowY: style.overflowY,
            clippingAncestors,
            verticallyClipped: element.scrollHeight > element.clientHeight + 1,
          };
        });
        expect(printed).toEqual({ maxHeight: 'none', overflowX: 'visible', overflowY: 'visible', clippingAncestors: [], verticallyClipped: false });
        await expect(page.getByRole('columnheader', { name: '原本', exact: true })).toBeHidden();
        await expect(page.getByRole('button', { name: '検索', exact: true })).toBeHidden();
        await page.emulateMedia({ media: 'screen' });
        if (screenSize) await page.setViewportSize(screenSize);

        // 原本を見る: 新しいタブが署名つきのリンク（60秒）へ向かい、そのリンクが原本を返す
        const signed: string[] = [];
        page.context().on('request', (request) => {
          if (request.url().includes('/storage/v1/object/sign/')) signed.push(request.url());
        });
        // 原本は window.open(…, 'noopener,noreferrer') で開く。noopener の新しいタブは頁の popup の事象に出ないので、context の page の事象で受ける。
        // 表示用の PDF を画面に描けない headless の Chromium では、新しいタブの最初の移動が保存（download）になり、その事象は新しいタブでなく開いた頁に出る
        const popupPromise = page.context().waitForEvent('page');
        const downloadPromise = page.waitForEvent('download', { timeout: 20_000 }).then(() => 'download' as const);
        await rows.first().getByRole('button', { name: '原本を見る', exact: true }).click();
        const popup = await popupPromise;
        // どちらか一方が起きればよい（Promise.any: 先に失敗した方が結果を決めない）。どちらも起きなければ AggregateError
        const opened = await Promise.any([
          downloadPromise,
          popup.waitForURL(/\/storage\/v1\/object\/sign\//, { timeout: 20_000 }).then(() => 'loaded' as const),
        ]).catch(() => 'none' as const);
        expect(opened === 'download' || opened === 'loaded').toBe(true);
        // そのリンクが原本を返す。リンクは Playwright の手順の題・報告・trace に出ないよう、Node の fetch で読む（URL は出力しない）
        expect(signed.length).toBeGreaterThan(0);
        const original = await fetch(signed[0]);
        expect(original.status).toBe(200);
        // 中身は、アップロードしたファイルと同じ（先頭の印だけでなく SHA-256 で比べる）
        const originalBytes = Buffer.from(await original.arrayBuffer());
        expect(originalBytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
        expect(sha256Of(originalBytes)).toBe(sha256Of(pdfBytes(tag)));
        await popup.close();
        // 頁自身の alert が無い（Next の経路の読み上げ #__next-route-announcer__ は数えない）
        await expect(contentAlerts(page)).toHaveCount(0);
      });
    });

    test('検索情報の訂正は履歴に追記され、訂正前の情報でも辿れる', async ({ page }) => {
      // FREQ-530-AC-02, FREQ-530-AC-03
      await withPurchasingScenario(async (ctx) => {
        const order = await newOrder(ctx);
        const tag = tagOf();
        const fileName = `invoice-${tag}.pdf`;
        const oldParty = `旧取引先-${tag}`;
        const newParty = `新取引先-${tag}`;
        await attachDocumentInDb(ctx, {
          purchaseOrderId: order.id, kind: 'invoice', fileName, bytes: pdfBytes(tag), contentType: 'application/pdf',
          transactionDate: '2026-10-10', amountYen: 5000, counterparty: oldParty,
        });
        await openDetail(page, ctx, order);

        const item = docItem(page, fileName);
        await expect(item).toContainText(oldParty);
        await item.getByRole('button', { name: '情報を訂正', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: '書類の情報を訂正', exact: true });
        await expect(dialog).toBeVisible();
        // 現在の情報が初期値。理由が空だと送れない（文が出て、入力は保たれる）
        await expect(dialog.getByLabel('取引先', { exact: true })).toHaveValue(oldParty);
        await dialog.getByLabel('金額（円）', { exact: true }).fill('7000');
        await dialog.getByLabel('取引先', { exact: true }).fill(newParty);
        await dialog.getByRole('button', { name: '訂正する', exact: true }).click();
        await expect(dialog.getByRole('alert')).toHaveText('理由を入力してください。');
        await expect(dialog.getByLabel('取引先', { exact: true })).toHaveValue(newParty);
        await dialog.getByLabel('理由', { exact: true }).fill('請求の内容が変わった');
        await dialog.getByRole('button', { name: '訂正する', exact: true }).focus();
        await page.keyboard.press('Enter');

        await expect(notice(page, '書類の情報を訂正しました。')).toBeVisible();
        await expect(item).toContainText(newParty);
        await expect(item).toContainText('¥7,000');
        await expect(item).toContainText('理由 請求の内容が変わった');
        // 履歴: 版が追記され（前の版は残る）、最新の版が現在の情報
        const saved = await readPurchaseOrder(ctx.client, ctx.actorId, order.id);
        expect(saved.attachments).toHaveLength(1);
        expect(saved.attachments[0]).toMatchObject({ revisionCount: 2, current: { revisionNo: 2, amountYen: 7000, counterparty: newParty, voided: false } });
        await expectNoPageOverflow(page);

        // 検索: 訂正前の取引先では、既定では見つからず、「訂正前の情報も探す」を付けると「訂正前」として見つかる。新しい取引先は「有効」
        await page.goto('/admin/purchase-orders/documents');
        await expect(page.getByRole('heading', { name: '取引書類の検索', level: 1, exact: true })).toBeVisible();
        await search(page, order.number, { counterparty: oldParty });
        await expect(page.getByText('該当する書類はありません。', { exact: true })).toBeVisible();
        await search(page, order.number, { counterparty: oldParty, includeHistory: true });
        const rows = page.getByTestId('purchase-order-document-row');
        await expect(rows).toHaveCount(1);
        await expect(rows.first()).toContainText('訂正前');
        await expect(rows.first()).toContainText(oldParty);
        await search(page, order.number, { counterparty: newParty });
        await expect(rows).toHaveCount(1);
        await expect(rows.first()).toContainText('有効');
        await expectNoPageOverflow(page);
      });
    });

    test('差し替えは新しい添付になり旧の添付を残す。誤添付は理由付きで無効にする', async ({ page }) => {
      // FREQ-530-AC-02
      await withPurchasingScenario(async (ctx) => {
        const order = await newOrder(ctx);
        const tag = tagOf();
        const oldName = `wrong-${tag}.pdf`;
        const newName = `right-${tag}.png`;
        const counterparty = `E2E仕入先-${tag}`;
        const original = await attachDocumentInDb(ctx, {
          purchaseOrderId: order.id, kind: 'invoice', fileName: oldName, bytes: pdfBytes(tag), contentType: 'application/pdf',
          transactionDate: '2026-10-12', amountYen: 9000, counterparty,
        });
        await openDetail(page, ctx, order);

        // 差し替え: 元の種類・情報が初期値。新しいファイルは新しい添付になり、元の添付は残る
        await docItem(page, oldName).getByRole('button', { name: '差し替える', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: '書類を差し替える', exact: true });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByLabel('種類', { exact: true })).toHaveValue('invoice');
        await expect(dialog.getByLabel('取引先', { exact: true })).toHaveValue(counterparty);
        await dialog.getByLabel('ファイル', { exact: true }).setInputFiles({ name: newName, mimeType: 'image/png', buffer: pngBytes() });
        await dialog.getByRole('button', { name: '保存する', exact: true }).click();
        await expect(notice(page, '書類を保存しました。')).toBeVisible();
        await expect(docItem(page, newName)).toHaveCount(1);
        await expect(docItem(page, oldName)).toHaveCount(1);
        const saved = await readPurchaseOrder(ctx.client, ctx.actorId, order.id);
        expect(saved.attachments).toHaveLength(2);
        const replacement = saved.attachments.find((attachment) => attachment.fileName === newName);
        expect(replacement?.current.replacesAttachmentId).toBe(original.attachmentId);

        // 誤添付を無効にする: 理由が要る。無効にしても行と履歴は残り、「無効」の印が付く
        await docItem(page, oldName).getByRole('button', { name: '無効にする', exact: true }).click();
        const voidDialog = page.getByRole('dialog', { name: '書類を無効にする', exact: true });
        await expect(voidDialog).toBeVisible();
        await voidDialog.getByRole('button', { name: '無効にする', exact: true }).click();
        await expect(voidDialog.getByRole('alert')).toHaveText('理由を入力してください。');
        await voidDialog.getByLabel('理由', { exact: true }).fill('違う発注書の書類を付けた');
        await voidDialog.getByRole('button', { name: '無効にする', exact: true }).click();
        await expect(notice(page, '書類を無効にしました。')).toBeVisible();
        // 「無効」の印は文字がちょうど「無効」の要素（ボタンの「無効にする」とは別）
        await expect(docItem(page, oldName).getByText('無効', { exact: true })).toHaveCount(1);
        await expect(docItem(page, oldName)).toContainText('理由 違う発注書の書類を付けた');
        await expect(docItem(page, oldName).getByRole('button', { name: '無効にする', exact: true })).toHaveCount(0);
        await expect(docItem(page, newName).getByText('無効', { exact: true })).toHaveCount(0);
        await expect(docItem(page, newName).getByRole('button', { name: '無効にする', exact: true })).toHaveCount(1);
        expect((await readPurchaseOrder(ctx.client, ctx.actorId, order.id)).attachments).toHaveLength(2);
        await expectNoPageOverflow(page);
      });
    });

    test('置き場に保存済みでDB未確定の予約は添付済みと見せず、ページを読み直しても「保存が終わっていないファイル」に残り、取引日・金額・取引先を入れ直すだけで続きを保存できる', async ({ page }) => {
      // FREQ-530-AC-02
      await withPurchasingScenario(async (ctx) => {
        const order = await newOrder(ctx);
        const tag = tagOf();
        const fileName = `stuck-${tag}.pdf`;
        const meta: Meta = { date: '2026-10-15', amount: '40000', counterparty: `E2E停止先-${tag}` };
        await openDetail(page, ctx, order);
        // 確定の窓口だけ、最初の1回は応答を失わせる（置き場への保存までは成功する）。bridge より後に登録して、2回目からは bridge へ渡す
        let failed = false;
        await page.route((url) => /\/attachments$/.test(url.pathname), async (route: Route) => {
          if (route.request().method() === 'POST' && !failed) {
            failed = true;
            await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'unavailable' }) });
            return;
          }
          await route.fallback();
        });

        await page.getByRole('button', { name: '書類を追加', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: '書類を追加', exact: true });
        await fillMeta(dialog, meta);
        await dialog.getByLabel('ファイル', { exact: true }).setInputFiles(pdfFile(fileName, tag));
        await dialog.getByRole('button', { name: '保存する', exact: true }).click();

        // 添付済みとは見せない: 「保存が終わっていないファイル」にだけ出る。置き場には保存済み
        await expect(page.getByRole('alert').filter({ hasText: '書類の保存が終わっていません。内容を確認して、続きから保存してください。' })).toBeVisible();
        await expect(page.getByRole('heading', { name: '保存が終わっていないファイル', level: 3, exact: true })).toBeVisible();
        await expect(pendingItems(page)).toHaveCount(1);
        await expect(pendingItems(page)).toContainText(fileName);
        await expect(page.getByText('取引書類はまだありません。', { exact: true })).toBeVisible();
        expect(await documentCountsOf(ctx.client, order.id)).toEqual({ reservations: 1, attachments: 0 });
        const reservationId = (await ctx.client.query('select id from public.purchase_order_attachment_reservations where purchase_order_id = $1', [order.id])).rows[0].id as string;
        expect(await reservationObjectExists(ctx.client, reservationId)).toBe(true);

        // 読み直しても残る
        await page.reload();
        await expect(page.getByRole('heading', { name: `発注書 ${order.number}`, level: 1, exact: true })).toBeVisible();
        await expect(pendingItems(page)).toHaveCount(1);
        await expect(pendingItems(page)).toContainText(fileName);
        await expect(page.getByText('取引書類はまだありません。', { exact: true })).toBeVisible();

        // 続きから保存: ファイルは選び直さず、取引日・金額・取引先を入れ直すだけで確定できる（読み直した後なので、ハッシュはサーバーが計算する）
        await pendingItems(page).getByRole('button', { name: '続きから保存', exact: true }).click();
        const resume = page.getByRole('dialog', { name: '続きから保存', exact: true });
        await expect(resume).toBeVisible();
        await expect(resume.getByLabel('ファイル', { exact: true })).toHaveCount(0);
        await expect(resume.getByLabel('取引先', { exact: true })).toHaveValue('');
        await fillMeta(resume, meta);
        await resume.getByRole('button', { name: '保存する', exact: true }).click();
        await expect(notice(page, '書類を保存しました。')).toBeVisible();
        await expect(docItem(page, fileName)).toHaveCount(1);
        await expect(pendingItems(page)).toHaveCount(0);
        const saved = await readPurchaseOrder(ctx.client, ctx.actorId, order.id);
        expect(saved.attachments).toHaveLength(1);
        expect(saved.attachments[0]).toMatchObject({ fileName, sha256Source: 'server', current: { amountYen: 40000, counterparty: meta.counterparty } });
        expect(saved.pendingUploads).toHaveLength(0);
        await expectNoPageOverflow(page);
      });
    });

    test('20 MiBを超える・PDF/JPEG/PNG以外のファイルは断られる', async ({ page }) => {
      // FREQ-530-AC-02
      await withPurchasingScenario(async (ctx) => {
        const order = await newOrder(ctx);
        const tag = tagOf();
        const meta: Meta = { date: '2026-10-18', amount: '1500', counterparty: `E2E断り-${tag}` };
        await openDetail(page, ctx, order);
        const reservationRequests: string[] = [];
        page.on('request', (request) => {
          if (request.method() === 'POST' && request.url().endsWith('/attachments/reservations')) reservationRequests.push(request.url());
        });

        await page.getByRole('button', { name: '書類を追加', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: '書類を追加', exact: true });
        await fillMeta(dialog, meta);
        const fileField = dialog.getByLabel('ファイル', { exact: true });
        const submit = dialog.getByRole('button', { name: '保存する', exact: true });
        const alert = dialog.getByRole('alert');

        // 許す種類（PDF・JPEG・PNG）以外
        await fileField.setInputFiles({ name: `memo-${tag}.txt`, mimeType: 'text/plain', buffer: Buffer.from('memo') });
        await submit.click();
        await expect(alert).toHaveText('PDF・JPEG・PNG のファイルを選んでください。');
        // 名前は PDF でも、中身が PDF でない
        await fileField.setInputFiles({ name: `fake-${tag}.pdf`, mimeType: 'application/pdf', buffer: Buffer.from('not a pdf at all') });
        await submit.click();
        await expect(alert).toHaveText('PDF・JPEG・PNG のファイルを選んでください。');
        // 20 MiB を超える（20 MiB = 20971520 バイト）
        const big = Buffer.alloc(20 * 1024 * 1024 + 1, 0x20);
        big.write('%PDF-1.4\n', 0, 'latin1');
        await fileField.setInputFiles({ name: `big-${tag}.pdf`, mimeType: 'application/pdf', buffer: big });
        await submit.click();
        await expect(alert).toHaveText('ファイルは 20 MiB までです。');

        // 断られても入力は保たれ、予約も作られない
        await expect(dialog.getByLabel('取引先', { exact: true })).toHaveValue(meta.counterparty);
        await expect(dialog.getByLabel('金額（円）', { exact: true })).toHaveValue(meta.amount);
        expect(reservationRequests).toHaveLength(0);
        expect(await documentCountsOf(ctx.client, order.id)).toEqual({ reservations: 0, attachments: 0 });
        await expectNoPageOverflow(page);
      });
    });

    test('置き場にまだ無い予約は、ファイルを選び直して続きを保存できる', async ({ page }) => {
      // FREQ-530-AC-02
      await withPurchasingScenario(async (ctx) => {
        const order = await newOrder(ctx);
        const tag = tagOf();
        const fileName = `unsent-${tag}.pdf`;
        const meta: Meta = { date: '2026-10-16', amount: '2200', counterparty: `E2E未送信-${tag}` };
        await openDetail(page, ctx, order);
        // 置き場への PUT を失敗させる（予約は取れるが、ファイルは置き場に届かない）
        const blockPut = async (route: Route): Promise<void> => { await route.abort('failed'); };
        await page.route('**/storage/v1/object/upload/sign/**', blockPut);

        await page.getByRole('button', { name: '書類を追加', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: '書類を追加', exact: true });
        await fillMeta(dialog, meta);
        await dialog.getByLabel('ファイル', { exact: true }).setInputFiles(pdfFile(fileName, tag));
        await dialog.getByRole('button', { name: '保存する', exact: true }).click();
        await expect(page.getByRole('alert').filter({ hasText: 'ファイルを送れませんでした。続きから保存してください。' })).toBeVisible();
        await expect(pendingItems(page)).toHaveCount(1);
        expect(await documentCountsOf(ctx.client, order.id)).toEqual({ reservations: 1, attachments: 0 });
        const reservationId = (await ctx.client.query('select id from public.purchase_order_attachment_reservations where purchase_order_id = $1', [order.id])).rows[0].id as string;
        expect(await reservationObjectExists(ctx.client, reservationId)).toBe(false);

        // 読み直すと手元のファイルは無い。続きから保存はファイルの選び直しを求め、選び直せば保存できる（置き場への PUT の失敗は解く）
        await page.unroute('**/storage/v1/object/upload/sign/**', blockPut);
        await page.reload();
        await expect(page.getByRole('heading', { name: `発注書 ${order.number}`, level: 1, exact: true })).toBeVisible();
        await pendingItems(page).getByRole('button', { name: '続きから保存', exact: true }).click();
        const resume = page.getByRole('dialog', { name: '続きから保存', exact: true });
        await expect(resume).toBeVisible();
        await fillMeta(resume, meta);
        await resume.getByRole('button', { name: '保存する', exact: true }).click();
        await expect(resume.getByRole('alert')).toHaveText('ファイルを選び直してください。');
        const fileField = resume.getByLabel('ファイル', { exact: true });
        await expect(fileField).toBeVisible();
        await expect(resume.getByLabel('取引先', { exact: true })).toHaveValue(meta.counterparty);
        await fileField.setInputFiles(pdfFile(fileName, tag));
        await resume.getByRole('button', { name: '保存する', exact: true }).click();

        await expect(notice(page, '書類を保存しました。')).toBeVisible();
        await expect(docItem(page, fileName)).toHaveCount(1);
        await expect(pendingItems(page)).toHaveCount(0);
        expect(await reservationObjectExists(ctx.client, reservationId)).toBe(true);
        const saved = await readPurchaseOrder(ctx.client, ctx.actorId, order.id);
        expect(saved.attachments[0]).toMatchObject({ fileName, sha256Source: 'browser' });
        await expectNoPageOverflow(page);
      });
    });
  });
}
