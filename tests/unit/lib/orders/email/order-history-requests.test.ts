import {
  buildOrderHistory,
  type BuildOrderHistoryInput,
  type OrderHistoryEntry,
  type OrderHistoryReturnEntry,
  type OrderHistoryReturnRecord,
} from '@/lib/orders/email/order-history';
import type { AdminCancelRequest, OrderReturnDetail } from '@/lib/orders/returns/return-types';
import { returnDetail } from '../returns/order-return-detail-fixture';

/**
 * 履歴の申し込みの行（グループ E-3 段2、決め事 P17）: お客様の返品の申し込み・承認・お断りと、
 * キャンセルの申し込み・お断り・解決済み・解決。文は計画の冒頭の P17 を一字ずつ書き写した物。
 * 返品の番号は returnDetail の見本の返品 ORD-A1B2C3D4-R1
 */

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const NOT_PAUSED = { paused: false, reason: null, pausedAt: null, nextProbeAt: null };
const ORDER = { id: ORDER_ID, status: 'paid' as const, shippingEmail: 'hanako@example.com', createdAt: '2026-10-08T23:00:00.000Z' };

function input(overrides: Partial<BuildOrderHistoryInput> = {}): BuildOrderHistoryInput {
  return {
    order: ORDER, statusRows: [], emailRows: [], sendState: NOT_PAUSED, fulfillments: [], completions: [], refunds: [], returns: [],
    returnReceiptLines: [], returnRecords: [], cancelRequests: [], lines: [],
    ...overrides,
  };
}

function returnRowsOf(entries: OrderHistoryEntry[]): OrderHistoryReturnEntry[] {
  return entries.filter((entry): entry is OrderHistoryReturnEntry => entry.type === 'return');
}

/** お客様の申し込みの返品（申し込み中）。段2のキーを全部書く（見本の初期値に頼らない） */
function requestedReturn(overrides: Partial<OrderReturnDetail> = {}): OrderReturnDetail {
  return returnDetail({
    source: 'customer_request',
    status: 'requested',
    displayStatus: 'requested',
    createdByEmail: null,
    requestedAt: '2026-10-14T01:00:00.000Z',
    approvedAt: null,
    approvedByEmail: null,
    declinedAt: null,
    declineReason: null,
    declineMessage: null,
    ...overrides,
  });
}

/** 窓口が order_returns から引いて渡す、お断りをした人のメールなど（returnDetail の見本の返品 ret-1 の分） */
function returnRecord(overrides: Partial<OrderHistoryReturnRecord> = {}): OrderHistoryReturnRecord {
  return {
    returnId: 'ret-1', cancelledByEmail: null, feeReceivedByEmail: null, exchangeReleasedByEmail: null, declinedByEmail: null,
    feeWaived: false, feeSettledAmount: 0, ...overrides,
  };
}

function cancelRequest(overrides: Partial<AdminCancelRequest> = {}): AdminCancelRequest {
  return {
    id: 'cr-1',
    status: 'requested',
    requestedAt: '2026-10-14T02:00:00.000Z',
    customerNote: null,
    lines: [],
    declineReason: null,
    declineMessage: null,
    declinedAt: null,
    declinedByEmail: null,
    resolvedAt: null,
    resolvedByEmail: null,
    resolvedRefundId: null,
    resolvedByCancelAt: null,
    closedAt: null,
    closedByEmail: null,
    ...overrides,
  };
}

