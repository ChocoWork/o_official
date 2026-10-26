import { render, screen, waitFor, within } from '@testing-library/react';
import AdminPage from '@/app/admin/page';
import type { OrderHistoryResponse } from '@/lib/orders/email/order-history';
import {
  LEGACY_FULFILLMENT_DISABLED_TEXT,
  MANUAL_COMPLETION_DISABLED_TEXT,
} from '@/lib/orders/fulfillment/legacy-fulfillment-disabled';

const mockClientFetch = jest.fn();
let mockUserRole: 'admin' | 'supporter' = 'admin';
let mockTab = 'ORDER';
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));
jest.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(`tab=${mockTab}`) }));
jest.mock('@/contexts/LoginContext', () => ({
  useLogin: () => ({ isLoggedIn: true, isAuthResolved: true, userRole: mockUserRole, isMfaVerified: true }),
}));
jest.mock('@/components/KpiSection', () => () => null);
jest.mock('@/components/AccountingSection', () => () => null);
jest.mock('@/components/NewsSection', () => () => null);
jest.mock('@/components/ItemSection', () => () => null);
jest.mock('@/components/LookSection', () => () => null);
jest.mock('@/components/StockistSection', () => () => null);
jest.mock('@/components/UserSection', () => () => null);

import OrderHistoryDialog from '@/components/OrderHistoryDialog';

/**
 * G-1 Task 15: 旧の発送・発送取消・伝票番号の訂正・手動の配達済み・仕上がりの手動記録と取消の画面の入口を撤去し、
 * 注文の履歴（OrderHistoryDialog）の中に、固定の案内を出す。
 * G-3: 発送・発送取消・伝票番号の訂正・手動の配達済みの案内は、荷作り表（注文一覧）と発送票（履歴）へ移った。仕上がりの手動記録は終了のまま。
 * G-4 Task 7: 管理画面の ORDER タブは注文一覧表（/admin/orders）への入口だけになった。旧い一覧（OrderSection）と、その上の停止の文・各 dialog・旧CSVは撤去した。
 * 窓口が昔の形で canShip・canRecordCompletion・cancellable を true にしても、旧い入口は出さない。
 * FREQ-524-AC-03・FREQ-539-AC-05・FREQ-540（G-1 部分）・FREQ-533-AC-01（履歴からの票）の単体
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

function expectWraps(element: HTMLElement) {
  // 390/768/1280 のどの幅でも折り返す。折り返しを止める指定と、固定の幅を持たない
  expect(element.className).not.toMatch(/nowrap|truncate|\bw-\[|\bmin-w-|\bmax-w-/);
  expect(element.style.whiteSpace).toBe('');
  expect(element.style.width).toBe('');
}

function ok(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body });
}

function attentionWith(counts: { exceptions: number; reviews: number; deliveries?: number }) {
  return {
    data: {
      exceptions: Array.from({ length: counts.exceptions }, () => ({})),
      reviews: Array.from({ length: counts.reviews }, () => ({})),
      ...(counts.deliveries === undefined ? {} : { deliveries: Array.from({ length: counts.deliveries }, () => ({})) }),
      counts,
    },
  };
}

/** 窓口の差し替え。要対応の欄だけを答え、ほかは空で返す */
function serve(attention: unknown = attentionWith({ exceptions: 0, reviews: 0 })) {
  mockClientFetch.mockImplementation((url: string) => (String(url) === '/api/admin/order-attention' ? ok(attention) : ok({ data: {} })));
}

