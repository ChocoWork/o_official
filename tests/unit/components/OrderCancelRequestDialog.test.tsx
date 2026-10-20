import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { OrderStatus } from '@/lib/orders/order-payment-types';
import type { AdminCancelRequest } from '@/lib/orders/returns/return-types';

const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));

import OrderCancelRequestDialog, { decideRemoveMode, type RemoveItemsRequest } from '@/components/OrderCancelRequestDialog';

/**
 * キャンセルの申し込みの画面（グループ E-3 段2 の Task 12。設計書 5-4・本計画 P11・C-5）。
 * 窓口（clientFetch）だけを差し替える。申し込みの窓口の読み・お断り・解決済みにするを、URL と本文で見分けて返す。
 */
const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const REQUEST_ID = 'c3c3c3c3-1111-2222-8333-444455556666';
const READ_URL = `/api/admin/orders/${ORDER_ID}/cancel-requests`;
const LIST_TITLE = 'キャンセルの申し込み（ORD-A1B2C3D4）';
const DECLINE_TITLE = 'お断りする（ORD-A1B2C3D4）';
const CLOSE_TITLE = '解決済みにする（ORD-A1B2C3D4）';
const REMOVE_LABEL = '品を外す（返金・キャンセルの画面を開く）';
const REASON_LABEL = 'お断りの理由（お客様には見えません）';
const MESSAGE_LABEL = 'お客様へのメッセージ（必須・お客様に届きます）';
const WINDOW_PASSED_FIRST = '受付の期限を過ぎているため、今回のお申し込みはお受けできませんでした。';
const FINAL_SALE_FIRST = 'この商品は返品不可の商品のため、お客様のご都合による返品・交換はお受けできませんでした。';
const STATE_CONFLICT_MESSAGE = 'キャンセルの申し込みの状態が変わりました。画面を開き直してください。';

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function requestLine(overrides: Partial<AdminCancelRequest['lines'][number]> = {}): AdminCancelRequest['lines'][number] {
  return { orderItemId: 'item-1', itemName: 'シルクブラウス', color: '白', size: 'M', quantity: 1, unshipped: 2, ...overrides };
}

/** 開いている申し込み（既定）。2026-10-12 10:00（日本時間）に、ブラウス1点を申し込んだ */
function cancelRequest(overrides: Partial<AdminCancelRequest> = {}): AdminCancelRequest {
  return {
    id: REQUEST_ID, status: 'requested', requestedAt: '2026-10-12T01:00:00.000Z', customerNote: null,
    lines: [requestLine()],
    declineReason: null, declineMessage: null, declinedAt: null, declinedByEmail: null,
    resolvedAt: null, resolvedByEmail: null, resolvedRefundId: null, resolvedByCancelAt: null,
    closedAt: null, closedByEmail: null,
    ...overrides,
  };
}

type ReadBody = { cancelRequests: AdminCancelRequest[]; orderStatus: OrderStatus; shippedUnits: number; unshippedUnits: number };

/** 申し込みの窓口の答え（`data` の中身）。既定は、支払い済みで1つも発送していない（未発送 2）注文の、開いている申し込み1つ（ブラウス 1点。未発送 2） */
function readBody(overrides: Partial<ReadBody> = {}): ReadBody {
  return { cancelRequests: [cancelRequest()], orderStatus: 'paid', shippedUnits: 0, unshippedUnits: 2, ...overrides };
}

type Routes = {
  read?: () => Response | Promise<Response>;
  post?: (url: string, body: Record<string, unknown>) => Response | Promise<Response>;
};

type OpenOptions = { routes?: Routes; canRefund?: boolean };

/** URL と方法で窓口の答えを返す。POST は本文を読んで渡す */
function serve(routes: Routes = {}) {
  mockClientFetch.mockImplementation((url: string, init?: RequestInit) => {
    const target = String(url);
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
      return Promise.resolve(routes.post ? routes.post(target, body) : json({ data: {} }));
    }
    return Promise.resolve(routes.read ? routes.read() : json({ data: readBody() }));
  });
}

