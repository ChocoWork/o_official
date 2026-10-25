import { fireEvent, render, screen, within } from '@testing-library/react';
import OrderSection, { type OrderItem } from '@/components/OrderSection';
import type { OrderHistoryResponse } from '@/lib/orders/email/order-history';
import {
  LEGACY_FULFILLMENT_DISABLED_TEXT,
  MANUAL_COMPLETION_DISABLED_TEXT,
} from '@/lib/orders/fulfillment/legacy-fulfillment-disabled';

const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));

import OrderHistoryDialog from '@/components/OrderHistoryDialog';

/**
 * G-1 Task 15: 旧の発送・発送取消・伝票番号の訂正・手動の配達済み・仕上がりの手動記録と取消の画面の入口を撤去し、
 * 既存の注文一覧（OrderSection）と注文の履歴（OrderHistoryDialog）の中に、固定の案内を出す。
 * G-3: 発送・発送取消・伝票番号の訂正・手動の配達済みの案内は、荷作り表（注文一覧）と発送票（履歴）へ移った。仕上がりの手動記録は終了のまま。
 * 窓口が昔の形で canShip・canRecordCompletion・cancellable を true にしても、旧い入口は出さない。
 * 注文の取消・返金・返品・キャンセルの申し込み・履歴を開く・メールの再送は止めない。
 * FREQ-524-AC-03・FREQ-540（G-1 部分）・FREQ-533-AC-01（履歴からの票）の単体
 */

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const FULFILLMENT_ID = 'f1f1f1f1-1111-2222-8333-444455556666';

const LEGACY_ENTRY_NAMES = [
  '発送済みにする',
  '仕上がりを記録する',
  '伝票番号を直す',
  '配達済みにする',
  'この発送を取り消す',
  'この仕上がりを取り消す',
];

/** 窓口が昔の形で発送・仕上がりを「できる」と言ってきた注文（偽の canShip・canRecordCompletion） */
function legacyOrder(overrides: Partial<OrderItem> = {}): OrderItem {
  return {
    id: ORDER_ID,
    customerName: '山田 花子',
    customerEmail: 'hanako@example.com',
    orderDate: '2026-10-24',
    itemCount: '2点',
    items: [
      {
        id: 'line-blouse', name: 'シルクブラウス', color: '白', size: 'M', quantity: 1, fulfillmentType: 'stock',
        shipped: 0, inProduction: 0, readyUnshipped: 1,
      },
      {
        id: 'line-coat', name: 'ウールコート', color: '黒', size: 'L', quantity: 1, fulfillmentType: 'backorder',
        shipped: 0, inProduction: 1, readyUnshipped: 0,
      },
    ],
    totalAmount: '¥38,800',
    status: '受注生産中',
    orderStatus: 'paid',
    progressKey: 'in_production',
    canRefund: true,
    canShip: true,
    canRecordCompletion: true,
    canCancel: true,
    cancelKind: 'paid',
    cancelRequestOpen: true,
    returnSummary: {
      orderId: ORDER_ID, displayStatus: null, marks: [], nextAction: 'none',
      hasReturnable: true, refundWaitingReturns: 0, requestedReturns: 0,
    },
    ...overrides,
  };
}