describe('管理画面の ORDER タブ: 注文一覧表への入口だけを出し、旧い一覧・停止の文・各 dialog・旧CSVを出さない', () => {
  beforeEach(() => {
    mockClientFetch.mockReset();
    mockUserRole = 'admin';
    mockTab = 'ORDER';
    serve();
  });

  it.each(['admin', 'supporter'] as const)('FREQ-539-AC-05: %s の ORDER は「注文一覧表」へのリンクだけを持つ', async (role) => {
    mockUserRole = role;
    render(<AdminPage />);

    const menu = await screen.findByRole('navigation', { name: '注文メニュー' });
    expect(within(menu).getAllByRole('link').map((link) => link.textContent)).toEqual(['注文一覧表']);
    expect(within(menu).getByRole('link', { name: '注文一覧表' })).toHaveAttribute('href', '/admin/orders');
    expect(screen.getByRole('button', { name: 'ORDER' })).toHaveAttribute('aria-current', 'page');
  });

  it('FREQ-539-AC-05: 旧い一覧の表・停止の文・荷作り表への案内・履歴/返金などのボタン・旧CSV・旧い絞り込みを出さない', async () => {
    render(<AdminPage />);
    await screen.findByRole('navigation', { name: '注文メニュー' });
    await waitFor(() => expect(mockClientFetch).toHaveBeenCalledWith('/api/admin/order-attention', { cache: 'no-store' }));

    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    for (const text of ['発送は荷作り表から行います。', MANUAL_COMPLETION_DISABLED_TEXT, LEGACY_FULFILLMENT_DISABLED_TEXT, '条件に一致する注文はありません', '注文一覧を読み込み中です...']) {
      expect(screen.queryByText(text)).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('link', { name: '荷作り表を開く' })).not.toBeInTheDocument();
    for (const name of ['履歴', '返金', '返品', 'キャンセルの申し込み', 'キャンセル', '表示中の注文をCSV出力', '期間適用', '期間クリア', '要確認のみ', ...LEGACY_ENTRY_NAMES]) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    for (const label of ['取引先', '金額（下限）', '金額（上限）', '注文・決済ID', '返品']) {
      expect(screen.queryByLabelText(label)).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // 旧い一覧の窓口は呼ばない（窓口そのものも撤去した）。要対応の件数の読取だけ残る
    expect(mockClientFetch.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith('/api/admin/orders'))).toEqual([]);
  });

  it('FREQ-539-AC-05: 要対応の欄・メールの停止の帯は ORDER タブには出さない（一覧の頁へ移した）', async () => {
    serve({
      data: {
        exceptions: [{ id: 'exception-1', reason: 'unexpected_state', reasonLabel: '想定外の支払い状態', orderId: null, orderNumber: null, paymentRef: 'cs_1', firstDetectedAt: null, refundFailure: null }],
        reviews: [],
        counts: { exceptions: 1, reviews: 0 },
        emailSending: { paused: true, reasonLabel: '送信元のドメインの設定' },
      },
    });
    render(<AdminPage />);

    await screen.findByRole('button', { name: 'ORDER 未処理 1件' });
    expect(screen.queryByText('想定外の支払い状態')).not.toBeInTheDocument();
    expect(screen.queryByText('お客様への注文のメールの送信を止めています')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '解決済みにする' })).not.toBeInTheDocument();
  });

  it('FREQ-539-AC-05: 配送の要対応だけが2件ある時も、サイドナビの ORDER の印は2になり、KPI の帯に「配送 2件」を出す', async () => {
    mockTab = 'KPI';
    serve(attentionWith({ exceptions: 0, reviews: 0, deliveries: 2 }));
    render(<AdminPage />);

    expect(await screen.findByText('要対応0件・要確認0件・配送 2件（ORDER で確認）')).toBeVisible();
    expect(screen.getByRole('button', { name: 'ORDER 未処理 2件' })).toBeInTheDocument();
  });

  it('FREQ-539-AC-05: 要対応・要確認と配送が並ぶ時は、印の数に足し合わせ、帯に3つの数を出す', async () => {
    mockTab = 'KPI';
    serve(attentionWith({ exceptions: 1, reviews: 2, deliveries: 1 }));
    render(<AdminPage />);

    expect(await screen.findByText('要対応1件・要確認2件・配送 1件（ORDER で確認）')).toBeVisible();
    expect(screen.getByRole('button', { name: 'ORDER 未処理 4件' })).toBeInTheDocument();
  });

  it.each([
    ['配送が0件', attentionWith({ exceptions: 1, reviews: 0, deliveries: 0 })],
    ['配送の項目が無い昔の形', attentionWith({ exceptions: 1, reviews: 0 })],
  ])('FREQ-539-AC-05: %s の時は、帯の文に配送を付けず、印は今までの数のまま', async (_label, attention) => {
    mockTab = 'KPI';
    serve(attention);
    render(<AdminPage />);

    expect(await screen.findByText('要対応1件・要確認0件（ORDER で確認）')).toBeVisible();
    expect(screen.queryByText(/配送/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ORDER 未処理 1件' })).toBeInTheDocument();
  });

  it('FREQ-539-AC-05: 要対応・要確認・配送のどれも無い時は、帯を出さず、印は出ない', async () => {
    mockTab = 'KPI';
    render(<AdminPage />);

    await waitFor(() => expect(mockClientFetch).toHaveBeenCalledWith('/api/admin/order-attention', { cache: 'no-store' }));
    expect(screen.getByRole('button', { name: 'ORDER' })).toBeInTheDocument();
    expect(screen.queryByText(/ORDER で確認/)).not.toBeInTheDocument();
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