describe('buildOrderHistory - 返品の申し込み（お客様）', () => {
  it('申し込み中の返品は「返品の申し込み」の行を、申し込みの時刻で出す。した人は出さない（お客様がするため）。「返品を作った」は出さない', () => {
    const history = buildOrderHistory(input({ returns: [requestedReturn()] }));

    expect(returnRowsOf(history.entries)).toEqual([{
      type: 'return', kind: 'request', id: 'request:ret-1', at: '2026-10-14T01:00:00.000Z', returnId: 'ret-1',
      title: '返品の申し込み（ORD-A1B2C3D4-R1）', details: [], actorEmail: null,
    }]);
  });

  it('承認した返品は「返品の申し込みを承認した」の行を、承認の時刻と承認した人のメールで出す。新しい順に、申し込みの行の上に置く', () => {
    const history = buildOrderHistory(input({
      returns: [requestedReturn({ status: 'open', approvedAt: '2026-10-14T03:00:00.000Z', approvedByEmail: 'admin@example.com' })],
    }));

    expect(returnRowsOf(history.entries).map((entry) => [entry.kind, entry.id, entry.at, entry.title, entry.actorEmail])).toEqual([
      ['approve', 'approve:ret-1', '2026-10-14T03:00:00.000Z', '返品の申し込みを承認した（ORD-A1B2C3D4-R1）', 'admin@example.com'],
      ['request', 'request:ret-1', '2026-10-14T01:00:00.000Z', '返品の申し込み（ORD-A1B2C3D4-R1）', null],
    ]);
  });

  it('お断りした返品は「返品の申し込みをお断りした」の行を、お断りの時刻と、窓口が引いたお断りをした人のメールで出す。分からなければ null', () => {
    const declined = requestedReturn({
      status: 'declined', declinedAt: '2026-10-14T03:00:00.000Z', declineReason: 'final_sale', declineMessage: 'お客様向けのメッセージ',
    });

    const withRecord = buildOrderHistory(input({ returns: [declined], returnRecords: [returnRecord({ declinedByEmail: 'support@example.com' })] }));
    const withoutRecord = buildOrderHistory(input({ returns: [declined] }));

    expect(returnRowsOf(withRecord.entries)[0]).toEqual({
      type: 'return', kind: 'decline', id: 'decline:ret-1', at: '2026-10-14T03:00:00.000Z', returnId: 'ret-1',
      title: '返品の申し込みをお断りした（ORD-A1B2C3D4-R1）', details: [], actorEmail: 'support@example.com',
    });
    expect(returnRowsOf(withoutRecord.entries)[0]).toMatchObject({ kind: 'decline', actorEmail: null });
  });

  it('お断りの理由の記号とお客様へのメッセージは、履歴に出さない（細目は空）', () => {
    const history = buildOrderHistory(input({
      returns: [requestedReturn({
        status: 'declined', declinedAt: '2026-10-14T03:00:00.000Z', declineReason: 'final_sale', declineMessage: 'お客様向けのメッセージ',
      })],
    }));

    const json = JSON.stringify(history.entries);
    expect(json).not.toContain('お客様向けのメッセージ');
    expect(json).not.toContain('final_sale');
    expect(returnRowsOf(history.entries).every((entry) => entry.details.length === 0)).toBe(true);
  });

  it('お店が作った返品（申し込みの時刻が無い）は、承認の時刻が入っていても「返品の申し込みを承認した」の行を出さず、申し込み・お断りの行も出さず、「返品を作った」の1行だけ', () => {
    // 実物の形: 段1の admin_create_return は、お店が作った返品の承認の欄（approved_at・approved_by）に作った時刻と作った人を入れる
    const history = buildOrderHistory(input({
      returns: [returnDetail({
        source: 'shop', requestedAt: null, approvedAt: '2026-10-13T01:00:00.000Z', approvedByEmail: 'admin@example.com', declinedAt: null,
      })],
    }));

    expect(returnRowsOf(history.entries).map((entry) => entry.kind)).toEqual(['created']);
  });

  it('お店が作った返品と申し込みの返品が混ざる注文では、「返品の申し込みを承認した」の行は申し込みの返品の分だけ', () => {
    const shopReturn = returnDetail({
      id: 'ret-shop', label: 'ORD-A1B2C3D4-R2', source: 'shop',
      requestedAt: null, approvedAt: '2026-10-13T01:00:00.000Z', approvedByEmail: 'admin@example.com', declinedAt: null,
    });
    const customerReturn = requestedReturn({
      id: 'ret-customer', label: 'ORD-A1B2C3D4-R1', status: 'open', approvedAt: '2026-10-14T03:00:00.000Z', approvedByEmail: 'support@example.com',
    });

    const history = buildOrderHistory(input({ returns: [shopReturn, customerReturn] }));

    expect(returnRowsOf(history.entries).filter((entry) => entry.kind === 'approve').map((entry) => entry.id)).toEqual(['approve:ret-customer']);
    expect(returnRowsOf(history.entries).filter((entry) => entry.kind === 'created').map((entry) => entry.id)).toEqual(['created:ret-shop']);
  });

  it('同じ時刻の行は、結果が上に来る順（状態 → 返品の行 → 受付）のまま', () => {
    const at = '2026-10-14T01:00:00.000Z';
    const history = buildOrderHistory(input({
      statusRows: [{
        changedAt: at, fromStatus: 'shipped', toStatus: 'paid', changeReason: 'return_exchange_added',
        actorEmail: null, shippingCarrier: null, trackingNumber: null, cancelReason: null,
      }],
      returns: [requestedReturn({ requestedAt: at })],
    }));

    expect(history.entries.map((entry) => entry.type)).toEqual(['status', 'return', 'created']);
  });
});

