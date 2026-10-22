import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type {
  CustomerCancelRequest,
  CustomerOrderReturn,
  CustomerOrderReturns,
  CustomerReturnStatus,
} from '@/lib/orders/returns/customer-return-types';

jest.mock('next/link', () => ({ href, children, ...props }: any) => (
  <a href={href} {...props}>
    {children}
  </a>
));
// キャンセルのお申し込みの窓口の呼び出しは差し替える（窓口の答えの分け方は customer-cancel-request-client.test.ts が確かめる）
const mockSubmit = jest.fn();
jest.mock('@/features/account/returns/customer-return-client', () => ({
  submitCustomerCancelRequest: (...args: unknown[]) => mockSubmit(...args),
}));

import { OrderReturnsSection } from '@/features/account/returns/OrderReturnsSection';
import type { CancelableLine } from '@/features/account/returns/CancelRequestForm';

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const ADDRESS = {
  name: 'Le Fil des Heures 返品係',
  postalCode: '1500001',
  address: '東京都渋谷区神宮前1-2-3 ○○ビル4F',
  phone: '03-1234-5678',
};
const SHIRT: CancelableLine = { orderItemId: 'item-shirt', label: 'リネンシャツ（白 / M）', unshipped: 2 };

type ReturnLine = CustomerOrderReturn['lines'][number];

function line(overrides: Partial<ReturnLine> = {}): ReturnLine {
  return {
    itemName: 'リネンシャツ',
    color: '白',
    size: 'M',
    quantity: 1,
    requestedResolution: null,
    requestedExchange: null,
    resolution: 'refund',
    exchange: null,
    ...overrides,
  };
}

/** 初期値は、返送を待っている受付済みの返品（お店の負担の着払い） */
function customerReturn(overrides: Partial<CustomerOrderReturn> = {}): CustomerOrderReturn {
  return {
    id: 'ret-1',
    number: 1,
    label: 'ORD-A1B2C3D4-R1',
    status: 'open',
    customerStatus: 'accepted',
    returnMethod: 'customer_ships',
    returnShippingPayer: 'shop',
    returnShippingFee: 0,
    returnAddress: ADDRESS,
    requestedAt: '2026-10-10T01:00:00.000Z',
    closedAt: null,
    lines: [line()],
    refundAmount: null,
    sentBack: [],
    declineMessage: null,
    exchangeShipping: 'none',
    ...overrides,
  };
}

function cancelRequest(overrides: Partial<CustomerCancelRequest> = {}): CustomerCancelRequest {
  return {
    id: 'cr-1',
    status: 'requested',
    requestedAt: '2026-10-13T01:00:00.000Z',
    lines: [{ itemName: 'リネンシャツ', color: '白', size: 'M', quantity: 1 }],
    declineMessage: null,
    ...overrides,
  };
}

function availability(overrides: Partial<CustomerOrderReturns['availability']> = {}): CustomerOrderReturns['availability'] {
  return { returns: 'none', endedOn: null, cancel: false, ...overrides };
}

function renderSection(section: Partial<CustomerOrderReturns> = {}, options: { cancelLines?: CancelableLine[] } = {}) {
  const onChanged = jest.fn();
  const view = render(
    <OrderReturnsSection
      orderId={ORDER_ID}
      section={{ returns: [], cancelRequests: [], availability: availability(), ...section }}
      cancelLines={options.cancelLines ?? [SHIRT]}
      onChanged={onChanged}
    />,
  );
  return { ...view, onChanged };
}

const STATUS_CASES: Array<[CustomerReturnStatus, string, string | null]> = [
  ['requested', 'お申し込み中', '内容を確かめて、メールでご連絡します。'],
  ['accepted', '返品の受付済み', null],
  ['partially_received', '一部をお受け取りしました', '残りの商品の返送のしかたは、下のとおりです。'],
  ['inspecting', 'お受け取りしました（確かめています）', '確かめてから、ご連絡します。'],
  ['awaiting_fee', 'お支払いをお待ちしています', 'ご案内のメールをご覧ください。'],
  ['refund_preparing', 'ご返金の準備中', null],
  ['returned', '返品済み', null],
  ['declined', 'お受けできませんでした', null],
];