function renderDialog(options: OpenOptions = {}) {
  serve(options.routes);
  const props = { onClose: jest.fn(), onChanged: jest.fn(), onRemoveItems: jest.fn() };
  const utils = render(
    <OrderCancelRequestDialog orderId={ORDER_ID} open canRefund={options.canRefund ?? true} {...props} />,
  );
  return { ...utils, ...props };
}

/** 画面を開き、既定の申し込みの日時が出るまで待つ */
async function openList(options: OpenOptions = {}) {
  const rendered = renderDialog(options);
  const dialog = await screen.findByRole('dialog', { name: LIST_TITLE });
  await within(dialog).findByText('申し込み: 2026/10/12 10:00');
  return { ...rendered, dialog };
}

/** 窓口（url の終わりが suffix）へ POST した呼び出し */
function postsTo(suffix: string) {
  return mockClientFetch.mock.calls.filter(
    ([url, init]) => String(url).endsWith(suffix) && (init as RequestInit | undefined)?.method === 'POST',
  );
}

/** 申し込みの窓口を読んだ回数 */
function readCount() {
  return mockClientFetch.mock.calls.filter(
    ([url, init]) => String(url) === READ_URL && (init as RequestInit | undefined)?.method !== 'POST',
  ).length;
}

beforeEach(() => {
  mockClientFetch.mockReset();
});

