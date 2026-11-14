import { REFUND_ERROR_MESSAGES } from '@/lib/orders/refund/refund-messages';
import { toRefundErrorCode } from '@/lib/orders/refund/refund-store';
import { RETURN_ERROR_MESSAGES } from '@/lib/orders/returns/return-messages';
import { receiveReturn, toReturnErrorCode, type ReceiveReturnInput } from '@/lib/orders/returns/return-store';
import { SHIPMENT_SLIP_ERRORS } from '@/lib/orders/shipment-slips/shipment-slip-types';

// 会計の計画3 Task 10: 返金・返品・発送票の既存の route が、エラー表の行と受け取りの引数だけ増えて、ほかは今までのまま。
// 表の今までの行は各表の単体が全行で固定している。ここは「足した行」と「受け取りの引数の渡し方」を1か所で固定する。

const INPUT: ReceiveReturnInput = {
  returnId: 'a1b2c3d4-1111-4222-8333-444455556661',
  actorId: 'a1b2c3d4-1111-4222-8333-444455556662',
  actorCanRefund: true,
  requestKey: 'a1b2c3d4-1111-4222-8333-444455556663',
  units: [{ returnLineId: 'a1b2c3d4-1111-4222-8333-444455556664', disposition: 'restocked', quantity: 1 }],
  exchangeOverrides: [],
  refundChoice: 'consult',
  refundAmount: null,
  refundShippingAmount: 0,
  note: null,
  notifyCustomer: false,
  sentBackMessage: null,
  sentBackCarrier: null,
  sentBackTrackingNumber: null,
};

async function argsOf(input: ReceiveReturnInput): Promise<Record<string, unknown>> {
  const calls: Array<Record<string, unknown>> = [];
  const store = {
    rpc: async (_name: string, args: Record<string, unknown>) => {
      calls.push(args);
      return { data: [{ receipt_id: 'r', return_status: 'open' }], error: null };
    },
  };
  await receiveReturn(store as never, input);
  return calls[0];
}

describe('FREQ-576-AC-06: 返金・返品・発送票の既存のrouteの単体が、エラー表と受け取りの引数の追加以外は無改造で通る', () => {
  it('エラー表で増えたのは3行だけ: 返金の dispute_hold・返品の RETURN_ARRIVAL_DATE_INVALID・発送票の ACCOUNTING_DISPUTE_HOLD', () => {
    expect(REFUND_ERROR_MESSAGES.dispute_hold).toEqual({ status: 409, message: 'カード会社の判断待ちの注文が含まれているため、返金できません。' });
    expect(toRefundErrorCode('ACCOUNTING_DISPUTE_HOLD')).toBe('dispute_hold');
    expect(RETURN_ERROR_MESSAGES.RETURN_ARRIVAL_DATE_INVALID).toEqual({ status: 400, message: '届いた日を確かめてください。' });
    expect(toReturnErrorCode('RETURN_ARRIVAL_DATE_INVALID')).toBe('RETURN_ARRIVAL_DATE_INVALID');
    expect(toReturnErrorCode('ACCOUNTING_DISPUTE_HOLD')).toBe('dispute_hold');
    expect(SHIPMENT_SLIP_ERRORS.ACCOUNTING_DISPUTE_HOLD).toEqual(['55000', 409, 'カード会社の判断待ちの注文が含まれているため、出荷できません。']);
    expect(Object.keys(REFUND_ERROR_MESSAGES)).toHaveLength(17);
    expect(Object.keys(RETURN_ERROR_MESSAGES)).toHaveLength(34);
    expect(Object.keys(SHIPMENT_SLIP_ERRORS)).toHaveLength(29);
  });

  it('受け取りの引数: 省いた引数は渡さず（16番目は真の時だけ、17番目は arrivedOn がある時だけ）、ほかの引数は今までのまま', async () => {
    const plain = await argsOf(INPUT);
    expect(Object.keys(plain).sort()).toEqual(
      [
        '_return_id', '_actor_id', '_actor_can_refund', '_request_key', '_units', '_exchange_overrides', '_refund_choice', '_refund_amount',
        '_refund_shipping_amount', '_note', '_notify_customer', '_sent_back_message', '_sent_back_carrier', '_sent_back_tracking_number', '_pricing',
      ].sort(),
    );
    expect(await argsOf({ ...INPUT, restockingFeeWaived: false, arrivedOn: undefined })).toEqual(plain);
    expect(await argsOf({ ...INPUT, restockingFeeWaived: true })).toEqual({ ...plain, _restocking_fee_waived: true });
    expect(await argsOf({ ...INPUT, arrivedOn: '2026-11-10' })).toEqual({ ...plain, _arrived_on: '2026-11-10' });
    expect(await argsOf({ ...INPUT, restockingFeeWaived: true, arrivedOn: '2026-11-10' })).toEqual({
      ...plain,
      _restocking_fee_waived: true,
      _arrived_on: '2026-11-10',
    });
  });
});
