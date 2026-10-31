import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { CHECKOUT_VIEWPORTS, expectNoHorizontalOverflow, fillShippingForm, stubPostalCode } from './checkout-flow-helpers';
import { discountInput, GUEST_REFUSAL, installDiscountDbBridge, withDiscountScenario } from './discount-test-utils';

test.use({ trace: 'off', locale: 'ja-JP' });
for (const viewport of CHECKOUT_VIEWPORTS) {
  test.describe(`FR-CHECKOUT-054 (${viewport.width}px)`, () => {
    test('FREQ-548-AC-01: guestの使えないコードは全理由が同じ文とログインリンクで存在を区別できない', async ({ page }) => {
      test.setTimeout(300_000);
      await page.setViewportSize(viewport);
      await withDiscountScenario('guest-refusals', async (s) => {
        const item = await s.item(20_000);
        await s.cart('guest', [{ ...item, quantity: 1 }]);
        await s.cart('member', [{ ...item, quantity: 1 }]);
        const inputs = [
          discountInput({ audience: 'assigned', allowGuests: false }),
          discountInput({ allowGuests: false }),
          discountInput({ endsAt: '2026-01-02T00:00:00Z' }),
          discountInput({ usageLimit: 1 }),
          discountInput({ minimum: { type: 'amount', value: 100_000 } }),
        ];
        for (const input of inputs) await s.createDiscount(input);
        // Fill the usage cap by the real acceptance and payment path.
        await s.recordPaid(await s.accept(await s.createDraft([inputs[3].code!], 'member'), 'member'));
        await installDiscountDbBridge(page, s, 'guest');
        await page.goto('/checkout');
        for (const code of [`${s.prefix}-ABSENT`, ...inputs.map(i => i.code!)]) {
          const reply = await s.preview([code], 'guest');
          expect(reply.status).toBe(422);
          expect(reply.body).toEqual({ error: 'promotion_code_invalid', refusals: [{ code, reason: 'not_eligible' }], message: GUEST_REFUSAL });
          await page.getByRole('textbox', { name: 'プロモーションコード', exact: true }).fill(code);
          const refused = page.waitForResponse(r => new URL(r.url()).pathname === '/api/checkout/promotion-code' && r.status() === 422);
          await page.getByRole('button', { name: '適用', exact: true }).click();
          await refused;
          await expect(page.getByText(GUEST_REFUSAL, { exact: true })).toBeVisible({ timeout: 20_000 });
          await expect(page.getByRole('link', { name: 'ログインして割引を確かめる', exact: true })).toHaveAttribute('href', '/login?next=%2Fcheckout', { timeout: 20_000 });
        }
        await s.cart('member', [{ ...item, quantity: 1 }]);
        const restricted = await s.preview([inputs[1].code!], 'member');
        expect(restricted.status).toBe(200);
        const expired = await s.preview([inputs[2].code!], 'member');
        expect(expired.body.message).toBe('このコードは有効期限が切れています');
        const assigned = await s.preview([inputs[0].code!], 'member');
        expect(assigned.body.message).toBe('このコードは使えません');
        expect((await s.preview([inputs[3].code!], 'member')).body.message).toBe('このコードは利用回数の上限に達しています');
        expect((await s.preview([inputs[4].code!], 'member')).body.message).toBe('このコードは ¥100,000 以上のご注文で使えます');
        // Five normalized codes can be kept and individually removed, including unused codes.
        const codes: string[] = [];
        for (let n = 0; n < 5; n++) {
          const input = discountInput(); await s.createDiscount(input); codes.push(input.code!);
        }
        for (const code of codes) {
          await page.getByRole('textbox', { name: 'プロモーションコード', exact: true }).fill(code);
          await page.getByRole('button', { name: '適用', exact: true }).click();
          await expect(page.getByRole('button', { name: `${code}を削除`, exact: true })).toBeVisible({ timeout: 20_000 });
        }
        await expect(page.getByText('コードは5つまで入力できます。', { exact: true })).toBeVisible({ timeout: 20_000 });
        await page.getByRole('button', { name: `${codes[0]}を削除`, exact: true }).click();
        await expect(page.getByRole('textbox', { name: 'プロモーションコード', exact: true })).toBeFocused({ timeout: 20_000 });
        await expectNoHorizontalOverflow(page);
      });
    });

    test('FREQ-548-AC-01: guestはメールを替えてもpreviewが同じ見込みでconfirmからだけ記録を確認する', async ({ page }) => {
      test.setTimeout(240_000);
      await page.setViewportSize(viewport);
      await withDiscountScenario('guest-email', async (s) => {
        const item = await s.item(20_000);
        const input = discountInput({ method: 'automatic', code: null, firstOrderOnly: true });
        await s.createDiscount(input);
        await s.cart('guest', [{ ...item, quantity: 1 }]);
        const first = await s.preview([], 'guest', s.guestEmail);
        const other = await s.preview([], 'guest', s.otherMember.email);
        expect(first.status).toBe(200);
        expect(first.body.result).toEqual(other.body.result);
        expect(first.body.result?.provisional).toBe(true);
        await s.recordPaid(await s.accept(await s.createDraft([], 'guest'), 'guest'));
        await s.cart('guest', [{ ...item, quantity: 1 }]);
        // After a paid order exists for s.guestEmail, preview must still ignore the email: same result for the recorded and a never-seen address.
        const recorded = await s.preview([], 'guest', s.guestEmail);
        const unseen = await s.preview([], 'guest', `h11-unseen-${randomUUID()}@example.invalid`);
        expect([recorded.status, unseen.status]).toEqual([200, 200]);
        expect(recorded.body.result?.discountAmount).toBe(2_000);
        expect(recorded.body.result?.provisional).toBe(true);
        expect(unseen.body.result).toEqual(recorded.body.result);
        expect((await s.preview([], 'guest')).body.result).toEqual(recorded.body.result);
        const confirmation = await s.confirm([], 'guest');
        expect(confirmation.status).toBe(200);
        expect(confirmation.body.confirmation?.discountResult?.discountAmount).toBe(0);
        await installDiscountDbBridge(page, s, 'guest');
        await page.goto('/checkout');
        await expect(page.locator('.checkout-summary')).toContainText('見込み');
        await expectNoHorizontalOverflow(page);
      });
    });

    test('FREQ-548-AC-02: 有料履歴のあるguestは自動の初回割引が外れた最終確認から払え入力へ戻るループにならない', async ({ page }) => {
      test.setTimeout(300_000);
      await page.setViewportSize(viewport);
      await withDiscountScenario('guest-first-confirm', async (s) => {
        const item = await s.item(20_000);
        await s.cart('guest', [{ ...item, quantity: 1 }]);
        await s.recordPaid(await s.accept(await s.createDraft([], 'guest'), 'guest'));
        await s.cart('guest', [{ ...item, quantity: 1 }]);
        await s.createDiscount(discountInput({ method: 'automatic', code: null, firstOrderOnly: true }));
        await installDiscountDbBridge(page, s, 'guest');
        await stubPostalCode(page);
        let codeLess409 = 0;
        page.on('response', response => {
          if (new URL(response.url()).pathname === '/api/checkout/create-session' && response.status() === 409) codeLess409++;
        });
        await page.goto('/checkout');
        await expect(page.locator('.checkout-summary')).toContainText('見込み');
        await fillShippingForm(page, s.guestEmail);
        await page.getByRole('button', { name: '確認へ進む', exact: true }).click();
        await expect(page.getByRole('heading', { name: '注文内容の最終確認', exact: true })).toBeVisible();
        await expect(page.locator('.checkout-total')).toContainText('20,000');
        const draft = await s.latestDraft('guest');
        await s.recordPaid(await s.accept(draft, 'guest'));
        expect(codeLess409).toBe(0);
        const input = discountInput({ firstOrderOnly: true }); await s.createDiscount(input);
        await s.cart('guest', [{ ...item, quantity: 1 }]);
        const refused = await s.confirm([input.code!], 'guest');
        expect(refused.status).toBe(409);
        expect(refused.body).toMatchObject({ definitive: true, returnTo: 'input' });
        await expectNoHorizontalOverflow(page);
      });
    });

    test('FREQ-547-AC-04: 束は対象会員だけ１回、未割当束はsuffix８字でprefix単独は無効', async ({ page }) => {
      test.setTimeout(240_000);
      await page.setViewportSize(viewport);
      await withDiscountScenario('checkout-batch', async (s) => {
        const item = await s.item(20_000);
        for (const buyer of ['member', 'otherMember', 'guest'] as const) await s.cart(buyer, [{ ...item, quantity: 1 }]);
        const id = await s.createDiscount(discountInput({ code: null, codeMode: 'batch', audience: 'assigned', allowGuests: false,
          initialBatch: { prefix: s.prefix, userIds: [s.memberId], count: 1 } }));
        const code = (await s.detail(id)).codes[0].code;
        expect((await s.preview([code], 'otherMember')).status).toBe(422);
        expect((await s.preview([code], 'guest')).status).toBe(422);
        await s.recordPaid(await s.accept(await s.createDraft([code], 'member'), 'member'));
        await s.cart('member', [{ ...item, quantity: 1 }]);
        expect((await s.preview([code], 'member')).status).toBe(422);
        const unassignedId = await s.createDiscount(discountInput({ code: null, codeMode: 'batch',
          initialBatch: { prefix: `${s.prefix}U`, userIds: [], count: 1 } }));
        const unassigned = (await s.detail(unassignedId)).codes[0].code;
        expect(unassigned.split('-').at(-1)).toHaveLength(8);
        expect((await s.preview([`${s.prefix}U`], 'guest')).status).toBe(422);
        expect((await s.preview([unassigned], 'guest')).status).toBe(200);
        await installDiscountDbBridge(page, s, 'member');
        await page.goto('/checkout');
        await expectNoHorizontalOverflow(page);
      });
    });
  });
}
