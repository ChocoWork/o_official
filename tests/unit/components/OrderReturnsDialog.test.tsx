import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { OrderReturnsData } from '@/components/OrderReturnsDialog';
import type { OrderReturnDetail, OrderReturnLineDetail } from '@/lib/orders/returns/return-types';

const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));

/** Task 9 の操作の画面が受ける props（注文と返品の番号だけ）。この試験では代役にして、渡した物と呼び戻しだけを確かめる */
type MockSubProps = {
  orderId: string;
  returnId: string;
  onClose: () => void;
  onDone: (notice?: string) => void;
  onUncertain?: () => void;
};
type MockCreateProps = {
  orderId: string;
  onClose: () => void;
  onCreated: (result: { returnId: string; number: number; status: 'open'; replayed: boolean }, returnMethod: string) => void;
  onUncertain?: () => void;
};

function mockSubDialog(name: string, props: MockSubProps) {
  return (
    <div role="dialog" aria-label={`${name}の代役`} data-order-id={props.orderId} data-return-id={props.returnId}>
      <button type="button" onClick={() => props.onDone(`${name}を記録しました。`)}>{`${name}を完了`}</button>
      <button type="button" onClick={() => props.onDone()}>{`${name}を知らせなしで完了`}</button>
      <button type="button" onClick={() => props.onUncertain?.()}>{`${name}の答えが分からない`}</button>
      <button type="button" onClick={props.onClose}>{`${name}を閉じる`}</button>
    </div>
  );
}

jest.mock('@/components/OrderReturnReceiveDialog', () => ({
  __esModule: true,
  default: (props: MockSubProps) => mockSubDialog('受け取り', props),
}));
jest.mock('@/components/OrderReturnRefundDialog', () => ({
  __esModule: true,
  default: (props: MockSubProps) => mockSubDialog('額を決めて返金', props),
}));
jest.mock('@/components/OrderReturnActionDialogs', () => ({
  __esModule: true,
  OrderReturnInspectDialog: (props: MockSubProps) => mockSubDialog('検品', props),
  OrderReturnCancelDialog: (props: MockSubProps) => mockSubDialog('取消', props),
  OrderReturnReopenDialog: (props: MockSubProps) => mockSubDialog('開き直し', props),
  OrderReturnFeePaymentDialog: (props: MockSubProps) => mockSubDialog('手数料', props),
  OrderReturnReleaseExchangeDialog: (props: MockSubProps) => mockSubDialog('支払いを待たずに送る', props),
}));
jest.mock('@/components/OrderReturnCreateForm', () => ({
  __esModule: true,
  default: (props: MockCreateProps) => (
    <div role="dialog" aria-label="返品を作るの代役" data-order-id={props.orderId}>
      <button type="button" onClick={() => props.onCreated({ returnId: 'ret-new', number: 2, status: 'open', replayed: false }, 'customer_ships')}>
        作れた（返送あり）
      </button>
      <button type="button" onClick={() => props.onCreated({ returnId: 'ret-new', number: 2, status: 'open', replayed: false }, 'not_required')}>
        作れた（返送不要）
      </button>
      <button type="button" onClick={() => props.onUncertain?.()}>作れたか分からない</button>
      <button type="button" onClick={props.onClose}>作る画面を閉じる</button>
    </div>
  ),
}));

import OrderReturnsDialog from '@/components/OrderReturnsDialog';

type Progress = OrderReturnLineDetail['progress'];

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const RETURNS_URL = `/api/admin/orders/${ORDER_ID}/returns`;
const TITLE = '返品（ORD-A1B2C3D4）';
const LABEL = 'ORD-A1B2C3D4-R1';

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/** 返品の行。数は2点で、まだ何も受け取っていない */
function line(progress: Partial<Progress> = {}, overrides: Partial<OrderReturnLineDetail> = {}): OrderReturnLineDetail {
  return {
    id: 'line-1', fulfillmentId: 'ful-1', fulfillmentNumber: 1, orderItemId: 'item-blouse', itemName: 'シルクブラウス', color: '白', size: 'M',
    quantity: 2, reason: 'size_too_small', reasonNote: null, resolution: 'refund', exchange: null,
    progress: {
      restocked: 0, notRestocked: 0, pendingInspection: 0, sentBack: 0, missing: 0,
      processed: 0, unprocessed: 2, exchanged: 0, refundCovered: 0, refundWaived: 0, refundWaiting: 0, ...progress,
    },
    refundAmountsByCount: [12000, 24000], refundWaitingAmount: 0, customerNote: null, requestedResolution: null, requestedExchange: null, photos: [], returnIneligible: false,
    ...overrides,
  };
}

