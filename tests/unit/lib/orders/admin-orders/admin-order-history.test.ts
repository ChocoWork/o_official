import { mapItemStateHistoryRows, type ItemStateHistoryDbRow } from '@/lib/orders/admin-orders/admin-order-history';
import { ITEM_STATE_REASON_LABELS, itemStateReasonLabel } from '@/lib/orders/admin-orders/admin-order-types';
const row: ItemStateHistoryDbRow = { id: '12345678-1234-4234-8234-123456789abc', created_at: '2026-10-26T00:00:00Z', order_item_id: '22345678-1234-4234-8234-123456789abc', item_name: '品物', color: '白', size: 'M', is_exchange: true, quantity: 2, from_status: 'in_production', to_status: 'ready', reason: 'allocation_swap', actor_id: null, operation: 'allocation_swap', ref_kind: null, ref_id: null, ref_label: null, note: '入替の理由', counterpart_order_id: '32345678-1234-4234-8234-123456789abc' };
test('FREQ-539-AC-04: 自動・状態・交換の名前・相手の注文と理由を写す', () => {
  const emailOf = jest.fn();
  expect(mapItemStateHistoryRows([row], emailOf)).toEqual([{ id: row.id, at: row.created_at, orderItemId: row.order_item_id, itemName: '品物（白 / M）（交換品）', quantity: 2, from: 'in_production', to: 'ready', reason: 'allocation_swap', reasonLabel: '割当の入替', actorEmail: null, automatic: true, ref: null, swap: { counterpartOrderId: row.counterpart_order_id, note: '入替の理由' } }]);
  expect(emailOf).not.toHaveBeenCalled();
});
test.each(['shipment_slip', 'purchase_order'] as const)('FREQ-539-AC-04: 人・参照 %s・色サイズなし・開始状態なし', (kind) => {
  const entry = mapItemStateHistoryRows([{ ...row, actor_id: row.id, color: null, size: null, is_exchange: false, from_status: null, operation: 'other', ref_kind: kind, ref_id: row.id, ref_label: '番号' }], () => 'actor@example.invalid')[0];
  expect(entry).toMatchObject({ itemName: '品物', automatic: false, actorEmail: 'actor@example.invalid', from: null, ref: { kind, id: row.id, label: '番号' }, swap: null });
});
test('FREQ-539-AC-04: 理由は共通の全34値と未知の固定文', () => {
  expect(Object.keys(ITEM_STATE_REASON_LABELS)).toHaveLength(34);
  expect(ITEM_STATE_REASON_LABELS).toEqual({
    place_order_from_checkout_draft: '注文の受付', stripe_payment_awaiting: '支払い待ち', stripe_payment_paid: '入金の確認', fifo: '古い注文から順の自動割当', stock_move: '在庫の入出庫', purchase_order_receive: '発注の受け取り',
    shipment_slip_confirm: '発送の確定', shipment_slip_cancel: '発送の取消', shipment_slip_tracking_update: '伝票番号の更新', shipment_slip_deliver: '配達済みの記録', delivery_reflect: '配送の状況の反映', begin_order_refund: '返金の受付', mark_order_refund_error: '返金の失敗', admin_cancel_failed_order: '決済失敗の注文の取消', record_cancelled_order_payment: '取消後の入金',
    resolve_payment_exception: '支払いの要対応の解決', resolve_payment_exception_by_system: '支払いの要対応の解決', customer_request_cancel: 'お客様のキャンセルの申し込み', admin_decline_cancel_request: 'キャンセルの申し込みのお断り', admin_close_cancel_request: 'キャンセルの申し込みを閉じる', admin_resolve_cancel_request: 'キャンセルの申し込みの解決',
    customer_request_return: 'お客様の返品の申し込み', admin_create_return: '返品の作成', admin_approve_return: '返品の承認', return_declined_restore: '返品のお断りによる復帰', admin_cancel_return: '返品の取消', admin_receive_return: '返品の受け取り', admin_inspect_return: '返品の検品', admin_close_return_missing: '届かない返品の完了', admin_reopen_return: '返品の開き直し', admin_refund_return: '返品の返金', admin_record_return_fee_payment: '返品の手数料の受け取り', admin_release_return_exchange: '支払いを待たずに交換品を送る', allocation_swap: '割当の入替',
  });
  expect(itemStateReasonLabel('unknown')).toBe('システムによる更新');
  expect(itemStateReasonLabel('toString')).toBe('システムによる更新');
  expect(itemStateReasonLabel('fifo')).toBe('古い注文から順の自動割当');
});