describe('OrderCancelRequestDialog の中身', () => {
  it('開くと申し込みの窓口を読み、題・日時・品（未発送の数つき）・ご連絡事項・4つのボタンを出す', async () => {
    const { dialog } = await openList({
      routes: { read: () => json({ data: readBody({ cancelRequests: [cancelRequest({ customerNote: '色違いを頼みたい' })] }) }) },
    });

    expect(mockClientFetch).toHaveBeenCalledWith(READ_URL, { cache: 'no-store' });
    expect(within(dialog).getByText('申し込み: 2026/10/12 10:00')).toBeInTheDocument();
    expect(within(dialog).getByText('シルクブラウス（白 / M） × 1（未発送 2）')).toBeInTheDocument();
    expect(within(dialog).getByText('ご連絡事項: 色違いを頼みたい')).toBeInTheDocument();
    for (const name of [REMOVE_LABEL, 'お断りする', '解決済みにする', '閉じる']) {
      expect(within(dialog).getByRole('button', { name })).toBeEnabled();
    }
  });

  it('色もサイズも無い品は品名だけ。複数の品は1行ずつ。ご連絡事項が無い申し込みは、その行を出さない', async () => {
    const { dialog } = await openList({
      routes: {
        read: () =>
          json({
            data: readBody({
              cancelRequests: [
                cancelRequest({
                  lines: [
                    requestLine({ orderItemId: 'item-2', itemName: 'ストール', color: null, size: null, quantity: 2, unshipped: 2 }),
                    requestLine(),
                  ],
                }),
              ],
            }),
          }),
      },
    });

    expect(within(dialog).getByText('ストール × 2（未発送 2）')).toBeInTheDocument();
    expect(within(dialog).getByText('シルクブラウス（白 / M） × 1（未発送 2）')).toBeInTheDocument();
    expect(within(dialog).queryByText(/ご連絡事項/)).not.toBeInTheDocument();
  });

  it('お客様が書いたご連絡事項は、書かれたとおりの字で出す（HTML として読まない）', async () => {
    const { dialog } = await openList({
      routes: { read: () => json({ data: readBody({ cancelRequests: [cancelRequest({ customerNote: '<b>急ぎ</b>です\n2行目' })] }) }) },
    });

    const note = within(dialog).getByText(/ご連絡事項:/);
    expect(note.textContent).toBe('ご連絡事項: <b>急ぎ</b>です\n2行目');
    expect(note.querySelector('b')).toBeNull();
    expect(note).toHaveClass('whitespace-pre-wrap');
  });

  it('開いている申し込みを先、過去の申し込みを後に並べ、過去の申し込みには状態の言葉だけを出す（操作のボタンは出さない）', async () => {
    const { dialog } = await openList({
      routes: {
        read: () =>
          json({
            data: readBody({
              cancelRequests: [
                cancelRequest({
                  id: 'r-resolved-refund', status: 'resolved', requestedAt: '2026-10-01T01:00:00.000Z',
                  resolvedAt: '2026-10-02T01:00:00.000Z', resolvedRefundId: 'refund-1',
                }),
                cancelRequest({
                  id: 'r-resolved-cancel', status: 'resolved', requestedAt: '2026-10-01T02:00:00.000Z',
                  resolvedAt: '2026-10-02T02:00:00.000Z', resolvedByCancelAt: '2026-10-02T02:00:00.000Z',
                }),
                cancelRequest({
                  id: 'r-declined', status: 'declined', requestedAt: '2026-10-01T03:00:00.000Z',
                  declinedAt: '2026-10-02T03:00:00.000Z', declineReason: 'other', declineMessage: 'お受けできません',
                }),
                cancelRequest({
                  id: 'r-closed', status: 'closed', requestedAt: '2026-10-01T04:00:00.000Z', closedAt: '2026-10-02T04:00:00.000Z',
                }),
                cancelRequest({ id: 'r-open' }),
              ],
            }),
          }),
      },
    });

    const items = within(dialog).getAllByTestId('cancel-request-item');
    expect(items.map((item) => item.getAttribute('data-request-id'))).toEqual([
      'r-open', 'r-resolved-refund', 'r-resolved-cancel', 'r-declined', 'r-closed',
    ]);
    expect(items.map((item) => item.getAttribute('data-status'))).toEqual([
      'requested', 'resolved', 'resolved', 'declined', 'closed',
    ]);
    expect(within(items[1]).getByText('解決（返金）')).toBeInTheDocument();
    expect(within(items[2]).getByText('解決（キャンセル）')).toBeInTheDocument();
    expect(within(items[3]).getByText('お断り')).toBeInTheDocument();
    expect(within(items[4]).getByText('解決済み')).toBeInTheDocument();
    for (const past of items.slice(1)) {
      expect(within(past).queryAllByRole('button')).toHaveLength(0);
    }
    expect(within(items[0]).getAllByRole('button')).toHaveLength(3);
  });

  it.each<[number, unknown, string]>([
    [500, { error: 'x' }, 'キャンセルの申し込みを読み込めませんでした。'],
    [403, { error: 'forbidden' }, 'この操作の権限がありません。'],
  ])('読めなかった時（%s）は、理由と「閉じる」だけを出す', async (status, body, expected) => {
    renderDialog({ routes: { read: () => json(body, status) } });
    const dialog = await screen.findByRole('dialog', { name: LIST_TITLE });

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(expected);
    expect(within(dialog).queryByTestId('cancel-request-item')).not.toBeInTheDocument();
    expect(within(dialog).getAllByRole('button').map((button) => button.textContent)).toEqual(['閉じる']);
  });

  it('申し込みが1つも無い時は、見つからない旨を出す', async () => {
    renderDialog({ routes: { read: () => json({ data: readBody({ cancelRequests: [] }) }) } });
    const dialog = await screen.findByRole('dialog', { name: LIST_TITLE });

    expect(await within(dialog).findByText('キャンセルの申し込みが見つかりません。')).toBeInTheDocument();
    expect(within(dialog).queryByTestId('cancel-request-item')).not.toBeInTheDocument();
  });

  it('「閉じる」と Escape で onClose を呼ぶ', async () => {
    const { dialog, onClose } = await openList();

    fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('open が偽の間は何も描かず、窓口も読まない', () => {
    serve();
    render(<OrderCancelRequestDialog orderId={ORDER_ID} open={false} onClose={jest.fn()} onChanged={jest.fn()} onRemoveItems={jest.fn()} />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockClientFetch).not.toHaveBeenCalled();
  });
});

describe('decideRemoveMode（「品を外す」の行き先。P11・C-2）', () => {
  type Input = Parameters<typeof decideRemoveMode>[0];
  /** 申し込みの1行（申し込みの数, 今の未発送の数） */
  const line = (quantity: number, unshipped: number) => ({ quantity, unshipped });

  it.each<[string, Input, RemoveItemsRequest['mode']]>([
    [
      '未入金は、一部の品だけの申し込みでも取消の画面（注文の全体の取消。T12-10）',
      { orderStatus: 'pending', shippedUnits: 0, unshippedUnits: 3, requestLines: [line(1, 2)] },
      'unpaid_cancel',
    ],
    [
      '支払い済み・発送0・申し込みの1行が未発送の全部 → 支払い済みのキャンセルの画面',
      { orderStatus: 'paid', shippedUnits: 0, unshippedUnits: 2, requestLines: [line(2, 2)] },
      'paid_cancel',
    ],
    [
      '申し込みの2行が、注文の未発送の全部 → 支払い済みのキャンセルの画面',
      { orderStatus: 'paid', shippedUnits: 0, unshippedUnits: 3, requestLines: [line(2, 2), line(1, 1)] },
      'paid_cancel',
    ],
    [
      '申し込みの数が今の未発送の数より少ない行がある → 返金の画面',
      { orderStatus: 'paid', shippedUnits: 0, unshippedUnits: 2, requestLines: [line(1, 2)] },
      'refund',
    ],
    [
      '申し込みの後に未発送が減って、申し込みの数が今の未発送の数を超える → 返金の画面（返金の画面が未発送までに収めて入れる）',
      { orderStatus: 'paid', shippedUnits: 0, unshippedUnits: 1, requestLines: [line(2, 1)] },
      'refund',
    ],
    [
      '申し込んでいない品の未発送が残っている（申し込みの合計 < 未発送の合計）→ 返金の画面（支払い済みのキャンセルにすると、申し込んでいない品まで返金してしまう）',
      { orderStatus: 'paid', shippedUnits: 0, unshippedUnits: 3, requestLines: [line(2, 2)] },
      'refund',
    ],
    [
      '発送が1つでも在る → 申し込みが全部でも返金の画面',
      { orderStatus: 'paid', shippedUnits: 1, unshippedUnits: 2, requestLines: [line(2, 2)] },
      'refund',
    ],
    [
      '発送済みの注文 → 返金の画面',
      { orderStatus: 'shipped', shippedUnits: 2, unshippedUnits: 0, requestLines: [line(1, 0)] },
      'refund',
    ],
    [
      '申し込みの行が無い → 返金の画面',
      { orderStatus: 'paid', shippedUnits: 0, unshippedUnits: 0, requestLines: [] },
      'refund',
    ],
  ])('%s', (_label, input, expected) => {
    expect(decideRemoveMode(input)).toBe(expected);
  });
});

describe('OrderCancelRequestDialog の「品を外す」', () => {
  /** 申し込みがブラウス 2点（未発送 2）で、注文の未発送の合計が unshippedUnits */
  const covering = (unshippedUnits: number) =>
    readBody({ unshippedUnits, cancelRequests: [cancelRequest({ lines: [requestLine({ quantity: 2, unshipped: 2 })] })] });

  it('未入金の注文は unpaid_cancel で onRemoveItems を呼ぶ（申し込みの品と数を渡す）。ほかの窓口は読まない', async () => {
    const { dialog, onRemoveItems } = await openList({
      routes: { read: () => json({ data: readBody({ orderStatus: 'pending' }) }) },
    });

    fireEvent.click(within(dialog).getByRole('button', { name: REMOVE_LABEL }));

    expect(onRemoveItems).toHaveBeenCalledTimes(1);
    expect(onRemoveItems).toHaveBeenCalledWith({
      cancelRequestId: REQUEST_ID,
      mode: 'unpaid_cancel',
      lines: [{ orderItemId: 'item-1', quantity: 1 }],
    });
    // 窓口を呼んだのは、開く時の申し込みの読みだけ
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
  });

  it('支払い済み・発送0・申し込みが注文の未発送の全部なら paid_cancel で呼ぶ。ほかの窓口は読まない', async () => {
    const { dialog, onRemoveItems } = await openList({ routes: { read: () => json({ data: covering(2) }) } });

    fireEvent.click(within(dialog).getByRole('button', { name: REMOVE_LABEL }));

    expect(onRemoveItems).toHaveBeenCalledWith({
      cancelRequestId: REQUEST_ID,
      mode: 'paid_cancel',
      lines: [{ orderItemId: 'item-1', quantity: 2 }],
    });
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
  });

  it('申し込みが注文の一部の品だけなら（未発送の品がほかに残っている）、refund で呼ぶ', async () => {
    const { dialog, onRemoveItems } = await openList({ routes: { read: () => json({ data: covering(3) }) } });

    fireEvent.click(within(dialog).getByRole('button', { name: REMOVE_LABEL }));

    expect(onRemoveItems).toHaveBeenCalledWith({
      cancelRequestId: REQUEST_ID,
      mode: 'refund',
      lines: [{ orderItemId: 'item-1', quantity: 2 }],
    });
  });

  it('発送が1つでも在る注文は、申し込みが未発送の全部でも refund で呼ぶ', async () => {
    const { dialog, onRemoveItems } = await openList({
      routes: { read: () => json({ data: { ...covering(2), shippedUnits: 1 } }) },
    });

    fireEvent.click(within(dialog).getByRole('button', { name: REMOVE_LABEL }));

    expect(onRemoveItems.mock.calls[0][0].mode).toBe('refund');
  });

  it('店長でない人（canRefund が偽）は、支払い済みの注文の「品を外す」を押せず、店長だけの旨を添える', async () => {
    const { dialog, onRemoveItems } = await openList({ canRefund: false });

    const button = within(dialog).getByRole('button', { name: REMOVE_LABEL });
    expect(button).toBeDisabled();
    expect(within(dialog).getByText('この操作は店長だけができます。')).toBeInTheDocument();
    fireEvent.click(button);
    expect(onRemoveItems).not.toHaveBeenCalled();
    // お断りと解決済みにするは、サポートの人もできる
    expect(within(dialog).getByRole('button', { name: 'お断りする' })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: '解決済みにする' })).toBeEnabled();
  });

  it('店長でない人も、未入金の注文の取消はできる（案内も出さない）', async () => {
    const { dialog, onRemoveItems } = await openList({
      canRefund: false,
      routes: { read: () => json({ data: readBody({ orderStatus: 'pending' }) }) },
    });

    expect(within(dialog).queryByText('この操作は店長だけができます。')).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: REMOVE_LABEL }));

    expect(onRemoveItems).toHaveBeenCalledTimes(1);
    expect(onRemoveItems.mock.calls[0][0].mode).toBe('unpaid_cancel');
  });
});