function receipt(): OrderReturnDetail['receipts'][number] {
  return { id: 'receipt-1', kind: 'receive', refundChoice: 'none', createdAt: '2026-10-12T02:00:00.000Z', actorEmail: 'staff@example.com' };
}

const EXCHANGE_ITEM: OrderReturnDetail['exchangeItems'][number] = {
  orderItemId: 'item-exchange', itemName: 'シルクブラウス', color: '白', size: 'L', quantity: 1, fulfillmentType: 'stock', shipped: 0,
};

/** 受付中で、何も受け取っていない返品 */
function returnDetail(overrides: Partial<OrderReturnDetail> = {}): OrderReturnDetail {
  return {
    id: 'ret-1', number: 1, label: LABEL, status: 'open', source: 'shop', displayStatus: 'in_progress', marks: ['awaiting_items'],
    returnMethod: 'customer_ships', returnShippingPayer: 'customer', returnCarrier: null, returnTrackingNumber: null,
    fees: {
      returnShippingFee: 0, restockingFeePercent: 0, exchangeFee: 0, exchangeShippingFee: 0,
      feeDueAmount: 0, feePendingDeduction: 0, feeReceivedAt: null, exchangeReleasedAt: null,
    },
    firstReceiptDone: false, firstExchangeReceiptDone: false, shopNote: null, notifyCustomer: true,
    createdAt: '2026-10-12T01:00:00.000Z', createdByEmail: 'staff@example.com', closedAt: null, cancelledAt: null, requestedAt: null, approvedAt: null, approvedByEmail: null, declinedAt: null, declineReason: null, declineMessage: null,
    lines: [line()], refunds: [], receipts: [], exchangeItems: [],
    ...overrides,
  };
}

function returnsBody(overrides: Partial<OrderReturnsData> = {}): { data: OrderReturnsData } {
  return {
    data: {
      returns: [returnDetail()], canRefund: true, returnableUnits: 3, refundableAmount: 24000, refundableShipping: 800,
      inspectionEnabled: false, ...overrides,
    },
  };
}

/**
 * 画面を開き、返品の中身を読み終えるまで待つ（読み込み中の文が消える）。
 * canRefund は管理画面が渡す「店長か」（窓口の答えの canRefund とは別。両方が真の時だけ返金に関わるボタンを出す）
 */
async function openDialog(body: { data: OrderReturnsData } = returnsBody(), { canRefund = true }: { canRefund?: boolean } = {}) {
  mockClientFetch.mockResolvedValueOnce(json(body));
  const props = { onClose: jest.fn(), onChanged: jest.fn() };
  const utils = render(<OrderReturnsDialog orderId={ORDER_ID} canRefund={canRefund} open {...props} />);
  const dialog = await screen.findByRole('dialog', { name: TITLE });
  await waitFor(() => expect(within(dialog).queryByText('読み込み中です...')).not.toBeInTheDocument());
  return { ...utils, ...props, dialog };
}

const card = (dialog: HTMLElement, label = LABEL) => within(dialog).getByRole('group', { name: label });
const buttonNames = (scope: HTMLElement) => within(scope).queryAllByRole('button').map((button) => button.textContent);

beforeEach(() => {
  mockClientFetch.mockReset();
});

