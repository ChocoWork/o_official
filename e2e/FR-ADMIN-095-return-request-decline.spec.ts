import { expectDbError } from './order-email-test-utils';
import { orderNumberOf } from './order-fulfillment-test-utils';
import {
  test, expect, viewports, shipped, requestDb, adminScene, openReview, expectMails, noOverflow,
} from './return-request-test-utils';

test.use({ trace: 'off' });
for (const viewport of viewports) {
  test.describe('FR-ADMIN-095 ' + viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('1画面で理由の最初の文・必須・確かめを出し、直したメッセージでお断りし、メールを送る', async ({ page, request, rr }) => {
      // FREQ-479-AC-01, FREQ-479-AC-02, FREQ-479-AC-03, FREQ-479-AC-04, FREQ-484-AC-06
      test.setTimeout(180_000);
      const fx = await shipped(rr);
      const ret = await requestDb(rr, fx);
      const scene = await adminScene(page, rr, fx);
      await (await openReview(page, fx, ret.number)).getByRole('button', { name: 'お断りする', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: /^お断りする（/ });
      const reason = dialog.getByRole('combobox', { name: 'お断りの理由（お客様には見えません）', exact: true });
      const message = dialog.getByRole('textbox', { name: 'お客様へのメッセージ（必須・お客様に届きます）', exact: true });
      await expect(reason).toHaveValue('');
      expect((await reason.locator('option').allTextContents())[0]).toBe('選んでください');
      await expect(dialog.getByRole('button', { name: 'お断りする', exact: true })).toBeDisabled();
      await reason.selectOption('window_passed');
      await expect(message).toHaveValue('受付の期限を過ぎているため、今回のお申し込みはお受けできませんでした。');
      await reason.selectOption('final_sale');
      await expect(message).toHaveValue('この商品は返品不可の商品のため、お客様のご都合による返品・交換はお受けできませんでした。');
      await message.fill(' ');
      await expect(dialog.getByRole('button', { name: 'お断りする', exact: true })).toBeDisabled();
      const text = '今回はお受けできませんでした。\n窓口へご連絡ください。';
      await message.fill(text);
      await reason.selectOption('other');
      await expect(message).toHaveValue(text);
      await expect(dialog.getByText('お客様にメッセージが届きます。取り消せません。', { exact: true })).toBeVisible();
      expect(scene.posts.decline.length).toBe(0);
      await dialog.getByRole('button', { name: 'お断りする', exact: true }).click();
      await expect.poll(() => scene.posts.decline.length).toBe(1);
      expect(scene.posts.decline[0]).toEqual({ declineReason: 'other', declineMessage: text });
      const saved = (await rr.db.query('select status,decline_reason,decline_message from public.order_returns where id=$1', [ret.id])).rows[0];
      expect(saved).toEqual({ status: 'declined', decline_reason: 'other', decline_message: text });
      await expectMails(request, rr.member.email, '【Le Fil des Heures】返品のお申し込みについて（' + orderNumberOf(fx.orderId) + '）',
        ['当店より:\n' + text]);
      await noOverflow(page);
    });

    test('戻るでは送らず、お断りの2回目は DB が断ってメールの予定を増やさない', async ({ page, rr }) => {
      // FREQ-479-AC-04
      const fx = await shipped(rr);
      const ret = await requestDb(rr, fx);
      const scene = await adminScene(page, rr, fx);
      await (await openReview(page, fx, ret.number)).getByRole('button', { name: 'お断りする', exact: true }).click();
      await page.getByRole('dialog', { name: /^お断りする（/ }).getByRole('button', { name: '戻る', exact: true }).click();
      await expect(page.getByRole('dialog', { name: /^返品の申し込みを確かめる（/ })).toBeVisible();
      expect(scene.posts.decline.length).toBe(0);
      const values = [ret.id, fx.actorId, 'other', '試験のお断り'];
      await rr.db.query('select * from public.admin_decline_return($1::uuid,$2::uuid,$3::text,$4::text)', values);
      await expectDbError(rr.db.query('select * from public.admin_decline_return($1::uuid,$2::uuid,$3::text,$4::text)', values), 'RETURN_STATE_CONFLICT');
      expect(Number((await rr.db.query("select count(*) from private.order_email_outbox where return_id=$1 and kind='return_declined'", [ret.id])).rows[0].count)).toBe(1);
    });
  });
}