function expectWraps(element: HTMLElement) {
  // 390/768/1280 のどの幅でも折り返す。折り返しを止める指定と、固定の幅を持たない
  expect(element.className).not.toMatch(/nowrap|truncate|\bw-\[|\bmin-w-|\bmax-w-/);
  expect(element.style.whiteSpace).toBe('');
  expect(element.style.width).toBe('');
}

describe('注文一覧: 旧の発送・仕上がりの入口を出さず、荷作り表への案内と仕上がりの停止の文を1回ずつ出す', () => {
  it('偽の canShip・canRecordCompletion でも「発送済みにする」「仕上がりを記録する」を出さない', () => {
    render(
      <OrderSection
        orders={[legacyOrder(), legacyOrder({ id: 'other-order', canShip: true, canRecordCompletion: true })]}
        onCancelOrder={jest.fn()}
        onRefundOrder={jest.fn()}
        onShowHistory={jest.fn()}
        onShowReturns={jest.fn()}
        onShowCancelRequest={jest.fn()}
      />,
    );

    for (const name of LEGACY_ENTRY_NAMES) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
  });

  it('FREQ-524-AC-03: 荷作り表への案内と仕上がりの停止の文を、注文が何件あっても一覧の表の上に1回ずつ出す。行の中には出さない', () => {
    render(<OrderSection orders={[legacyOrder(), legacyOrder({ id: 'other-order' })]} onShowHistory={jest.fn()} />);

    const guide = screen.getAllByText('発送は荷作り表から行います。');
    const manual = screen.getAllByText(MANUAL_COMPLETION_DISABLED_TEXT);
    expect(guide).toHaveLength(1);
    expect(manual).toHaveLength(1);
    const link = screen.getByRole('link', { name: '荷作り表を開く' });
    expect(link).toHaveAttribute('href', '/admin/packing');
    const table = screen.getByRole('table');
    // 案内 → 荷作り表を開く → 仕上がりの停止の文 の順で、どれも表の上
    expect(guide[0].compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(link.compareDocumentPosition(manual[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const element of [guide[0], link, manual[0]]) {
      expect(table.contains(element)).toBe(false);
      expect(element.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    for (const text of [guide[0], manual[0]]) expectWraps(text);
  });

  it('FREQ-524-AC-03: 旧い発送の停止の文は注文一覧に出さない', () => {
    render(<OrderSection orders={[legacyOrder()]} onShowHistory={jest.fn()} />);
    expect(screen.queryByText(LEGACY_FULFILLMENT_DISABLED_TEXT)).not.toBeInTheDocument();
  });

  it('FREQ-524-AC-03: 注文が0件でも案内と仕上がりの停止の文を1回ずつ出す。読み込み中は出さない', () => {
    const { rerender } = render(<OrderSection orders={[]} />);
    expect(screen.getAllByText('発送は荷作り表から行います。')).toHaveLength(1);
    expect(screen.getAllByRole('link', { name: '荷作り表を開く' })).toHaveLength(1);
    expect(screen.getAllByText(MANUAL_COMPLETION_DISABLED_TEXT)).toHaveLength(1);

    rerender(<OrderSection orders={[]} isLoading />);
    expect(screen.queryByText('発送は荷作り表から行います。')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '荷作り表を開く' })).not.toBeInTheDocument();
    expect(screen.queryByText(MANUAL_COMPLETION_DISABLED_TEXT)).not.toBeInTheDocument();
  });

  it('注文の取消・返金・返品・キャンセルの申し込み・履歴を開くは残り、押すと注文の番号を渡す', () => {
    const handlers = {
      onCancelOrder: jest.fn(),
      onRefundOrder: jest.fn(),
      onShowHistory: jest.fn(),
      onShowReturns: jest.fn(),
      onShowCancelRequest: jest.fn(),
    };
    render(<OrderSection orders={[legacyOrder()]} {...handlers} />);

    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
      '履歴', '返金', '返品', 'キャンセルの申し込み', 'キャンセル',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'ORD-A1B2C3D4 の履歴' }));
    fireEvent.click(screen.getByRole('button', { name: '返金' }));
    fireEvent.click(screen.getByRole('button', { name: '返品' }));
    fireEvent.click(screen.getByRole('button', { name: 'キャンセルの申し込み' }));
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    for (const handler of Object.values(handlers)) {
      expect(handler).toHaveBeenCalledWith(ORDER_ID);
    }
  });
});

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/** 窓口が昔の形で「取り消せる」「直せる」と言ってきた発送（偽の cancellable と、配達済みでない配送の現在値）とメールの行 */
function legacyHistory(): OrderHistoryResponse {
  return {
    order: { id: ORDER_ID, orderNumber: 'ORD-A1B2C3D4', statusLabel: '決済完了', recipient: 'hanako@example.com' },
    sendPaused: null,
    deliveryTrackingEnabled: true,
    entries: [
      {
        type: 'fulfillment', at: '2026-10-10T02:00:00.000Z', fulfillmentId: FULFILLMENT_ID, number: 1, carrierLabel: 'ヤマト運輸',
        trackingNumber: '1234-5678', items: [{ name: 'シルクブラウス', quantity: 1 }], actorEmail: 'admin@example.com',
        notifyCustomer: true, completesOrder: false, cancelled: false, cancellable: true, legacy: false, slipId: null, slipNumber: null,
        delivery: {
          fulfillmentId: FULFILLMENT_ID, number: 1, carrier: 'yamato', trackingNumber: '1234-5678', notifyCustomer: true,
          shippedAt: '2026-10-10T02:00:00.000Z', cancelledAt: null, trackingVersion: 1, deliveryStatus: 'in_transit',
          deliveryStatusAt: '2026-10-12T02:00:00.000Z', deliveredAt: null, deliveredSource: null,
          registration: { state: 'registered', failureKind: null, stopReason: null, expiresAt: '2026-11-09T02:00:00.000Z', everRegistered: true },
          events: [], trackingChanges: [],
        },
      },
      {
        type: 'email', at: '2026-10-09T01:00:00.000Z', emailId: 'email-1', kind: 'paid', kindLabel: '注文確認', manual: false,
        requestedByEmail: null, stateLabel: '送信済み', warning: false, attempts: 1, errorLabel: null,
        sentAt: '2026-10-09T01:00:05.000Z', deliveryEventAt: null, canViewContent: true, bodyErased: false, resendable: true,
        fulfillmentId: null, fulfillmentNumber: null,
      },
      { type: 'created', at: '2026-10-09T00:59:00.000Z' },
    ],
  };
}

describe('注文の履歴: 伝票番号の訂正・手動の配達済み・発送の取消の入口を出さず、発送票への案内を出す', () => {
  beforeEach(() => {
    mockClientFetch.mockReset();
  });

  it('偽の cancellable と配達済みでない発送でも、旧の入口を出さず、POST を送らない', async () => {
    mockClientFetch.mockResolvedValueOnce(json(legacyHistory()));
    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: 'この注文の履歴' });
    await within(dialog).findByText('宛先: hanako@example.com');
    for (const name of LEGACY_ENTRY_NAMES) {
      expect(within(dialog).queryByRole('button', { name })).not.toBeInTheDocument();
    }
    // 発送の行と配送の状況は読める
    expect(within(dialog).getByText('発送（1回目）')).toBeInTheDocument();
    expect(within(dialog).getByText('配送業者: ヤマト運輸 / 伝票番号: 1234-5678')).toBeInTheDocument();
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
    expect(mockClientFetch).toHaveBeenCalledWith(`/api/admin/orders/${ORDER_ID}/history`, { cache: 'no-store' });
  });

  it('FREQ-524-AC-03: 発送票への案内を、履歴の一覧の上に1回だけ出す。旧い停止の文と仕上がりの停止の文は履歴には出さない', async () => {
    mockClientFetch.mockResolvedValueOnce(json(legacyHistory()));
    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: 'この注文の履歴' });
    await within(dialog).findByText('宛先: hanako@example.com');
    const texts = within(dialog).getAllByText('発送・発送取消・伝票番号の訂正・手動の配達済みは、発送票から行います。');
    expect(texts).toHaveLength(1);
    const list = within(dialog).getByRole('list');
    expect(list.contains(texts[0])).toBe(false);
    expect(texts[0].compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expectWraps(texts[0]);
    expect(within(dialog).queryByText(LEGACY_FULFILLMENT_DISABLED_TEXT)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(MANUAL_COMPLETION_DISABLED_TEXT)).not.toBeInTheDocument();
  });

  it('FREQ-533-AC-01: 票に属する発送の行には「発送票 番号 を開く」を出し、票の頁へ移れる。票に属さない発送には出さない', async () => {
    const history = legacyHistory();
    const SLIP_ID = 'a9a9a9a9-1111-4222-8333-444455556666';
    const fulfillment = history.entries[0];
    if (fulfillment.type !== 'fulfillment') throw new Error('fixture');
    history.entries.push({ ...fulfillment, fulfillmentId: 'f2f2f2f2-1111-2222-8333-444455556666', number: 2, slipId: null, slipNumber: null });
    fulfillment.slipId = SLIP_ID;
    fulfillment.slipNumber = 'SL-20261025-0001';
    mockClientFetch.mockResolvedValueOnce(json(history));
    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: 'この注文の履歴' });
    await within(dialog).findByText('宛先: hanako@example.com');
    const links = within(dialog).getAllByRole('link', { name: /発送票/ });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAccessibleName('発送票 SL-20261025-0001 を開く');
    expect(links[0]).toHaveAttribute('href', `/admin/shipment-slips/${SLIP_ID}`);
    // リンクは、その票に属する発送（1回目）の行の中にある
    expect(within(links[0].closest('li') as HTMLElement).getByText('発送（1回目）')).toBeInTheDocument();
  });

  it('メールの中身を見る・お客様へ再送は残る（履歴の読み取りと再送は止めない）', async () => {
    mockClientFetch.mockResolvedValueOnce(json(legacyHistory()));
    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: 'この注文の履歴' });
    await within(dialog).findByText('宛先: hanako@example.com');
    expect(within(dialog).getByRole('button', { name: '中身を見る' })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: 'お客様へ再送' })).toBeEnabled();
  });
});