describe('buildOrderHistory - キャンセルの申し込み', () => {
  it('開いている申し込みは「キャンセルの申し込み」の行を、申し込みの時刻で出す。した人は出さない。返品の番号は持たない', () => {
    const history = buildOrderHistory(input({ cancelRequests: [cancelRequest()] }));

    expect(returnRowsOf(history.entries)).toEqual([{
      type: 'return', kind: 'cancel_request', id: 'cancel-request:cr-1', at: '2026-10-14T02:00:00.000Z', returnId: null,
      title: 'キャンセルの申し込み', details: [], actorEmail: null,
    }]);
  });

  it('お断りした申し込みは「キャンセルの申し込みをお断りした」の行を、お断りの時刻とした人のメールで出す', () => {
    const history = buildOrderHistory(input({
      cancelRequests: [cancelRequest({
        status: 'declined', declineReason: 'other', declineMessage: 'お客様向けのメッセージ',
        declinedAt: '2026-10-14T03:00:00.000Z', declinedByEmail: 'admin@example.com',
      })],
    }));

    expect(returnRowsOf(history.entries).map((entry) => [entry.kind, entry.id, entry.title, entry.actorEmail])).toEqual([
      ['cancel_request_decline', 'cancel-request-decline:cr-1', 'キャンセルの申し込みをお断りした', 'admin@example.com'],
      ['cancel_request', 'cancel-request:cr-1', 'キャンセルの申し込み', null],
    ]);
    expect(JSON.stringify(history.entries)).not.toContain('お客様向けのメッセージ');
  });

  it('解決済みにした申し込みは「キャンセルの申し込みを解決済みにした」の行を、した人のメールで出す', () => {
    const history = buildOrderHistory(input({
      cancelRequests: [cancelRequest({ status: 'closed', closedAt: '2026-10-14T03:00:00.000Z', closedByEmail: 'support@example.com' })],
    }));

    expect(returnRowsOf(history.entries)[0]).toEqual({
      type: 'return', kind: 'cancel_request_close', id: 'cancel-request-close:cr-1', at: '2026-10-14T03:00:00.000Z', returnId: null,
      title: 'キャンセルの申し込みを解決済みにした', details: [], actorEmail: 'support@example.com',
    });
  });

  it('解決した申し込みは、品を外した返金があれば（返金）、取消の確かめなら（キャンセル）の行を出す', () => {
    const byRefund = buildOrderHistory(input({
      cancelRequests: [cancelRequest({
        status: 'resolved', resolvedAt: '2026-10-14T03:00:00.000Z', resolvedByEmail: 'admin@example.com',
        resolvedRefundId: 'refund-1',
      })],
    }));
    const byCancel = buildOrderHistory(input({
      cancelRequests: [cancelRequest({
        status: 'resolved', resolvedAt: '2026-10-14T03:00:00.000Z', resolvedByEmail: 'admin@example.com',
        resolvedByCancelAt: '2026-10-14T02:59:00.000Z',
      })],
    }));

    expect(returnRowsOf(byRefund.entries)[0]).toEqual({
      type: 'return', kind: 'cancel_request_resolve', id: 'cancel-request-resolve:cr-1', at: '2026-10-14T03:00:00.000Z', returnId: null,
      title: 'キャンセルの申し込みを解決した（返金）', details: [], actorEmail: 'admin@example.com',
    });
    expect(returnRowsOf(byCancel.entries)[0]).toMatchObject({
      kind: 'cancel_request_resolve', title: 'キャンセルの申し込みを解決した（キャンセル）',
    });
  });

  it('申し込みが2つ（古い物は解決済み、新しい物は開いている）あれば、全部の行を新しい順に並べる。行の番号は重ならない', () => {
    const history = buildOrderHistory(input({
      cancelRequests: [
        cancelRequest({ id: 'cr-2', requestedAt: '2026-10-14T05:00:00.000Z' }),
        cancelRequest({ id: 'cr-1', status: 'closed', closedAt: '2026-10-14T03:00:00.000Z', closedByEmail: 'admin@example.com' }),
      ],
    }));

    const rows = returnRowsOf(history.entries);
    expect(rows.map((entry) => entry.id)).toEqual(['cancel-request:cr-2', 'cancel-request-close:cr-1', 'cancel-request:cr-1']);
    expect(new Set(rows.map((entry) => entry.id)).size).toBe(rows.length);
  });

  it('キャンセルの申し込みと返品の申し込みの行は、同じ注文の履歴に混ざって新しい順に並び、いちばん下は注文の受付', () => {
    const history = buildOrderHistory(input({
      returns: [requestedReturn({ requestedAt: '2026-10-14T01:00:00.000Z' })],
      cancelRequests: [cancelRequest({ requestedAt: '2026-10-14T02:00:00.000Z' })],
    }));

    expect(history.entries.map((entry) => (entry.type === 'return' ? entry.kind : entry.type))).toEqual([
      'cancel_request', 'request', 'created',
    ]);
  });
});
