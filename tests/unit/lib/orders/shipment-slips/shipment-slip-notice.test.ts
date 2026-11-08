import { DISPUTE_HOLD_CODE, DISPUTE_HOLD_MESSAGE, disputeHoldMessage } from '@/lib/orders/shipment-slips/shipment-slip-notice';

describe('発送票の確定の断りの文（DISPUTE_HOLD）', () => {
  test('FREQ-568-AC-06: 確定の断りの本文がDISPUTE_HOLDなら、画面に出す文を返す', () => {
    expect(DISPUTE_HOLD_CODE).toBe('DISPUTE_HOLD');
    expect(DISPUTE_HOLD_MESSAGE).toBe('カード会社の判断待ちの注文が含まれているため、出荷できません。');
    const body = { error: DISPUTE_HOLD_MESSAGE, code: 'DISPUTE_HOLD', orderIds: ['11111111-1111-4111-8111-111111111111'] };
    expect(disputeHoldMessage(body)).toBe(DISPUTE_HOLD_MESSAGE);
    // 画面に「チャージバック」と書かない
    expect(DISPUTE_HOLD_MESSAGE).not.toContain('チャージバック');
  });

  test('FREQ-568-AC-06: ほかの断り・壊れた本文は今までの扱い（null）', () => {
    for (const body of [null, undefined, 'DISPUTE_HOLD', 3, [], {}, { code: 'GROUP_G_SLIP_NOT_DRAFT' }, { code: 'dispute_hold' }, { code: 1 }]) {
      expect(disputeHoldMessage(body)).toBeNull();
    }
  });
});