test('readOnlyの共用部品は申し込みと購入の操作を出さない', () => {
  render(<OrderReturnsSection orderId={ORDER_ID} section={{ returns: [customerReturn()], cancelRequests: [], availability: availability({ returns: 'available', cancel: true }) }} readOnly />);
  expect(screen.queryByRole('button', { name: 'キャンセルを申し込む' })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: '返品・交換を申し込む' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '再度購入' })).not.toBeInTheDocument();
  expect(screen.queryByTestId('order-return-address')).not.toBeInTheDocument();
});

test.each(STATUS_CASES)('readOnlyの公開返品%sも固定の言葉と添える文を保つ', (customerStatus, label, note) => {
  const { returnAddress: _address, sentBack: _sentBack, ...publicRow } = customerReturn({ customerStatus });
  void _address; void _sentBack;
  render(<OrderReturnsSection orderId={ORDER_ID} section={{ returns: [{ ...publicRow, sentBack: [] }], cancelRequests: [], availability: availability() }} readOnly />);
  expect(screen.getByTestId('order-return-status').textContent).toBe(label);
  if (note) expect(screen.getByTestId('order-return-note').textContent).toBe(note);
  expect(screen.queryByTestId('order-return-how-to')).not.toBeInTheDocument();
});

test.each([
  ['requested', 'キャンセルのお申し込み中'], ['declined', 'キャンセルのお申し込みをお受けできませんでした'],
  ['resolved', 'キャンセルのお申し込みのお手続きが済みました'], ['closed', 'キャンセルのお申し込みのお手続きが済みました'],
] as const)('readOnlyのキャンセル%sも固定の言葉を保つ', (status, label) => {
  render(<OrderReturnsSection orderId={ORDER_ID} section={{ returns: [], cancelRequests: [cancelRequest({ status })], availability: availability() }} readOnly />);
  expect(screen.getByText(label)).toBeVisible();
});

test('店の文章はHTMLとして実行せず文字として表示する', () => {
  const message = '<b>店の文章</b>';
  const { returnAddress: _address, sentBack: _sentBack, ...publicRow } = customerReturn({ customerStatus: 'declined', declineMessage: message });
  void _address; void _sentBack;
  const { container } = render(<OrderReturnsSection orderId={ORDER_ID} section={{ returns: [{ ...publicRow, sentBack: [{ itemName: '品', color: null, size: null, quantity: 1, message }] }], cancelRequests: [], availability: availability() }} readOnly />);
  expect(container.querySelector('b') !== null).toBe(false);
  expect(screen.getAllByText(message).length === 2).toBe(true);
  expect(screen.getByText('品 × 1')).toBeVisible();
});

test('readOnlyは記録の無い欄と受付終了の案内を出さない', () => {
  const { container } = render(<OrderReturnsSection orderId={ORDER_ID} section={{ returns: [], cancelRequests: [], availability: availability({ returns: 'ended', endedOn: '2026-10-22', cancel: true }) }} readOnly />);
  expect(container.childElementCount).toBe(0);
});

test('readOnlyは余分な返送先と番号が来ても表示しない', () => {
  const row = customerReturn({ sentBack: [{ itemName: '品', color: null, size: null, quantity: 1, message: '店の文章', carrier: null, trackingNumber: 'SYNTHETIC-RETURN' }] });
  render(<OrderReturnsSection orderId={ORDER_ID} section={{ returns: [row], cancelRequests: [], availability: availability() }} readOnly />);
  expect(document.body.textContent?.includes('SYNTHETIC-RETURN')).toBe(false);
  expect(screen.queryByTestId('order-return-address')).not.toBeInTheDocument();
  expect(screen.getByText('店の文章')).toBeVisible();
});