describe('OrderReturnsDialog の返品の一覧', () => {
  it('開くと返品の中身を読み、返品ごとに番号・状態・印・品・理由・解決を出す。下に返品できる品の数と「返品を作る」', async () => {
    const { dialog } = await openDialog();

    expect(mockClientFetch).toHaveBeenCalledWith(RETURNS_URL, { cache: 'no-store' });
    const first = card(dialog);
    expect(within(first).getByText(LABEL)).toBeInTheDocument();
    expect(within(first).getByText('返品中')).toBeInTheDocument();
    expect(within(first).getByText('受け取り待ち')).toBeInTheDocument();
    expect(within(first).getByText('シルクブラウス（白 / M） × 2')).toBeInTheDocument();
    expect(within(first).getByText('理由: サイズが小さい')).toBeInTheDocument();
    expect(within(first).getByText('返金')).toBeInTheDocument();
    // 何も処理していない間は、処理の数も、お支払い待ちも、返金も出さない
    expect(within(first).queryByText(/受け取り済み|届かない|お返し|お支払い待ち/)).not.toBeInTheDocument();
    expect(within(dialog).getByText('返品できる品: あと3点')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '返品を作る' })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: '閉じる' })).toBeEnabled();
  });

  it('返品の状態と小さな印は、返品ごとに言葉を変えて出す', async () => {
    const { dialog } = await openDialog(
      returnsBody({
        returns: [
          returnDetail({ displayStatus: 'refund_waiting', marks: [] }),
          returnDetail({
            id: 'ret-2', number: 2, label: 'ORD-A1B2C3D4-R2', displayStatus: 'in_progress',
            marks: ['partially_received', 'pending_inspection', 'awaiting_fee'],
          }),
          returnDetail({ id: 'ret-3', number: 3, label: 'ORD-A1B2C3D4-R3', status: 'closed', displayStatus: 'returned', marks: [] }),
        ],
      }),
    );

    expect(within(card(dialog)).getByText('返金待ち')).toBeInTheDocument();
    const second = card(dialog, 'ORD-A1B2C3D4-R2');
    expect(within(second).getByText('返品中')).toBeInTheDocument();
    expect(within(second).getByText('一部受け取り')).toBeInTheDocument();
    expect(within(second).getByText('検品待ち')).toBeInTheDocument();
    expect(within(second).getByText('お支払い待ち')).toBeInTheDocument();
    expect(within(card(dialog, 'ORD-A1B2C3D4-R3')).getByText('返品済み')).toBeInTheDocument();
  });

  it('交換の行は、色・サイズと送り方を出す。理由のメモがあれば理由に添える', async () => {
    const exchange = { variantId: 102, color: '白', size: 'L', stockQuantity: 4, madeToOrderLeadDays: 14, outOfStockExchange: 'make' as const };
    const { dialog } = await openDialog(
      returnsBody({
        returns: [
          returnDetail({
            lines: [
              line({}, { id: 'line-1', resolution: 'exchange', exchange: { ...exchange, method: 'stock' } }),
              line({}, {
                id: 'line-2', orderItemId: 'item-pants', itemName: 'ウールパンツ', color: null, size: '2', quantity: 1,
                reason: 'other', reasonNote: '袖が短い', resolution: 'exchange', exchange: { ...exchange, method: 'make' },
              }),
            ],
          }),
        ],
      }),
    );

    const first = card(dialog);
    expect(within(first).getByText('交換: 白 / L（在庫から）')).toBeInTheDocument();
    expect(within(first).getByText('ウールパンツ（2） × 1')).toBeInTheDocument();
    expect(within(first).getByText('理由: その他（袖が短い）')).toBeInTheDocument();
    expect(within(first).getByText('交換: 白 / L（作って送る）')).toBeInTheDocument();
  });

  it('処理の数は、受け取り済み（戻した＋戻さなかった）・届かない・お返し・検品待ちを、0点の物を除いて出す', async () => {
    const { dialog } = await openDialog(
      returnsBody({
        returns: [
          returnDetail({
            lines: [
              line({ restocked: 1, notRestocked: 1, pendingInspection: 1, sentBack: 1, missing: 1, processed: 5, unprocessed: 1 }, { quantity: 6 }),
            ],
            receipts: [receipt()],
          }),
        ],
      }),
    );

    const first = card(dialog);
    expect(within(first).getByText('受け取り済み 2点')).toBeInTheDocument();
    expect(within(first).getByText('届かない 1点')).toBeInTheDocument();
    expect(within(first).getByText('お返し 1点')).toBeInTheDocument();
    expect(within(first).getByText('検品待ち 1点')).toBeInTheDocument();
  });

  it('交換にした数・返金しないことにした数は、受け取り済みの数に足さず、別の言葉も出さない（受け取り済みの中の数）', async () => {
    const { dialog } = await openDialog(
      returnsBody({
        returns: [
          returnDetail({
            lines: [line({ restocked: 2, processed: 2, unprocessed: 0, exchanged: 2, refundWaived: 2 })],
            receipts: [receipt(), { ...receipt(), id: 'receipt-2', kind: 'waive_refund', refundChoice: null }],
          }),
        ],
      }),
    );

    const first = card(dialog);
    expect(within(first).getByText('受け取り済み 2点')).toBeInTheDocument();
    expect(within(first).queryByText(/交換にした|返金しない|返金なし/)).not.toBeInTheDocument();
    expect(within(first).queryByText(/4点/)).not.toBeInTheDocument();
  });

  it('お支払い待ちの手数料と、返金（額と状態）を出す', async () => {
    const { dialog } = await openDialog(
      returnsBody({
        returns: [
          returnDetail({
            fees: {
              returnShippingFee: 0, restockingFeePercent: 0, exchangeFee: 1000, exchangeShippingFee: 500,
              feeDueAmount: 1500, feePendingDeduction: 0, feeReceivedAt: null, exchangeReleasedAt: null,
            },
            refunds: [
              { id: 'refund-1', amount: 12000, status: 'succeeded', createdAt: '2026-10-12T02:00:00.000Z' },
              { id: 'refund-2', amount: 800, status: 'pending', createdAt: '2026-10-12T03:00:00.000Z' },
            ],
          }),
        ],
      }),
    );

    const first = card(dialog);
    expect(within(first).getByText('お支払い待ち ￥1,500')).toBeInTheDocument();
    expect(within(first).getByText('返金 ￥12,000（成功）')).toBeInTheDocument();
    expect(within(first).getByText('返金 ￥800（保留）')).toBeInTheDocument();
  });

  it('返金が失敗して返金待ちに戻った完了済みの返品は、返金待ちの印と失敗した返金の行を出し、返品済みとは出さない（P21）', async () => {
    const { dialog } = await openDialog(returnsBody({ returns: [CLOSED_REFUND_FAILED] }));

    const first = card(dialog);
    expect(within(first).getByText('返金待ち')).toBeInTheDocument();
    expect(within(first).getByText('返金 ￥24,000（失敗）')).toBeInTheDocument();
    expect(within(first).queryByText('返品済み')).not.toBeInTheDocument();
  });

  it('手数料を受け取り済みなら、お支払い待ちは出さない', async () => {
    const { dialog } = await openDialog(
      returnsBody({
        returns: [
          returnDetail({
            fees: {
              returnShippingFee: 0, restockingFeePercent: 0, exchangeFee: 1000, exchangeShippingFee: 500,
              feeDueAmount: 1500, feePendingDeduction: 0, feeReceivedAt: '2026-10-12T05:00:00.000Z', exchangeReleasedAt: null,
            },
          }),
        ],
      }),
    );

    expect(within(card(dialog)).queryByText(/お支払い待ち/)).not.toBeInTheDocument();
  });

  it('返品が無い注文は、その文と、下の一行と「返品を作る」を出す', async () => {
    const { dialog } = await openDialog(returnsBody({ returns: [], returnableUnits: 2 }));

    expect(within(dialog).getByText('この注文にはまだ返品がありません。')).toBeInTheDocument();
    expect(within(dialog).getByText('返品できる品: あと2点')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '返品を作る' })).toBeEnabled();
  });

  it('取消・お断りの返品は出さない。出せる返品が無ければ、返品が無い時の文を出す', async () => {
    const mixed = await openDialog(
      returnsBody({
        returns: [
          returnDetail({ status: 'cancelled', displayStatus: null, marks: [], cancelledAt: '2026-10-12T04:00:00.000Z' }),
          returnDetail({ id: 'ret-2', number: 2, label: 'ORD-A1B2C3D4-R2' }),
        ],
      }),
    );
    expect(within(mixed.dialog).queryByRole('group', { name: LABEL })).not.toBeInTheDocument();
    expect(card(mixed.dialog, 'ORD-A1B2C3D4-R2')).toBeInTheDocument();
    mixed.unmount();

    mockClientFetch.mockReset();
    const onlyHidden = await openDialog(
      returnsBody({
        returns: [
          returnDetail({ status: 'cancelled', displayStatus: null, marks: [] }),
          returnDetail({ id: 'ret-2', number: 2, label: 'ORD-A1B2C3D4-R2', status: 'declined', displayStatus: null, marks: [] }),
        ],
      }),
    );
    expect(within(onlyHidden.dialog).queryAllByRole('group')).toHaveLength(0);
    expect(within(onlyHidden.dialog).getByText('この注文にはまだ返品がありません。')).toBeInTheDocument();
  });

  it('返品できる品が0点なら、「返品を作る」を押せなくする', async () => {
    const { dialog } = await openDialog(returnsBody({ returnableUnits: 0 }));

    expect(within(dialog).getByText('返品できる品: あと0点')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '返品を作る' })).toBeDisabled();
  });

  it('読み込んでいる間は「読み込み中です...」と「閉じる」だけを出す', async () => {
    mockClientFetch.mockReturnValueOnce(new Promise(() => undefined));
    render(<OrderReturnsDialog orderId={ORDER_ID} canRefund open onClose={jest.fn()} onChanged={jest.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: TITLE });
    expect(within(dialog).getByText('読み込み中です...')).toBeInTheDocument();
    expect(buttonNames(dialog)).toEqual(['閉じる']);
  });

  it.each([
    [404, { error: '注文が見つかりません。', code: 'order_not_found' }, '注文が見つかりません。'],
    [403, { error: 'Forbidden' }, 'この操作の権限がありません。'],
    [500, { error: 'x', code: 'failed' }, '返品の情報を読み込めませんでした。'],
  ])('返品の中身を読めなかった時（%i）は理由と「閉じる」だけを出す', async (status, body, message) => {
    mockClientFetch.mockResolvedValueOnce(json(body, status));
    const onClose = jest.fn();
    render(<OrderReturnsDialog orderId={ORDER_ID} canRefund open onClose={onClose} onChanged={jest.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: TITLE });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
    expect(buttonNames(dialog)).toEqual(['閉じる']);
    expect(within(dialog).queryByText(/返品できる品/)).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('open が偽の間は閉じていて、窓口を読まない。真にするたびに、中身を読み直す', async () => {
    const props = { orderId: ORDER_ID, canRefund: true, onClose: jest.fn(), onChanged: jest.fn() };
    const { rerender } = render(<OrderReturnsDialog {...props} open={false} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockClientFetch).not.toHaveBeenCalled();

    mockClientFetch.mockResolvedValueOnce(json(returnsBody())).mockResolvedValueOnce(json(returnsBody({ returns: [] })));
    rerender(<OrderReturnsDialog {...props} open />);
    const dialog = await screen.findByRole('dialog', { name: TITLE });
    await waitFor(() => expect(within(dialog).getByRole('group', { name: LABEL })).toBeInTheDocument());

    rerender(<OrderReturnsDialog {...props} open={false} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    rerender(<OrderReturnsDialog {...props} open />);
    const reopened = await screen.findByRole('dialog', { name: TITLE });
    expect(await within(reopened).findByText('この注文にはまだ返品がありません。')).toBeInTheDocument();
    expect(mockClientFetch).toHaveBeenCalledTimes(2);
  });

  it('スマホの幅（768px 未満）では画面いっぱいに開く指定を付ける。Esc と「閉じる」で閉じる', async () => {
    const { dialog, onClose } = await openDialog();

    expect(dialog.closest('[data-ui-dialog]')).toHaveAttribute('data-ui-dialog-fullscreen', 'mobile');
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

const NEEDS_RECEIVE = returnDetail();
const PARTLY_RECEIVED = returnDetail({
  marks: ['partially_received'],
  lines: [line({ restocked: 1, processed: 1, unprocessed: 1 })],
  receipts: [receipt()],
});
const ALL_PROCESSED = returnDetail({
  lines: [line({ restocked: 2, processed: 2, unprocessed: 0 })],
  receipts: [receipt()],
});
const PENDING_INSPECTION = returnDetail({
  marks: ['pending_inspection'],
  lines: [line({ pendingInspection: 2, processed: 2, unprocessed: 0 })],
  receipts: [receipt()],
});
const REFUND_WAITING = returnDetail({
  displayStatus: 'refund_waiting',
  marks: [],
  lines: [line({ restocked: 2, processed: 2, unprocessed: 0, refundWaiting: 2 })],
  receipts: [receipt()],
});
const RECEIVE_AND_REFUND = returnDetail({
  lines: [line({ restocked: 1, processed: 1, unprocessed: 1, refundWaiting: 1 })],
  receipts: [receipt()],
});

function awaitingFee(overrides: Partial<OrderReturnDetail['fees']> = {}, exchangeItems: OrderReturnDetail['exchangeItems'] = [EXCHANGE_ITEM]) {
  return returnDetail({
    marks: ['awaiting_fee'],
    lines: [line({ restocked: 2, processed: 2, unprocessed: 0 })],
    receipts: [receipt()],
    fees: {
      returnShippingFee: 0, restockingFeePercent: 0, exchangeFee: 1000, exchangeShippingFee: 500,
      feeDueAmount: 1500, feePendingDeduction: 0, feeReceivedAt: null, exchangeReleasedAt: null, ...overrides,
    },
    exchangeItems,
  });
}

const CLOSED_WITH_MISSING = returnDetail({
  status: 'closed',
  displayStatus: 'returned',
  marks: [],
  lines: [line({ restocked: 1, missing: 1, processed: 2, unprocessed: 0 })],
  receipts: [receipt()],
});
const CLOSED_COMPLETE = returnDetail({
  status: 'closed',
  displayStatus: 'returned',
  marks: [],
  lines: [line({ restocked: 2, processed: 2, unprocessed: 0 })],
  receipts: [receipt()],
});
/** 完了した返品の返金が後で失敗し、覆いが外れて返金待ちの品が戻った（P21）。記録の状態は完了のまま、画面の状態は返金待ち */
const CLOSED_REFUND_FAILED = returnDetail({
  status: 'closed',
  displayStatus: 'refund_waiting',
  marks: [],
  closedAt: '2026-10-12T04:00:00.000Z',
  lines: [line({ restocked: 2, processed: 2, unprocessed: 0, refundWaiting: 2 })],
  receipts: [receipt()],
  refunds: [{ id: 'refund-1', amount: 24000, status: 'failed', createdAt: '2026-10-12T02:00:00.000Z' }],
});

// [名前, 返品, 店長（額を決めて返金できる人）か, 返品の欄に出るボタン（並びも含む）]
const ACTION_CASES: Array<[string, OrderReturnDetail, boolean, string[]]> = [
  ['何も受け取っていない受付中は、受け取る・取り消す', NEEDS_RECEIVE, true, ['受け取る', '返品を取り消す']],
  ['一部を受け取った受付中は、受け取るだけ（取消は出ない）', PARTLY_RECEIVED, true, ['受け取る']],
  [
    '「届かない」で終えて開き直し、まだ何も受け取っていない受付中は、受け取る・取り消す（DB は処理した数だけを見る）',
    returnDetail({
      receipts: [
        { ...receipt(), kind: 'close_missing', refundChoice: null },
        { ...receipt(), id: 'receipt-2', kind: 'reopen', refundChoice: null },
      ],
    }),
    true,
    ['受け取る', '返品を取り消す'],
  ],
  ['全部の品を処理した受付中は、受け取るを出さない', ALL_PROCESSED, true, []],
  ['検品待ちがあれば、検品を終える', PENDING_INSPECTION, true, ['検品を終える']],
  ['受け取って返金していない品があれば、店長に額を決めて返金する', REFUND_WAITING, true, ['額を決めて返金する']],
  ['サポートには額を決めて返金するを出さない', REFUND_WAITING, false, []],
  ['受け取る品と返金待ちの品が両方あれば、受け取る・額を決めて返金するの順', RECEIVE_AND_REFUND, true, ['受け取る', '額を決めて返金する']],
  ['お支払い待ちで交換の品があれば、店長に手数料の記録と支払いを待たずに送る', awaitingFee(), true, ['手数料の受け取りを記録する', '支払いを待たずに送る']],
  ['お支払い待ちで交換の品が無ければ、手数料の記録だけ', awaitingFee({}, []), true, ['手数料の受け取りを記録する']],
  [
    '支払いを待たずに送ると決めた後は、手数料の記録だけ',
    awaitingFee({ exchangeReleasedAt: '2026-10-12T06:00:00.000Z' }),
    true,
    ['手数料の受け取りを記録する'],
  ],
  ['サポートには手数料の記録も支払いを待たずに送るも出さない', awaitingFee(), false, []],
  ['手数料を受け取り済みなら、手数料のボタンを出さない', awaitingFee({ feeReceivedAt: '2026-10-12T05:00:00.000Z' }), true, []],
  ['完了した返品に届かない品があれば、開き直す', CLOSED_WITH_MISSING, true, ['開き直す']],
  ['届かない品が無い完了した返品には、何も出さない', CLOSED_COMPLETE, true, []],
  ['返金が失敗して返金待ちに戻った完了済みの返品は、店長に額を決めて返金するを出す（P21）', CLOSED_REFUND_FAILED, true, ['額を決めて返金する']],
  ['返金待ちに戻った完了済みの返品も、サポートには何も出さない', CLOSED_REFUND_FAILED, false, []],
];

describe('OrderReturnsDialog の状態ごとのボタン', () => {
  it.each(ACTION_CASES)('%s', async (_name, detail, canRefund, expected) => {
    const { dialog } = await openDialog(returnsBody({ returns: [detail], canRefund }));

    expect(buttonNames(card(dialog))).toEqual(expected);
  });

  it('管理画面が canRefund を偽で渡す（店長でない）時は、窓口の答えが真でも、返金に関わるボタンを出さない。受け取りなどは出す', async () => {
    const { dialog } = await openDialog(returnsBody({ returns: [RECEIVE_AND_REFUND, { ...awaitingFee(), id: 'ret-2', label: 'ORD-A1B2C3D4-R2' }], canRefund: true }), {
      canRefund: false,
    });

    expect(buttonNames(card(dialog))).toEqual(['受け取る']);
    expect(buttonNames(card(dialog, 'ORD-A1B2C3D4-R2'))).toEqual([]);
  });
});

// [押すボタン, 開く画面の代役の名前, 返品]
const OPEN_CASES: Array<[string, string, OrderReturnDetail]> = [
  ['受け取る', '受け取り', NEEDS_RECEIVE],
  ['返品を取り消す', '取消', NEEDS_RECEIVE],
  ['検品を終える', '検品', PENDING_INSPECTION],
  ['額を決めて返金する', '額を決めて返金', REFUND_WAITING],
  ['額を決めて返金する', '額を決めて返金', CLOSED_REFUND_FAILED],
  ['手数料の受け取りを記録する', '手数料', awaitingFee()],
  ['支払いを待たずに送る', '支払いを待たずに送る', awaitingFee()],
  ['開き直す', '開き直し', CLOSED_WITH_MISSING],
];

describe('OrderReturnsDialog から操作の画面を開く', () => {
  it.each(OPEN_CASES)('「%s」を押すと、返品の欄を隠して「%s」の画面を、注文と返品の番号つきで開く', async (buttonName, screenName, detail) => {
    const { dialog } = await openDialog(returnsBody({ returns: [detail] }));

    fireEvent.click(within(card(dialog)).getByRole('button', { name: buttonName }));

    const opened = await screen.findByRole('dialog', { name: `${screenName}の代役` });
    expect(opened).toHaveAttribute('data-order-id', ORDER_ID);
    expect(opened).toHaveAttribute('data-return-id', 'ret-1');
    // 画面は同時に1つだけ（重ねると Esc で下の画面が閉じる）
    expect(screen.queryByRole('dialog', { name: TITLE })).not.toBeInTheDocument();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('操作の画面が終わると、返品の欄に戻り、知らせを出し、中身を読み直して、親に伝える', async () => {
    const { dialog, onChanged } = await openDialog();
    mockClientFetch.mockResolvedValueOnce(json(returnsBody({ returns: [ALL_PROCESSED] })));
    fireEvent.click(within(card(dialog)).getByRole('button', { name: '受け取る' }));
    fireEvent.click(await screen.findByRole('button', { name: '受け取りを完了' }));

    const reopened = await screen.findByRole('dialog', { name: TITLE });
    expect(within(reopened).getByRole('status')).toHaveTextContent('受け取りを記録しました。');
    expect(onChanged).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(within(card(reopened)).getByText('受け取り済み 2点')).toBeInTheDocument());
    expect(mockClientFetch).toHaveBeenCalledTimes(2);
    expect(mockClientFetch).toHaveBeenNthCalledWith(2, RETURNS_URL, { cache: 'no-store' });
  });

  it('知らせの文が無いまま終わった時は、知らせを出さずに読み直す', async () => {
    const { dialog, onChanged } = await openDialog();
    mockClientFetch.mockResolvedValueOnce(json(returnsBody()));
    fireEvent.click(within(card(dialog)).getByRole('button', { name: '返品を取り消す' }));
    fireEvent.click(await screen.findByRole('button', { name: '取消を知らせなしで完了' }));

    const reopened = await screen.findByRole('dialog', { name: TITLE });
    expect(within(reopened).queryByRole('status')).not.toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('操作の後の読み直しが失敗したら、古い返品と操作のボタンを消し、閉じるだけを出す', async () => {
    const { dialog } = await openDialog();
    mockClientFetch.mockResolvedValueOnce(json({ error: 'x', code: 'failed' }, 500));
    fireEvent.click(within(card(dialog)).getByRole('button', { name: '受け取る' }));
    fireEvent.click(await screen.findByRole('button', { name: '受け取りを完了' }));

    const reopened = await screen.findByRole('dialog', { name: TITLE });
    expect(await within(reopened).findByRole('alert')).toHaveTextContent('返品の情報を読み込めませんでした。');
    expect(buttonNames(reopened)).toEqual(['閉じる']);
    expect(within(reopened).queryAllByRole('group')).toHaveLength(0);
    expect(within(reopened).queryByText(/返品できる品/)).not.toBeInTheDocument();
    expect(within(reopened).getByRole('status')).toHaveTextContent('受け取りを記録しました。');
  });

  it('何もせずに閉じた時も返品の欄に戻って中身を読み直すが、親には伝えない', async () => {
    const { dialog, onChanged } = await openDialog();
    mockClientFetch.mockResolvedValueOnce(json(returnsBody()));
    fireEvent.click(within(card(dialog)).getByRole('button', { name: '受け取る' }));
    fireEvent.click(await screen.findByRole('button', { name: '受け取りを閉じる' }));

    const reopened = await screen.findByRole('dialog', { name: TITLE });
    expect(within(reopened).queryByRole('status')).not.toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
    await waitFor(() => expect(mockClientFetch).toHaveBeenCalledTimes(2));
  });

  it('答えが分からないまま閉じた時は、閉じる前に親へ読み直しを頼む（返金や記録が行われたかもしれない）', async () => {
    const { dialog, onChanged } = await openDialog();
    mockClientFetch.mockResolvedValueOnce(json(returnsBody()));
    fireEvent.click(within(card(dialog)).getByRole('button', { name: '受け取る' }));
    fireEvent.click(await screen.findByRole('button', { name: '受け取りの答えが分からない' }));
    expect(onChanged).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: '受け取りを閉じる' }));
    await screen.findByRole('dialog', { name: TITLE });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('次の操作の画面を開く時に、前の知らせを消す', async () => {
    const { dialog } = await openDialog();
    mockClientFetch.mockResolvedValueOnce(json(returnsBody())).mockResolvedValueOnce(json(returnsBody()));
    fireEvent.click(within(card(dialog)).getByRole('button', { name: '受け取る' }));
    fireEvent.click(await screen.findByRole('button', { name: '受け取りを完了' }));
    const reopened = await screen.findByRole('dialog', { name: TITLE });
    expect(within(reopened).getByRole('status')).toBeInTheDocument();

    fireEvent.click(within(card(reopened)).getByRole('button', { name: '返品を取り消す' }));
    fireEvent.click(await screen.findByRole('button', { name: '取消を閉じる' }));

    const again = await screen.findByRole('dialog', { name: TITLE });
    expect(within(again).queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('OrderReturnsDialog から返品を作る画面を開く', () => {
  it('「返品を作る」を押すと、返品の欄を隠して返品を作る画面を、注文の番号つきで開く', async () => {
    const { dialog } = await openDialog();

    fireEvent.click(within(dialog).getByRole('button', { name: '返品を作る' }));

    const opened = await screen.findByRole('dialog', { name: '返品を作るの代役' });
    expect(opened).toHaveAttribute('data-order-id', ORDER_ID);
    expect(screen.queryByRole('dialog', { name: TITLE })).not.toBeInTheDocument();
  });

  it('返品を作れたら、返品の欄に戻り、「返品を作りました。」と出し、中身を読み直して、親に伝える', async () => {
    const { dialog, onChanged } = await openDialog();
    mockClientFetch.mockResolvedValueOnce(json(returnsBody({ returns: [NEEDS_RECEIVE, returnDetail({ id: 'ret-new', number: 2, label: 'ORD-A1B2C3D4-R2' })] })));
    fireEvent.click(within(dialog).getByRole('button', { name: '返品を作る' }));
    fireEvent.click(await screen.findByRole('button', { name: '作れた（返送あり）' }));

    const reopened = await screen.findByRole('dialog', { name: TITLE });
    expect(within(reopened).getByRole('status')).toHaveTextContent('返品を作りました。');
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(await within(reopened).findByRole('group', { name: 'ORD-A1B2C3D4-R2' })).toBeInTheDocument();
    expect(mockClientFetch).toHaveBeenNthCalledWith(2, RETURNS_URL, { cache: 'no-store' });
  });

  it('返送不要の返品を作れたら、すぐ受け取りの画面を、作った返品の番号つきで開く', async () => {
    const { dialog, onChanged } = await openDialog();
    // 読み直しは2回（作れた時と、受け取りの画面を閉じた時）
    mockClientFetch.mockResolvedValueOnce(json(returnsBody())).mockResolvedValueOnce(json(returnsBody()));
    fireEvent.click(within(dialog).getByRole('button', { name: '返品を作る' }));
    fireEvent.click(await screen.findByRole('button', { name: '作れた（返送不要）' }));

    const receive = await screen.findByRole('dialog', { name: '受け取りの代役' });
    expect(receive).toHaveAttribute('data-order-id', ORDER_ID);
    expect(receive).toHaveAttribute('data-return-id', 'ret-new');
    expect(screen.queryByRole('dialog', { name: TITLE })).not.toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);

    // 受け取りの画面を閉じれば返品の欄に戻り、「返品を作りました。」が残っている
    fireEvent.click(screen.getByRole('button', { name: '受け取りを閉じる' }));
    const reopened = await screen.findByRole('dialog', { name: TITLE });
    expect(within(reopened).getByRole('status')).toHaveTextContent('返品を作りました。');
  });

  it('作れたか分からないまま閉じた時は、親へ読み直しを頼む。何もせずに閉じた時は頼まない', async () => {
    const { dialog, onChanged } = await openDialog();
    mockClientFetch.mockResolvedValueOnce(json(returnsBody())).mockResolvedValueOnce(json(returnsBody()));
    fireEvent.click(within(dialog).getByRole('button', { name: '返品を作る' }));
    fireEvent.click(await screen.findByRole('button', { name: '作る画面を閉じる' }));
    await screen.findByRole('dialog', { name: TITLE });
    expect(onChanged).not.toHaveBeenCalled();

    fireEvent.click(within(screen.getByRole('dialog', { name: TITLE })).getByRole('button', { name: '返品を作る' }));
    fireEvent.click(await screen.findByRole('button', { name: '作れたか分からない' }));
    expect(onChanged).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '作る画面を閉じる' }));
    await screen.findByRole('dialog', { name: TITLE });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});