describe('OrderCancelRequestDialog のお断り', () => {
  async function openDeclineScreen(options: OpenOptions = {}) {
    const opened = await openList(options);
    fireEvent.click(within(opened.dialog).getByRole('button', { name: 'お断りする' }));
    const decline = await screen.findByRole('dialog', { name: DECLINE_TITLE });
    return { ...opened, decline };
  }
  const reasonSelect = (decline: HTMLElement) => within(decline).getByRole('combobox', { name: REASON_LABEL });
  const messageBox = (decline: HTMLElement) => within(decline).getByRole('textbox', { name: MESSAGE_LABEL });

  it('お断りの画面は、理由を選んでメッセージが入るまで「お断りする」を押せない。確かめの文を出す', async () => {
    const { decline } = await openDeclineScreen();

    expect(within(decline).getByText('お客様にメッセージが届きます。取り消せません。')).toBeInTheDocument();
    expect(within(reasonSelect(decline)).getAllByRole('option').map((option) => option.textContent)).toEqual([
      '選んでください', '期間切れ', '返品不可', 'その他',
    ]);
    expect(within(decline).getByRole('button', { name: 'お断りする' })).toBeDisabled();

    // 「その他」は最初の文が空なので、メッセージが入るまで押せない（空白だけも入っていないのと同じ）
    fireEvent.change(reasonSelect(decline), { target: { value: 'other' } });
    expect(within(decline).getByRole('button', { name: 'お断りする' })).toBeDisabled();
    fireEvent.change(messageBox(decline), { target: { value: '   ' } });
    expect(within(decline).getByRole('button', { name: 'お断りする' })).toBeDisabled();
    fireEvent.change(messageBox(decline), { target: { value: 'ご事情を確かめました' } });
    expect(within(decline).getByRole('button', { name: 'お断りする' })).toBeEnabled();
  });

  it.each<[string, string]>([
    ['window_passed', WINDOW_PASSED_FIRST],
    ['final_sale', FINAL_SALE_FIRST],
    ['other', ''],
  ])('メッセージの欄が空の時に理由 %s を選ぶと、その理由の最初の文が入る', async (value, first) => {
    const { decline } = await openDeclineScreen();

    fireEvent.change(reasonSelect(decline), { target: { value } });

    expect(messageBox(decline)).toHaveValue(first);
  });

  it('最初の文のままなら、理由を選び直すと新しい理由の最初の文になる。直した文は残す（P8）', async () => {
    const { decline } = await openDeclineScreen();
    fireEvent.change(reasonSelect(decline), { target: { value: 'window_passed' } });
    fireEvent.change(reasonSelect(decline), { target: { value: 'final_sale' } });
    expect(messageBox(decline)).toHaveValue(FINAL_SALE_FIRST);

    fireEvent.change(messageBox(decline), { target: { value: '直した文' } });
    fireEvent.change(reasonSelect(decline), { target: { value: 'window_passed' } });
    expect(messageBox(decline)).toHaveValue('直した文');

    // 「選んでください」に戻しても書いた文は残り、理由が無いので送れない
    fireEvent.change(reasonSelect(decline), { target: { value: '' } });
    expect(messageBox(decline)).toHaveValue('直した文');
    expect(within(decline).getByRole('button', { name: 'お断りする' })).toBeDisabled();
  });

  it('最初の文を直して「お断りする」を押すと、理由とメッセージ（前後の空白を外す）を送り、済んだら onChanged に「お断りしました。」を渡す', async () => {
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    const { decline, onChanged } = await openDeclineScreen({
      routes: {
        post: (url, body) => {
          posts.push({ url, body });
          return json({ data: { status: 'declined' } });
        },
      },
    });
    fireEvent.change(reasonSelect(decline), { target: { value: 'window_passed' } });
    expect(messageBox(decline)).toHaveValue(WINDOW_PASSED_FIRST);
    fireEvent.change(messageBox(decline), { target: { value: '  期限を過ぎておりました。ご了承ください。  ' } });

    fireEvent.click(within(decline).getByRole('button', { name: 'お断りする' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('お断りしました。'));
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(posts).toEqual([
      {
        url: `/api/admin/cancel-requests/${REQUEST_ID}/decline`,
        body: { declineReason: 'window_passed', declineMessage: '期限を過ぎておりました。ご了承ください。' },
      },
    ]);
  });

  it('「戻る」で一覧の画面へ戻る。何も送らない', async () => {
    const { decline } = await openDeclineScreen();

    fireEvent.click(within(decline).getByRole('button', { name: '戻る' }));

    expect(await screen.findByRole('dialog', { name: LIST_TITLE })).toBeInTheDocument();
    expect(postsTo('/decline')).toHaveLength(0);
  });

  it('窓口が「状態が変わった」(409) と断ったら、その言葉を出して一覧の画面へ戻り、申し込みを読み直す', async () => {
    let reads = 0;
    const { decline, onChanged } = await openDeclineScreen({
      routes: {
        read: () => {
          reads += 1;
          const request =
            reads === 1
              ? cancelRequest()
              : cancelRequest({
                  status: 'declined', declinedAt: '2026-10-12T02:00:00.000Z', declineReason: 'other', declineMessage: '別の人がお断りした',
                });
          return json({ data: readBody({ cancelRequests: [request] }) });
        },
        post: () => json({ error: STATE_CONFLICT_MESSAGE, code: 'CANCEL_REQUEST_STATE_CONFLICT' }, 409),
      },
    });
    fireEvent.change(reasonSelect(decline), { target: { value: 'window_passed' } });

    fireEvent.click(within(decline).getByRole('button', { name: 'お断りする' }));

    const list = await screen.findByRole('dialog', { name: LIST_TITLE });
    expect(await within(list).findByRole('alert')).toHaveTextContent(STATE_CONFLICT_MESSAGE);
    await waitFor(() => expect(within(list).getByTestId('cancel-request-item')).toHaveAttribute('data-status', 'declined'));
    expect(reads).toBe(2);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('入力の誤り（400）は、窓口の言葉を出して今の画面に留まる。続けて直して送れる', async () => {
    const { decline } = await openDeclineScreen({
      routes: {
        post: () => json({ error: 'お客様へのメッセージを入れてください（1000字まで）。', code: 'RETURN_DECLINE_MESSAGE_REQUIRED' }, 400),
      },
    });
    fireEvent.change(reasonSelect(decline), { target: { value: 'window_passed' } });

    fireEvent.click(within(decline).getByRole('button', { name: 'お断りする' }));

    expect(await within(decline).findByRole('alert')).toHaveTextContent('お客様へのメッセージを入れてください（1000字まで）。');
    expect(screen.getByRole('dialog', { name: DECLINE_TITLE })).toBeInTheDocument();
    expect(within(decline).getByRole('button', { name: 'お断りする' })).toBeEnabled();
    expect(readCount()).toBe(1);
  });

  it('通信が切れた時は、記録されたか分からないので、一覧の画面へ戻して読み直し、確かめられなかった旨を出す', async () => {
    const { decline, onChanged } = await openDeclineScreen({
      routes: { post: () => Promise.reject(new TypeError('Failed to fetch')) },
    });
    fireEvent.change(reasonSelect(decline), { target: { value: 'window_passed' } });

    fireEvent.click(within(decline).getByRole('button', { name: 'お断りする' }));

    const list = await screen.findByRole('dialog', { name: LIST_TITLE });
    expect(await within(list).findByRole('alert')).toHaveTextContent('結果を確かめられませんでした。申し込みの状態を読み直しました。');
    await waitFor(() => expect(readCount()).toBe(2));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('権限・回数の制限（401・403・429）で処理の前に断られた時は、その言葉を出して今の画面に留まる', async () => {
    const { decline, onChanged } = await openDeclineScreen({
      routes: { post: () => json({ error: 'forbidden' }, 403) },
    });
    fireEvent.change(reasonSelect(decline), { target: { value: 'window_passed' } });

    fireEvent.click(within(decline).getByRole('button', { name: 'お断りする' }));

    expect(await within(decline).findByRole('alert')).toHaveTextContent('この操作の権限がありません。');
    expect(screen.getByRole('dialog', { name: DECLINE_TITLE })).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('送っている間は「処理中...」と出し、戻る・Escape・二重の送信を受けない。終わったら onChanged を呼ぶ', async () => {
    let release: (response: Response) => void = () => undefined;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { decline, onChanged, onClose } = await openDeclineScreen({ routes: { post: () => held } });
    fireEvent.change(reasonSelect(decline), { target: { value: 'final_sale' } });

    fireEvent.click(within(decline).getByRole('button', { name: 'お断りする' }));

    expect(await within(decline).findByRole('button', { name: '処理中...' })).toBeDisabled();
    expect(within(decline).getByRole('button', { name: '戻る' })).toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(postsTo('/decline')).toHaveLength(1);

    await act(async () => {
      release(json({ data: { status: 'declined' } }));
    });

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('お断りしました。'));
    expect(postsTo('/decline')).toHaveLength(1);
  });
});

describe('OrderCancelRequestDialog の解決済みにする', () => {
  async function openCloseScreen(options: OpenOptions = {}) {
    const opened = await openList(options);
    fireEvent.click(within(opened.dialog).getByRole('button', { name: '解決済みにする' }));
    const confirm = await screen.findByRole('dialog', { name: CLOSE_TITLE });
    return { ...opened, confirm };
  }

  it('確かめの画面で「注文を変えず、メールも送らずに閉じます。」を出し、「戻る」で一覧の画面へ戻る。何も送らない', async () => {
    const { confirm } = await openCloseScreen();

    expect(within(confirm).getByText('注文を変えず、メールも送らずに閉じます。')).toBeInTheDocument();
    expect(within(confirm).getByRole('button', { name: '解決済みにする' })).toBeEnabled();

    fireEvent.click(within(confirm).getByRole('button', { name: '戻る' }));

    expect(await screen.findByRole('dialog', { name: LIST_TITLE })).toBeInTheDocument();
    expect(postsTo('/close')).toHaveLength(0);
  });

  it('「解決済みにする」を押すと、空の本文で close の窓口へ送り、済んだら onChanged に「解決済みにしました。」を渡す', async () => {
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    const { confirm, onChanged } = await openCloseScreen({
      routes: {
        post: (url, body) => {
          posts.push({ url, body });
          return json({ data: { status: 'closed' } });
        },
      },
    });

    fireEvent.click(within(confirm).getByRole('button', { name: '解決済みにする' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('解決済みにしました。'));
    expect(posts).toEqual([{ url: `/api/admin/cancel-requests/${REQUEST_ID}/close`, body: {} }]);
  });

  it('窓口が「状態が変わった」(409) と断ったら、その言葉を出して一覧の画面へ戻り、読み直す', async () => {
    const { confirm, onChanged } = await openCloseScreen({
      routes: { post: () => json({ error: STATE_CONFLICT_MESSAGE, code: 'CANCEL_REQUEST_STATE_CONFLICT' }, 409) },
    });

    fireEvent.click(within(confirm).getByRole('button', { name: '解決済みにする' }));

    const list = await screen.findByRole('dialog', { name: LIST_TITLE });
    expect(await within(list).findByRole('alert')).toHaveTextContent(STATE_CONFLICT_MESSAGE);
    await waitFor(() => expect(readCount()).toBe(2));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('権限・回数の制限（401・403・429）で処理の前に断られた時は、その言葉を出して確かめの画面に留まる', async () => {
    const { confirm, onChanged } = await openCloseScreen({
      routes: { post: () => json({ error: 'rate limited' }, 429) },
    });

    fireEvent.click(within(confirm).getByRole('button', { name: '解決済みにする' }));

    expect(await within(confirm).findByRole('alert')).toHaveTextContent('操作が続いたため受け付けませんでした。しばらく待ってから、もう一度お試しください。');
    expect(screen.getByRole('dialog', { name: CLOSE_TITLE })).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });
});