describe('OrderReturnsSection の返品（状態の言葉と添える文）', () => {
  it.each(STATUS_CASES)('状態 %s は、言葉「%s」を出す', (customerStatus, label, note) => {
    renderSection({ returns: [customerReturn({ customerStatus })] });

    const card = screen.getByTestId('order-return');
    expect(within(card).getByTestId('order-return-status').textContent).toBe(label);
    if (note === null) {
      expect(within(card).queryByTestId('order-return-note')).not.toBeInTheDocument();
    } else {
      expect(within(card).getByTestId('order-return-note').textContent).toBe(note);
    }
  });

  it('返品ごとに「返品番号 {番号}」の見出しを出し、窓口が返した順（新しい順）に並べる', () => {
    renderSection({
      returns: [
        customerReturn({ id: 'ret-2', label: 'ORD-A1B2C3D4-R2' }),
        customerReturn({ id: 'ret-1', label: 'ORD-A1B2C3D4-R1' }),
      ],
    });

    expect(screen.getByRole('region', { name: '返品・交換' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual([
      '返品番号 ORD-A1B2C3D4-R2',
      '返品番号 ORD-A1B2C3D4-R1',
    ]);
    expect(screen.getByRole('region', { name: '返品番号 ORD-A1B2C3D4-R1' })).toBeInTheDocument();
  });

  it('申し込み中の返品は、品ごとに「ご希望」を書く（返金、または交換の色・サイズ）。返送のしかたは出さない', () => {
    renderSection({
      returns: [
        customerReturn({
          status: 'requested',
          customerStatus: 'requested',
          returnAddress: null,
          lines: [
            line({ itemName: 'リネンシャツ', color: '白', size: 'M', quantity: 2, requestedResolution: 'refund', resolution: 'refund' }),
            line({
              itemName: 'ウールコート',
              color: '黒',
              size: 'L',
              quantity: 1,
              requestedResolution: 'exchange',
              requestedExchange: { color: '黒', size: 'XL' },
              resolution: 'exchange',
              exchange: { color: '黒', size: 'XL' },
            }),
          ],
        }),
      ],
    });

    const lines = within(screen.getByTestId('order-return-lines'));
    expect(lines.getByText('リネンシャツ（白 / M） × 2')).toBeInTheDocument();
    expect(lines.getByText('ご希望: 返金')).toBeInTheDocument();
    expect(lines.getByText('ウールコート（黒 / L） × 1')).toBeInTheDocument();
    expect(lines.getByText('ご希望: 交換（黒 / XL）')).toBeInTheDocument();
    expect(screen.queryByTestId('order-return-how-to')).not.toBeInTheDocument();
  });

  it('お受けできなかった返品は、ご希望の行と「当店より:」のメッセージを書く。メッセージは書かれたとおりの字（改行を残し、HTML として読まない）', () => {
    const message = '受付の期限を過ぎているため、お受けできませんでした。\n<b>ご了承ください</b>';
    renderSection({
      returns: [
        customerReturn({
          status: 'declined',
          customerStatus: 'declined',
          returnAddress: null,
          declineMessage: message,
          lines: [line({ requestedResolution: 'refund', resolution: 'refund' })],
        }),
      ],
    });

    expect(screen.getByText('ご希望: 返金')).toBeInTheDocument();
    const decline = screen.getByTestId('order-return-decline');
    expect(within(decline).getByText('当店より:')).toBeInTheDocument();
    const body = decline.querySelector('p.whitespace-pre-wrap') as HTMLElement;
    expect(body.textContent).toBe(message);
    expect(decline.querySelector('b')).toBeNull();
  });

  it('承認の後は、品ごとの解決（返金、または交換の色・サイズ）を書き、「ご希望」とは書かない。お店が解決を変えた品は、変えた後の解決を書く', () => {
    renderSection({
      returns: [
        customerReturn({
          customerStatus: 'accepted',
          lines: [
            line({ itemName: 'リネンシャツ', requestedResolution: 'refund', resolution: 'refund' }),
            line({
              itemName: 'ウールコート',
              color: '黒',
              size: 'L',
              requestedResolution: 'refund',
              resolution: 'exchange',
              exchange: { color: '黒', size: 'XL' },
            }),
          ],
        }),
      ],
    });

    const lines = within(screen.getByTestId('order-return-lines'));
    expect(lines.getByText('返金')).toBeInTheDocument();
    expect(lines.getByText('交換: 黒 / XL')).toBeInTheDocument();
    expect(lines.queryByText(/ご希望/)).not.toBeInTheDocument();
  });

  it('色もサイズも無い交換先は、括弧や「交換:」の後ろを空にせず、「ご希望: 交換」「交換」と書く', () => {
    renderSection({
      returns: [
        customerReturn({
          id: 'ret-2',
          label: 'ORD-A1B2C3D4-R2',
          status: 'requested',
          customerStatus: 'requested',
          returnAddress: null,
          lines: [
            line({ requestedResolution: 'exchange', requestedExchange: { color: null, size: null }, resolution: 'exchange', exchange: null }),
          ],
        }),
        customerReturn({
          id: 'ret-1',
          customerStatus: 'accepted',
          lines: [line({ requestedResolution: 'exchange', resolution: 'exchange', exchange: { color: null, size: null } })],
        }),
      ],
    });

    const cards = screen.getAllByTestId('order-return');
    expect(within(within(cards[0]).getByTestId('order-return-lines')).getByText('ご希望: 交換')).toBeInTheDocument();
    const decided = within(within(cards[1]).getByTestId('order-return-lines'));
    expect(decided.getByText('交換')).toBeInTheDocument();
    expect(decided.queryByText(/交換:/)).not.toBeInTheDocument();
  });

  it('返金の額は、あるときだけ「ご返金 ￥…」と書く', () => {
    renderSection({
      returns: [
        customerReturn({ id: 'ret-2', label: 'ORD-A1B2C3D4-R2', status: 'closed', customerStatus: 'returned', refundAmount: 12000 }),
        customerReturn({ id: 'ret-1', label: 'ORD-A1B2C3D4-R1', refundAmount: null }),
      ],
    });

    const cards = screen.getAllByTestId('order-return');
    expect(within(cards[0]).getByTestId('order-return-refund').textContent).toBe('ご返金 ￥12,000');
    expect(within(cards[1]).queryByTestId('order-return-refund')).not.toBeInTheDocument();
  });

  it('交換の品の発送の一文は、返品済みの時だけ出す（発送前は「お送りします。」、発送後は「お送りしました。」、交換の品が無ければ出さない）', () => {
    renderSection({
      returns: [
        customerReturn({ id: 'r1', customerStatus: 'returned', exchangeShipping: 'pending' }),
        customerReturn({ id: 'r2', customerStatus: 'returned', exchangeShipping: 'shipped' }),
        customerReturn({ id: 'r3', customerStatus: 'returned', exchangeShipping: 'none' }),
        customerReturn({ id: 'r4', customerStatus: 'inspecting', exchangeShipping: 'pending' }),
      ],
    });

    const cards = screen.getAllByTestId('order-return');
    expect(within(cards[0]).getByTestId('order-return-exchange-shipping').textContent).toBe('交換の品をお送りします。');
    expect(within(cards[1]).getByTestId('order-return-exchange-shipping').textContent).toBe('交換の品をお送りしました。');
    expect(within(cards[2]).queryByTestId('order-return-exchange-shipping')).not.toBeInTheDocument();
    expect(within(cards[3]).queryByTestId('order-return-exchange-shipping')).not.toBeInTheDocument();
  });
});

describe('OrderReturnsSection の返送のしかた', () => {
  it.each(['accepted', 'partially_received'] as const)('状態 %s では「返送のしかた」と返送先を出す', (customerStatus) => {
    renderSection({ returns: [customerReturn({ customerStatus })] });

    const howTo = screen.getByTestId('order-return-how-to');
    expect(within(howTo).getByRole('heading', { name: '返送のしかた' })).toBeInTheDocument();
    expect(within(howTo).getByText('下記の返送先へお送りください。')).toBeInTheDocument();
    const address = within(howTo).getByTestId('order-return-address');
    expect(within(address).getByText('返送先:')).toBeInTheDocument();
    expect(within(address).getByText('Le Fil des Heures 返品係')).toBeInTheDocument();
    expect(within(address).getByText('〒1500001 東京都渋谷区神宮前1-2-3 ○○ビル4F')).toBeInTheDocument();
    expect(within(address).getByText('03-1234-5678')).toBeInTheDocument();
  });

  it('返送料の文は、お店の負担を先に見る。お客様の負担なら、自分で送るか、お店の送り状（返送料を差し引く／0円）かで変える', () => {
    renderSection({
      returns: [
        customerReturn({ id: 'r1', returnShippingPayer: 'shop', returnMethod: 'customer_ships' }),
        customerReturn({ id: 'r2', returnShippingPayer: 'shop', returnMethod: 'shop_label', returnShippingFee: 0 }),
        customerReturn({ id: 'r3', returnShippingPayer: 'customer', returnMethod: 'customer_ships' }),
        customerReturn({ id: 'r4', returnShippingPayer: 'customer', returnMethod: 'shop_label', returnShippingFee: 650 }),
        customerReturn({ id: 'r5', returnShippingPayer: 'customer', returnMethod: 'shop_label', returnShippingFee: 0 }),
      ],
    });

    expect(screen.getAllByTestId('order-return-shipping').map((node) => node.textContent)).toEqual([
      '返送料は当店が負担いたします。着払いでお送りください。',
      '返送料は当店が負担いたします。着払いでお送りください。',
      '恐れ入りますが、返送料はお客様のご負担でお送りください。',
      '当店がご用意する送り状でお送りください。返送料 ￥650 をご返金額から差し引きます。',
      '当店がご用意する送り状でお送りください。',
    ]);
  });

  it('返送が要らない返品は「品物のご返送は不要です。」だけを書き、返送先と返送料の文は出さない', () => {
    renderSection({ returns: [customerReturn({ returnMethod: 'not_required', returnAddress: null })] });

    const howTo = screen.getByTestId('order-return-how-to');
    expect(within(howTo).getByRole('heading', { name: '返送のしかた' })).toBeInTheDocument();
    expect(within(howTo).getByText('品物のご返送は不要です。')).toBeInTheDocument();
    expect(within(howTo).queryByTestId('order-return-address')).not.toBeInTheDocument();
    expect(within(howTo).queryByTestId('order-return-shipping')).not.toBeInTheDocument();
  });

  it('返送のしかたは、返品の受付済みと一部をお受け取りしましたの間だけ出す。ほかの状態では、返送先が付いていても出さない', () => {
    const others: CustomerReturnStatus[] = ['requested', 'inspecting', 'awaiting_fee', 'refund_preparing', 'returned', 'declined'];
    renderSection({
      returns: others.map((customerStatus, index) => customerReturn({ id: `ret-${index}`, customerStatus, returnAddress: ADDRESS })),
    });

    expect(screen.getAllByTestId('order-return')).toHaveLength(6);
    expect(screen.queryByTestId('order-return-how-to')).not.toBeInTheDocument();
    expect(screen.queryByText('返送先:')).not.toBeInTheDocument();
  });

  it('返送が要るのに返送先を読めない時は、見出しだけの空の欄を出さない', () => {
    renderSection({ returns: [customerReturn({ returnAddress: null })] });

    expect(screen.getByTestId('order-return-status').textContent).toBe('返品の受付済み');
    expect(screen.queryByTestId('order-return-how-to')).not.toBeInTheDocument();
  });
});

describe('OrderReturnsSection のお返し', () => {
  it('お返しした商品は、見出し・品と数・お店のメッセージ・送り返しの伝票番号（配送業者が分かる時は一緒に）を書く。伝票番号が無い品には、その行を出さない', () => {
    renderSection({
      returns: [
        customerReturn({
          status: 'closed',
          customerStatus: 'returned',
          sentBack: [
            {
              itemName: 'リネンシャツ',
              color: '白',
              size: 'M',
              quantity: 1,
              message: 'ご返送の品に着用の跡がありましたので、お返しします。',
              carrier: 'yamato',
              trackingNumber: '1234-5678-9012',
            },
            { itemName: 'ウールコート', color: '黒', size: 'L', quantity: 1, message: null, carrier: null, trackingNumber: 'AB-123' },
            { itemName: 'シルクスカーフ', color: null, size: null, quantity: 2, message: 'お返しします。', carrier: 'sagawa', trackingNumber: null },
          ],
        }),
      ],
    });

    const sentBack = within(screen.getByTestId('order-return-sent-back'));
    expect(sentBack.getByRole('heading', { name: 'お返しした商品' })).toBeInTheDocument();
    expect(sentBack.getByText('リネンシャツ（白 / M） × 1')).toBeInTheDocument();
    expect(sentBack.getByText('ウールコート（黒 / L） × 1')).toBeInTheDocument();
    expect(sentBack.getByText('シルクスカーフ × 2')).toBeInTheDocument();
    expect(sentBack.getAllByText('当店より:')).toHaveLength(2);
    expect(sentBack.getByText('ご返送の品に着用の跡がありましたので、お返しします。')).toBeInTheDocument();
    expect(sentBack.getByText('お返しします。')).toBeInTheDocument();
    expect(sentBack.getByText('送り返しの伝票番号: ヤマト運輸 1234-5678-9012')).toBeInTheDocument();
    expect(sentBack.getByText('送り返しの伝票番号: AB-123')).toBeInTheDocument();
    expect(sentBack.queryByText(/佐川急便/)).not.toBeInTheDocument();
  });

  it('お返しした品が無い返品には、お返しの見出しを出さない', () => {
    renderSection({ returns: [customerReturn({ sentBack: [] })] });

    expect(screen.queryByTestId('order-return-sent-back')).not.toBeInTheDocument();
    expect(screen.queryByText('お返しした商品')).not.toBeInTheDocument();
  });
});

describe('OrderReturnsSection の申し込みのボタンと受付の終わりの文', () => {
  it('受付が available の時は、注文の申し込みの画面へのリンク「返品・交換を申し込む」を出す', () => {
    renderSection({ availability: availability({ returns: 'available' }) });

    expect(screen.getByRole('link', { name: '返品・交換を申し込む' })).toHaveAttribute(
      'href',
      `/account/orders/${ORDER_ID}/return`,
    );
    expect(screen.queryByTestId('order-returns-ended')).not.toBeInTheDocument();
  });

  it.each([
    ['2026-10-20', '返品・交換の受付は 10月20日 で終わりました'],
    ['2026-01-05', '返品・交換の受付は 1月5日 で終わりました'],
  ])('受付が ended の時は、終わった日（%s）を「M月D日」で書き、リンクは出さない', (endedOn, sentence) => {
    renderSection({ availability: availability({ returns: 'ended', endedOn }) });

    expect(screen.getByTestId('order-returns-ended').textContent).toBe(sentence);
    expect(screen.queryByRole('link', { name: '返品・交換を申し込む' })).not.toBeInTheDocument();
  });

  it.each(['closed', 'none'] as const)('受付が %s の時は、リンクも終わりの文も出さず、ほかに出す物が無ければ欄ごと出さない', (returnsAvailability) => {
    const { container } = renderSection({ availability: availability({ returns: returnsAvailability }) });

    expect(container).toBeEmptyDOMElement();
  });

  it('受付が ended でも終わった日が空なら、終わりの文を出さず、ほかに出す物が無ければ欄ごと出さない', () => {
    const { container } = renderSection({ availability: availability({ returns: 'ended', endedOn: null }) });

    expect(container).toBeEmptyDOMElement();
  });
});

describe('OrderReturnsSection のキャンセルの申し込み', () => {
  beforeEach(() => {
    mockSubmit.mockReset();
  });

  const CANCEL_STATUS_CASES: Array<[CustomerCancelRequest['status'], string]> = [
    ['requested', 'キャンセルのお申し込み中'],
    ['declined', 'キャンセルのお申し込みをお受けできませんでした'],
    ['resolved', 'キャンセルのお申し込みのお手続きが済みました'],
    ['closed', 'キャンセルのお申し込みのお手続きが済みました'],
  ];

  it.each(CANCEL_STATUS_CASES)('申し込みの状態 %s は、言葉「%s」と品を出す。お断りの時だけ「当店より:」のメッセージを出す', (status, label) => {
    renderSection({
      cancelRequests: [
        cancelRequest({ status, declineMessage: status === 'declined' ? 'この商品はすでに出荷の準備に入っています。' : null }),
      ],
    });

    const request = screen.getByTestId('order-cancel-request');
    expect(within(request).getByTestId('order-cancel-request-status').textContent).toBe(label);
    expect(within(request).getByText('リネンシャツ（白 / M） × 1')).toBeInTheDocument();
    if (status === 'declined') {
      const decline = within(request).getByTestId('order-cancel-request-decline');
      expect(within(decline).getByText('当店より:')).toBeInTheDocument();
      expect(within(decline).getByText('この商品はすでに出荷の準備に入っています。')).toBeInTheDocument();
    } else {
      expect(within(request).queryByText('当店より:')).not.toBeInTheDocument();
    }
  });

  it('availability.cancel が真で選べる品がある時だけ「キャンセルを申し込む」を出す', () => {
    renderSection({ availability: availability({ cancel: true }) });

    expect(screen.getByRole('button', { name: 'キャンセルを申し込む' })).toBeInTheDocument();
  });

  it('availability.cancel が偽の時は、「キャンセルを申し込む」を出さない', () => {
    renderSection({ availability: availability({ returns: 'available', cancel: false }) });

    expect(screen.queryByRole('button', { name: 'キャンセルを申し込む' })).not.toBeInTheDocument();
  });

  it('availability.cancel が真でも選べる品が無い時は、ボタンも欄も出さない', () => {
    const { container } = renderSection({ availability: availability({ cancel: true }) }, { cancelLines: [] });

    expect(container).toBeEmptyDOMElement();
  });

  it('「キャンセルを申し込む」で申し込みの画面を欄の中に開き、「戻る」で送らずに閉じてボタンを戻す。閉じた後は欄の見出しにフォーカスを移す', () => {
    const { onChanged } = renderSection({ availability: availability({ cancel: true }) });

    fireEvent.click(screen.getByRole('button', { name: 'キャンセルを申し込む' }));
    expect(screen.getByRole('heading', { name: 'キャンセルのお申し込み' })).toBeInTheDocument();
    // form 要素は使わない（チェックボックスの Enter で送られないようにするため。T10-9）
    expect(document.querySelector('form')).toBeNull();
    expect(screen.queryByRole('button', { name: 'キャンセルを申し込む' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '戻る' }));
    expect(screen.queryByRole('heading', { name: 'キャンセルのお申し込み' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'キャンセルを申し込む' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '返品・交換' })).toHaveFocus();
    expect(mockSubmit).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('申し込みが受け付けられたら、画面を閉じて受け付けた文を出し、欄の見出しにフォーカスを移し、注文の画面に読み直しを頼む。読み直すまでの間も、ボタンは出さない', async () => {
    const { onChanged } = renderSection({ availability: availability({ cancel: true }) });
    mockSubmit.mockResolvedValueOnce({ kind: 'ok', body: { data: { cancelRequestId: 'cr-1', replayed: false } } });
    fireEvent.click(screen.getByRole('button', { name: 'キャンセルを申し込む' }));
    fireEvent.click(screen.getByRole('checkbox', { name: SHIRT.label }));
    fireEvent.click(screen.getByRole('button', { name: '申し込む' }));

    // 画面に出る物を待ってから、ほかを確かめる（状態の更新は、窓口の答えの後に非同期で画面へ届く）
    await waitFor(() =>
      expect(screen.getByTestId('order-cancel-notice')).toHaveTextContent(
        'キャンセルのお申し込みを受け付けました。内容を確かめて、メールでご連絡します。',
      ),
    );
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(mockSubmit).toHaveBeenCalledWith(
      ORDER_ID,
      expect.objectContaining({ lines: [{ orderItemId: 'item-shirt', quantity: 2 }], customerNote: null }),
    );
    expect(screen.queryByRole('heading', { name: 'キャンセルのお申し込み' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'キャンセルを申し込む' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('heading', { name: '返品・交換' })).toHaveFocus());
  });

  it('Review Focus 1: 結果が分からないまま「戻る」で閉じたら、受け付けられていたかもしれないので、注文の画面に読み直しを頼む（受け付けた文は出さない）', async () => {
    const { onChanged } = renderSection({ availability: availability({ cancel: true }) });
    mockSubmit.mockResolvedValueOnce({ kind: 'unknown' });
    fireEvent.click(screen.getByRole('button', { name: 'キャンセルを申し込む' }));
    fireEvent.click(screen.getByRole('checkbox', { name: SHIRT.label }));
    fireEvent.click(screen.getByRole('button', { name: '申し込む' }));
    await screen.findByRole('button', { name: 'もう一度確かめる' });

    fireEvent.click(screen.getByRole('button', { name: '戻る' }));

    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('heading', { name: 'キャンセルのお申し込み' })).not.toBeInTheDocument();
    expect(screen.getByTestId('order-cancel-notice')).toBeEmptyDOMElement();
    expect(screen.getByRole('button', { name: 'キャンセルを申し込む' })).toBeInTheDocument();
  });
});
