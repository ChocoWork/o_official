import { randomUUID } from 'node:crypto';
import { addVariant, createShippedOrder, returnLabelOf } from './return-test-utils';
import { mailBodies } from './order-email-test-utils';
import {
  test, expect, viewports, shipped, openRequest, pick, product, materials, appJson,
  counts, requestMails, photoFiles, noOverflow, addSizeVariant, type JsonBody,
} from './return-request-test-utils';

test.use({ trace: 'off' });
for (const viewport of viewports) {
  test.describe('FR-ACCOUNT-035 ' + viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('商品・理由・詳しい内容・返金と交換のご希望を確かめ、受付・DB・メールを確かめる', async ({ page, request, rr }) => {
      // FREQ-475-AC-01, FREQ-475-AC-02, FREQ-475-AC-04, FREQ-475-AC-05, FREQ-475-AC-06, FREQ-475-AC-07, FREQ-480-AC-01, FREQ-484-AC-06
      const fx = await shipped(rr, [
        { name: 'E2Eシャツ', quantity: 2, fulfillmentType: 'stock' },
        { name: 'E2Eスカート', quantity: 1, fulfillmentType: 'stock' },
      ]);
      const variant = await addVariant(rr.db, fx.itemId, { color: 'ホワイト', size: 'L', stock: 3 });
      await rr.db.query("update public.shop_return_settings set notice_text='写真と内容をお確かめください。' where id=1");
      // お客様が申し込みを始める唯一の入口。注文の画面の「返品・交換を申し込む」から入る（480-AC-01 の available）
      await rr.login();
      await page.goto('/account/orders/' + fx.orderId);
      const entry = page.getByRole('link', { name: '返品・交換を申し込む', exact: true });
      await expect(entry).toHaveAttribute('href', '/account/orders/' + fx.orderId + '/return');
      await entry.click();
      await expect(page.getByRole('heading', { name: '返品・交換のお申し込み', exact: true })).toBeVisible();
      await expect(page.getByTestId('return-request-notice')).toHaveText('写真と内容をお確かめください。');
      await page.getByRole('button', { name: '内容を確かめる', exact: true }).click();
      await expect(page.getByRole('alert').filter({ hasText: '申し込む商品を選んでください。' })).toBeVisible();
      const shirt = await pick(page);
      // 出す設定の理由だけが選べ、出さない設定の4つ（色がイメージと違った・デザインが好みでない・説明と違った・不要になった）と「不明」は選べない（475-AC-02）
      expect(await shirt.getByRole('combobox', { name: '理由', exact: true }).locator('option').allTextContents())
        .toEqual(['選んでください', '破損・不良', '注文と違う品が届いた', 'サイズが小さい', 'サイズが大きい', 'その他']);
      await shirt.getByRole('combobox', { name: '数', exact: true }).selectOption('2');
      const skirt = await pick(page, 'E2Eスカート');
      await skirt.getByRole('combobox', { name: 'ご希望', exact: true }).selectOption('exchange');
      await skirt.getByRole('combobox', { name: '交換する色・サイズ', exact: true }).selectOption(String(variant));
      await page.getByRole('button', { name: '内容を確かめる', exact: true }).click();
      const summary = page.getByRole('region', { name: 'お申し込みの内容', exact: true });
      await expect(summary).toContainText('E2Eシャツ（ホワイト / M） × 2');
      await expect(summary).toContainText('理由: その他');
      await expect(summary).toContainText('詳しい内容: 試験の詳しい内容');
      await expect(summary).toContainText('ご希望: 返金');
      await expect(summary).toContainText('ご希望: 交換（ホワイト / L）');
      await expect(summary).toContainText('返送料: お客様のご負担です');
      await expect(summary).toContainText('お申し込みの後、当店で内容を確かめてから、メールでご連絡します。');
      await page.getByRole('button', { name: '戻る', exact: true }).click();
      await expect(product(page).getByRole('combobox', { name: '数', exact: true })).toHaveValue('2');
      await page.getByRole('button', { name: '内容を確かめる', exact: true }).click();
      await page.getByRole('button', { name: '申し込む', exact: true }).click();
      await expect(page.getByTestId('return-request-accepted')).toContainText('お申し込みを受け付けました。内容を確かめて、メールでご連絡します。');
      await expect(page.getByTestId('return-request-accepted')).toContainText('返品番号: ' + returnLabelOf(fx.orderId, 1));
      const saved = (await rr.db.query('select id,status,source from public.order_returns where order_id=$1', [fx.orderId])).rows;
      expect(saved.length).toBe(1);
      expect(saved[0]).toMatchObject({ status: 'requested', source: 'customer_request' });
      const rows = (await rr.db.query(
        'select order_item_id,quantity,reason,customer_note,requested_resolution,requested_exchange_variant_id from public.order_return_lines where return_id=$1',
        [saved[0].id],
      )).rows;
      expect(rows.find((row) => row.order_item_id === fx.orderItemIds[0])).toMatchObject({ quantity: 2, reason: 'other', requested_resolution: 'refund', customer_note: '試験の詳しい内容' });
      expect(Number(rows.find((row) => row.order_item_id === fx.orderItemIds[1])?.requested_exchange_variant_id)).toBe(variant);
      expect(await counts(rr, saved[0].id as string)).toEqual({ returns: 1, photos: 0, customer: 1, shop: 1 });
      await requestMails(request, rr, fx, 1);
      const customer = await mailBodies(request, rr.member.email, '返品のお申し込みを受け付けました');
      expect(customer[0].Text).toContain('・E2Eシャツ（ホワイト / M） × 2（理由: その他／ご希望: 返金）');
      expect(customer[0].Text).toContain('・E2Eスカート（ホワイト / M） × 1（理由: その他／ご希望: 交換 ホワイト / L）');
      await noOverflow(page);
    });

    test('交換だけの理由は返金を選べず、在庫の無い色・サイズを選べない', async ({ page, rr }) => {
      // FREQ-475-AC-03
      const fx = await shipped(rr);
      const available = await addVariant(rr.db, fx.itemId, { color: 'ホワイト', size: 'L', stock: 2 });
      // 色の名前は商品ごとに一意なので、XL は上で足した「ホワイト」の別のサイズとして足す
      const empty = await addSizeVariant(rr.db, fx.itemId, 'ホワイト', 'XL');
      await openRequest(page, rr, fx.orderId);
      const row = await pick(page, 'E2Eシャツ', 'size_too_small');
      await expect(row.getByRole('combobox', { name: 'ご希望', exact: true })).toBeDisabled();
      await expect(row.getByRole('combobox', { name: 'ご希望', exact: true })).toHaveValue('exchange');
      const options = row.getByRole('combobox', { name: '交換する色・サイズ', exact: true });
      expect(await options.locator('option').evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value))).not.toContain(String(empty));
      await expect(row.getByText('ホワイト / XL: 在庫がないため選べません', { exact: true })).toBeVisible();
      await options.selectOption(String(available));
      await page.getByRole('button', { name: '内容を確かめる', exact: true }).click();
      await expect(page.getByRole('region', { name: 'お申し込みの内容' })).toContainText('ご希望: 交換（ホワイト / L）');
    });

    test('Review Focus 1 写真付きの記録後に通信が切れても、同じ本文で確かめ直し、写真と予定を増やさない', async ({ page, rr }) => {
      // FREQ-475-AC-08, FREQ-486-AC-01
      const fx = await shipped(rr);
      await openRequest(page, rr, fx.orderId);
      await pick(page);
      const files = await photoFiles(page);
      await product(page).getByTestId('return-photo-input').setInputFiles(files.png);
      await expect(product(page).getByRole('button', { name: 'この写真を外す', exact: true })).toHaveCount(1);
      await page.getByRole('button', { name: '内容を確かめる', exact: true }).click();
      const bodies: JsonBody[] = [];
      let returnId = '';
      await page.route('**/api/orders/' + fx.orderId + '/return-request', async (route) => {
        if (route.request().method() !== 'POST') { await route.fallback(); return; }
        bodies.push(route.request().postDataJSON() as JsonBody);
        const response = await route.fetch({ headers: { ...route.request().headers(), 'x-forwarded-for': rr.ip } });
        const result = await response.json() as { data: { returnId: string; replayed: boolean } };
        expect(response.status()).toBe(200);
        returnId = result.data.returnId;
        if (bodies.length === 1) { await route.abort('failed'); return; }
        expect(result.data.replayed).toBe(true);
        await route.fulfill({ response });
      });
      await page.getByRole('button', { name: '申し込む', exact: true }).click();
      await expect(page.getByRole('alert').filter({
        hasText: 'お申し込みの結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。',
      })).toBeVisible();
      await expect(page.getByRole('button', { name: '戻る', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '申し込む', exact: true })).toHaveCount(0);
      const before = await counts(rr, returnId);
      await page.getByRole('button', { name: 'もう一度確かめる', exact: true }).click();
      await expect(page.getByTestId('return-request-accepted')).toBeVisible();
      expect(bodies.length).toBe(2);
      expect(bodies[1]).toEqual(bodies[0]);
      expect(before).toEqual({ returns: 1, photos: 1, customer: 1, shop: 1 });
      expect(await counts(rr, returnId)).toEqual(before);
      // 注文が在っても、別の持ち主には存在しない注文と同じ答えを返す。
      const foreign = await createShippedOrder(rr.db, 'foreign', [
        { name: 'E2E別のお客様の品', quantity: 1, fulfillmentType: 'stock' },
      ], { userId: fx.actorId });
      for (const id of [foreign.orderId, randomUUID()]) {
        const alien = await appJson<{ error: string }>(page, '/api/orders/' + id + '/return-request');
        expect(alien.status).toBe(404);
        expect(alien.body).toEqual({ error: 'Order not found' });
      }
      expect((await materials(page, fx.orderId)).shipments[0].lines[0].state).toBe('requested');
    });
  });
}
