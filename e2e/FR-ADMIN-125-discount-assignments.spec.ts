import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { CHECKOUT_VIEWPORTS, expectNoHorizontalOverflow } from './checkout-flow-helpers';
import { discountInput, installDiscountDbBridge, withDiscountScenario } from './discount-test-utils';

test.use({ trace: 'off', locale: 'ja-JP' });
for (const viewport of CHECKOUT_VIEWPORTS) {
  test.describe(`FR-ADMIN-125 (${viewport.width}px)`, () => {
    test('FREQ-547-AC-03: 同じコードを10人に割り当てると10行で予約と確定と未使用を見分けられる', async ({ page }) => {
      test.setTimeout(300_000);
      await page.setViewportSize(viewport);
      await withDiscountScenario('assignments', async (s) => {
        const members = [s.member, s.otherMember];
        for (let n = 2; n < 10; n++) members.push(await s.actor('user', 'aal1'));
        const input = discountInput({ audience: 'assigned', allowGuests: false });
        const id = await s.createDiscount(input);
        const codeId = (await s.detail(id)).codes[0].codeId;
        expect((await s.api('admin', `/api/admin/discounts/${id}/assign`, 'POST', {
          codeId, userIds: members.map(m => m.userId), requestKey: randomUUID(),
        })).status).toBe(200);
        const item = await s.item(20_000);
        await s.cart('member', [{ ...item, quantity: 1 }]);
        await s.cart('otherMember', [{ ...item, quantity: 1 }]);
        const reserved = await s.accept(await s.createDraft([input.code!], 'member'), 'member');
        const paid = await s.accept(await s.createDraft([input.code!], 'otherMember'), 'otherMember');
        await s.recordPaid(paid);
        const detail = await s.detail(id);
        expect(detail.assignmentTotal).toBe(10);
        expect(detail.assignments.map(a => a.status).sort()).toEqual(['confirmed', 'reserved', ...Array<string>(8).fill('unused')]);
        expect(detail.assignments.find(a => a.orderId === paid)).toMatchObject({ status: 'confirmed', usedAt: expect.any(String) });
        expect(detail.assignments.find(a => a.orderId === reserved)?.status).toBe('reserved');
        await installDiscountDbBridge(page, s);
        await page.goto(`/admin/discounts/${id}`);
        const rows = page.getByRole('table').locator('tbody tr');
        await expect(rows).toHaveCount(10);
        // The rendered rows must show each state by its exact label (the dictionary, not only the API field).
        await expect(rows.filter({ has: page.getByRole('cell', { name: '未使用', exact: true }) })).toHaveCount(8);
        await expect(rows.filter({ has: page.getByRole('cell', { name: '使用済み（入金待ち）', exact: true }) })).toHaveCount(1);
        const confirmedRow = rows.filter({ has: page.getByRole('cell', { name: '使用済み', exact: true }) });
        await expect(confirmedRow).toHaveCount(1);
        await expect(confirmedRow.locator(`a[href="/admin/orders/${paid}"]`)).toBeVisible();
        await expect(confirmedRow).toContainText(/\d{4}-\d{2}-\d{2}/);
        await expect(rows.filter({ has: page.locator(`a[href="/admin/orders/${reserved}"]`) })).toContainText('使用済み（入金待ち）');
        const usedUnassign = await s.api('admin', `/api/admin/discounts/${id}/unassign`, 'POST', { codeId, userId: s.memberId, requestKey: randomUUID() });
        expect(usedUnassign.status).toBe(409);
        expect(usedUnassign.body).toMatchObject({ code: 'GROUP_H_ASSIGNMENT_USED' });
        expect((await s.api('admin', `/api/admin/discounts/${id}/unassign`, 'POST', { codeId, userId: members[2].userId, requestKey: randomUUID() })).status).toBe(200);
        expect((await s.detail(id)).assignmentTotal).toBe(9);
        // Public guest usage has a masked address, never the shipping email in the admin assignment projection.
        const publicInput = discountInput();
        const publicId = await s.createDiscount(publicInput);
        await s.cart('guest', [{ ...item, quantity: 1 }]);
        await s.recordPaid(await s.accept(await s.createDraft([publicInput.code!], 'guest'), 'guest'));
        const guest = (await s.detail(publicId)).assignments.find(a => a.guestEmailMasked !== null);
        expect(Boolean(guest?.guestEmailMasked)).toBe(true);
        expect(guest?.guestEmailMasked === s.guestEmail).toBe(false);
        await expectNoHorizontalOverflow(page);
      });
    });

    test('FREQ-547-AC-04: 使い捨て束は１人１コードで接頭辞だけを使えない', async ({ page }) => {
      test.setTimeout(240_000);
      await page.setViewportSize(viewport);
      await withDiscountScenario('batch', async (s) => {
        const input = discountInput({ code: null, codeMode: 'batch', audience: 'assigned', allowGuests: false,
          initialBatch: { prefix: s.prefix, count: 2, userIds: [s.memberId, s.otherMemberId] } });
        const id = await s.createDiscount(input);
        const codes = (await s.detail(id)).codes;
        expect(codes).toHaveLength(2);
        expect(new Set(codes.map(c => c.code)).size).toBe(2);
        const own = codes.find(c => c.assignedUserId === s.memberId)!;
        const item = await s.item(20_000);
        for (const buyer of ['member', 'otherMember'] as const) await s.cart(buyer, [{ ...item, quantity: 1 }]);
        expect((await s.preview([s.prefix], 'member')).status).toBe(422);
        expect((await s.preview([own.code], 'otherMember')).status).toBe(422);
        await s.recordPaid(await s.accept(await s.createDraft([own.code], 'member'), 'member'));
        await s.cart('member', [{ ...item, quantity: 1 }]);
        expect((await s.preview([own.code], 'member')).status).toBe(422);
        const publicId = await s.createDiscount(discountInput({ code: null, codeMode: 'batch',
          initialBatch: { prefix: `${s.prefix}U`, count: 100, userIds: [] } }));
        const publicCodes = (await s.detail(publicId)).codes;
        expect(publicCodes).toHaveLength(100);
        expect(publicCodes.every(c => new RegExp(`^${s.prefix}U-[2-9A-HJ-KM-NP-Z]{8}$`).test(c.code))).toBe(true);
        const over = await s.api('admin', `/api/admin/discounts/${publicId}/codes`, 'POST', { prefix: s.prefix, count: 101, userIds: [], requestKey: randomUUID() });
        expect(over.status).toBe(400);
        expect(over.body).toMatchObject({ error: '入力を確かめてください。' });
        await installDiscountDbBridge(page, s);
        await page.goto(`/admin/discounts/${id}`);
        await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(2);
        await expectNoHorizontalOverflow(page);
      });
    });
  });
}
