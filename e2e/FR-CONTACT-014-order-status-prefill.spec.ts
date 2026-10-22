import { expect, test } from '@playwright/test';
import { expectNoHorizontalOverflow } from './delivery-tracking-test-utils';
import {
  createOrderStatusScenario, isolateOrderStatusApiIp, openOrderStatusPage,
  orderStatusViewports, prepareOrderStatusTestLink, withOrderStatusDb,
} from './order-status-test-utils';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.setTimeout(420_000);

for (const viewport of orderStatusViewports) {
  // FREQ-504-AC-01
  // FREQ-504-AC-02
  // FREQ-504-AC-03
  // FREQ-505-AC-04
  test(`${viewport.width}px 種別と注文番号を入力済みで開き不正値は無視して編集できる`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await isolateOrderStatusApiIp(page);
    await withOrderStatusDb(async (db) => {
      const order = await createOrderStatusScenario(db, { kind: 'public' });
      const number = `ORD-${order.orderId.slice(0, 8).toUpperCase()}`;
      await openOrderStatusPage(page, await prepareOrderStatusTestLink(db, order.orderId));
      await page.getByRole('link', { name: 'お問い合わせから申し込む', exact: true }).click();
      // クリック直後は画面遷移の途中。到着するまで待ってから行き先を確かめる。
      await expect.poll(() => page.evaluate((expected) => `${window.location.pathname}${window.location.search}` === expected,
        `/contact?type=order&order=${number}`)).toBe(true);
      const orderNumber = page.getByLabel('ORDER NO. / 注文番号（任意）');
      const type = page.getByRole('combobox', { name: 'お問い合わせ内容' });
      await expect(orderNumber).toHaveValue(number);
      await expect(type).toContainText('ご注文について');
      for (const name of ['name', 'email', 'subject', 'message']) await expect(page.locator(`[name="${name}"]`)).toHaveValue('');
      await expectNoHorizontalOverflow(page);
      for (const [query, expectedType, expectedOrder] of [
        ['type=order&order=ord-abcdef12', 'ご注文について', 'ORD-ABCDEF12'],
        ['type=bad&order=ORD-ABCDEF12', '選択してください', 'ORD-ABCDEF12'],
        ['type=order&order=bad', 'ご注文について', ''],
        ['type=order&type=other&order=ORD-ABCDEF12', '選択してください', 'ORD-ABCDEF12'],
        ['type=order&order=ORD-ABCDEF12&order=ORD-ABCDEF12', 'ご注文について', ''],
        ['type=%3Cb%3Eorder%3C%2Fb%3E&order=ORD-ABCDEF12', '選択してください', 'ORD-ABCDEF12'],
        ['type=order&order=%3Cb%3EORD-ABCDEF12%3C%2Fb%3E', 'ご注文について', ''],
        ['type=order&order=ORD-ABCDEF12&name=ignored&email=ignored&subject=ignored&message=ignored', 'ご注文について', 'ORD-ABCDEF12'],
      ]) {
        await page.goto(`/contact?${query}`);
        // 入力の書き込みは画面が組み上がった後に1回でまとめて入る。値が入る側を先に待ってから、無視される側（初期のまま）を見る。
        if (expectedOrder !== '') await expect(orderNumber).toHaveValue(expectedOrder);
        else await expect(type).toContainText(expectedType);
        await expect(type).toContainText(expectedType);
        await expect(orderNumber).toHaveValue(expectedOrder);
        for (const name of ['name', 'email', 'subject', 'message']) await expect(page.locator(`[name="${name}"]`)).toHaveValue('');
        // HTML のような値は要素にも文字にもならない。
        expect(await page.locator('main').evaluate((node) => node.querySelector('b') === null && !(node.textContent ?? '').includes('<b>'))).toBe(true);
        await expectNoHorizontalOverflow(page);
      }
      let submitted: Record<string, unknown> | null = null;
      // 送信JSONだけを観測する。メール送信・APIの認可はこのケースの証拠に含めない。
      await page.route('**/api/contact', async (route) => {
        submitted = route.request().postDataJSON() as Record<string, unknown>;
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' });
      });
      await orderNumber.fill('ORD-1234ABCD');
      await type.click();
      await page.getByRole('option', { name: 'その他', exact: true }).click();
      await page.getByLabel('NAME / お名前').fill('合成の利用者');
      await page.getByLabel('EMAIL / メールアドレス').fill('e5-contact@example.invalid');
      await page.getByLabel('SUBJECT / 件名').fill('注文の相談');
      await page.getByLabel('MESSAGE / メッセージ *').fill('編集した値を送ります。');
      await expect(orderNumber).toHaveValue('ORD-1234ABCD');
      await expect(type).toContainText('その他');
      await page.getByRole('button', { name: 'SEND MESSAGE', exact: true }).click();
      await expect.poll(() => submitted !== null).toBe(true);
      expect(submitted !== null && submitted['inquiryType'] === 'other' && submitted['orderNumber'] === 'ORD-1234ABCD').toBe(true);
      await expect(page.getByRole('heading', { name: 'お問い合わせありがとうございます' })).toBeVisible();
      await expectNoHorizontalOverflow(page);
    });
  });
}
