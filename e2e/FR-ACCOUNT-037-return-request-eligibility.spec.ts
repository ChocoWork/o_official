import { randomUUID } from 'node:crypto';
import { createReturnInDb, receiveReturnInDb } from './return-test-utils';
import {
  test, expect, viewports, shipped, expired, openRequest, pick, product, materials,
  appJson, line, requestDb, section, noOverflow,
} from './return-request-test-utils';

test.use({ trace: 'off' });
for (const viewport of viewports) {
  test.describe('FR-ACCOUNT-037 ' + viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('期限を過ぎた注文は終了日を出し、直接の申し込みも断る', async ({ page, rr }) => {
      // FREQ-477-AC-01, FREQ-477-AC-04, FREQ-480-AC-01
      const fx = await expired(rr);
      await openRequest(page, rr, fx.orderId);
      const data = await materials(page, fx.orderId);
      expect(data.availability.returns).toBe('ended');
      expect(data.shipments[0].lines[0].state).toBe('past_deadline');
      const ended = data.availability.endedOn!.split('-').map(Number);
      const text = '返品・交換の受付は ' + ended[1] + '月' + ended[2] + '日 で終わりました';
      await expect(page.getByText(text, { exact: true })).toBeVisible();
      await expect(page.getByRole('checkbox', { name: 'この商品を申し込む', exact: true })).toHaveCount(0);
      await page.goto('/account/orders/' + fx.orderId);
      await expect(page.getByTestId('order-returns-ended')).toHaveText(text);
      await expect(page.getByTestId('order-returns-request')).toHaveCount(0);
      const response = await appJson<{ code: string }>(page, '/api/orders/' + fx.orderId + '/return-request',
        { requestKey: randomUUID(), lines: [line(fx)] });
      expect(response.status).toBe(409); expect(response.body.code).toBe('RETURN_NOT_ELIGIBLE');
      await noOverflow(page);
    });

    test('お申し込み済み・お返し・数の無い品は選べず、選べる品は残る', async ({ page, rr }) => {
      // FREQ-477-AC-01, FREQ-477-AC-05
      const fx = await shipped(rr, ['受付中', 'お返し', '処理済み', '選べる'].map((name) => ({
        name: 'E2E' + name, quantity: 1, fulfillmentType: 'stock' as const,
      })));
      await requestDb(rr, fx, [line(fx, 0)]);
      for (const index of [1, 2]) {
        const ret = await createReturnInDb(rr.db, fx, { lines: [{ orderItemId: fx.orderItemIds[index], quantity: 1 }], notify: false });
        await receiveReturnInDb(rr.db, ret.returnId, fx.actorId, {
          units: [{ lineId: ret.lineIds[fx.orderItemIds[index]], quantity: 1, disposition: index === 1 ? 'sent_back' : 'restocked' }],
          // お返しのメッセージは必ず届ける決まりなので、お返しの受け取りだけ知らせを送る（DB は notify=false を RETURN_ARGUMENT_INVALID で断る）
          choice: index === 1 ? 'none' : 'now', amount: index === 2 ? 0 : undefined, notify: index === 1,
          sentBack: index === 1 ? { message: '条件に合わないためお返しします。' } : undefined,
        });
      }
      await openRequest(page, rr, fx.orderId);
      for (const [name, text] of [
        ['E2E受付中', 'お申し込み済み'], ['E2Eお返し', 'お返しした商品のため、お申し込みいただけません'],
        ['E2E処理済み', 'お申し込みいただける数がありません'],
      ]) {
        const row = product(page, name);
        await expect(row.getByText(text, { exact: true })).toBeVisible();
        await expect(row.getByRole('checkbox', { name: 'この商品を申し込む', exact: true })).toHaveCount(0);
      }
      await expect(product(page, 'E2E選べる').getByRole('checkbox', { name: 'この商品を申し込む', exact: true })).toBeEnabled();
    });

    test('返品不可の理由は破損・不良と誤送だけで、直接送った都合の理由も DB が断る', async ({ page, rr }) => {
      // FREQ-477-AC-03, FREQ-482-AC-06
      const fx = await shipped(rr);
      await rr.setItem(fx.itemId, true);
      await openRequest(page, rr, fx.orderId);
      const row = await pick(page, 'E2Eシャツ', 'wrong_item');
      await expect(row.getByText('この商品は返品不可の商品です。初期不良・誤送の時だけお申し込みいただけます。', { exact: true })).toBeVisible();
      expect(await row.getByRole('combobox', { name: '理由', exact: true }).locator('option').allTextContents())
        .toEqual(['選んでください', '破損・不良', '注文と違う品が届いた']);
      const response = await appJson<{ code: string }>(page, '/api/orders/' + fx.orderId + '/return-request',
        { requestKey: randomUUID(), lines: [line(fx)] });
      expect(response.status).toBe(409); expect(response.body.code).toBe('RETURN_NOT_ELIGIBLE');
    });

    test('受付オフではフォームと入口を出さず、直接の申し込み・写真の送り先も断る', async ({ page, rr }) => {
      // FREQ-477-AC-04
      const fx = await shipped(rr);
      await rr.db.query('update public.shop_return_settings set requests_enabled=false where id=1');
      await openRequest(page, rr, fx.orderId);
      await expect(page.getByText('現在、返品・交換のお申し込みを受け付けていません。', { exact: true })).toBeVisible();
      await expect(page.getByRole('checkbox', { name: 'この商品を申し込む', exact: true })).toHaveCount(0);
      expect((await section(page, fx.orderId)).availability.returns).toBe('closed');
      await page.goto('/account/orders/' + fx.orderId);
      await expect(page.getByTestId('order-returns-request')).toHaveCount(0);
      for (const suffix of ['/return-request', '/return-request/photos']) {
        const response = await appJson<{ code: string }>(page, '/api/orders/' + fx.orderId + suffix,
          suffix.endsWith('/photos') ? {} : { requestKey: randomUUID(), lines: [line(fx)] });
        expect(response.status).toBe(409); expect(response.body.code).toBe('RETURN_REQUESTS_CLOSED');
      }
    });
  });
}
