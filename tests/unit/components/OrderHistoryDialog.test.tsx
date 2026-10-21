import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type {
  OrderHistoryCompletionEntry,
  OrderHistoryDeliveryEventEntry,
  OrderHistoryEmailEntry,
  OrderHistoryFulfillmentEntry,
  OrderHistoryRefundEntry,
  OrderHistoryRefundRereserveEntry,
  OrderHistoryResponse,
  OrderHistoryTrackingChangeEntry,
} from '@/lib/orders/email/order-history';
import type { OrderHistoryReturnEntry } from '@/lib/orders/email/order-history';
import type { OrderRefundStatus } from '@/lib/orders/refund/refund-types';
import type { OrderEmailStatus } from '@/lib/orders/email/order-email-types';
import type { DeliveryEvent, FulfillmentDeliveryDetail, TrackingChange } from '@/lib/orders/tracking/delivery-types';

const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));

import OrderHistoryDialog from '@/components/OrderHistoryDialog';

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function history(overrides: Partial<OrderHistoryResponse> = {}): OrderHistoryResponse {
  return {
    order: { id: ORDER_ID, orderNumber: 'ORD-A1B2C3D4', statusLabel: '決済完了', recipient: 'hanako@example.com' },
    sendPaused: null,
    entries: [
      {
        type: 'email', at: '2026-10-09T01:00:00.000Z', emailId: 'email-1', kind: 'paid', kindLabel: '注文確認', manual: false,
        requestedByEmail: null, stateLabel: '届かなかった', warning: true, attempts: 1, errorLabel: null,
        sentAt: '2026-10-09T01:00:05.000Z', deliveryEventAt: '2026-10-09T01:01:00.000Z', canViewContent: true, bodyErased: false, resendable: true,
        fulfillmentId: null, fulfillmentNumber: null,
      },
      { type: 'status', at: '2026-10-09T01:00:00.000Z', fromLabel: '支払い手続き中', toLabel: '決済完了', actorEmail: null, detail: null },
      { type: 'created', at: '2026-10-09T00:59:00.000Z' },
    ],
    ...overrides,
  };
}

/** 送信済みのメールの行（既定は自動で送った注文確認）。複数の行や手の再送の行を作る試験で使う */
function sentEmailEntry(overrides: Partial<OrderHistoryEmailEntry> = {}): OrderHistoryEmailEntry {
  return {
    type: 'email', at: '2026-10-09T01:00:00.000Z', emailId: 'email-1', kind: 'paid', kindLabel: '注文確認', manual: false,
    requestedByEmail: null, stateLabel: '送信済み', warning: false, attempts: 1, errorLabel: null,
    sentAt: '2026-10-09T01:00:05.000Z', deliveryEventAt: null, canViewContent: true, bodyErased: false, resendable: true,
    fulfillmentId: null, fulfillmentNumber: null,
    ...overrides,
  };
}

const SUBJECT = '【Le Fil des Heures】ご注文ありがとうございます';

/** メールの中身の窓口の返事（送信済み・本文あり） */
function contentBody(overrides: Record<string, unknown> = {}) {
  return { status: 'available', subject: SUBJECT, bodyText: '山田 花子 様\n\nご注文を承りました。', sentAt: '2026-10-09T01:00:05.000Z', ...overrides };
}

/** 実際の操作と同じく、押すボタンへ先にフォーカスを移してから押す（押したボタンが消えた時に、フォーカスがどこへ行くかを見るため） */
function press(button: HTMLElement) {
  button.focus();
  fireEvent.click(button);
}

/** 応答の順序を固定し、古い要求が後から終わる状況を再現する */
function deferredResponse() {
  let resolve: (value: Response) => void = () => {};
  let reject: (reason: Error) => void = () => {};
  const promise = new Promise<Response>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  mockClientFetch.mockReset();
});

describe('OrderHistoryDialog', () => {
  it('履歴を新しい順に出し、宛先と注意の印を出す', async () => {
    mockClientFetch.mockResolvedValueOnce(json(history()));

    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: 'この注文の履歴' });
    expect(mockClientFetch).toHaveBeenCalledWith(`/api/admin/orders/${ORDER_ID}/history`, { cache: 'no-store' });
    await within(dialog).findByText('宛先: hanako@example.com');
    const items = within(dialog).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('注文確認のメール');
    expect(items[0]).toHaveTextContent('注意');
    expect(items[0]).toHaveTextContent('届かなかった');
    expect(items[1]).toHaveTextContent('支払い手続き中 → 決済完了');
    expect(items[2]).toHaveTextContent('注文を受け付けました');
  });

  it('送信を止めていれば、その原因を出す', async () => {
    mockClientFetch.mockResolvedValueOnce(json(history({ sendPaused: { reasonLabel: '1日の送信の上限' } })));

    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);

    expect(await screen.findByText('メールの送信を一時停止しています（1日の送信の上限）')).toBeInTheDocument();
  });

  it('中身を見ると件名と本文を出し、「戻る」で履歴へ戻る', async () => {
    mockClientFetch
      .mockResolvedValueOnce(json(history()))
      .mockResolvedValueOnce(json({ status: 'available', subject: '【Le Fil des Heures】ご注文ありがとうございます', bodyText: '山田 花子 様\n\nご注文を承りました。', sentAt: '2026-10-09T01:00:05.000Z' }));

    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '中身を見る' }));

    expect(await screen.findByRole('dialog', { name: '注文確認のメールの中身' })).toBeInTheDocument();
    expect(mockClientFetch).toHaveBeenLastCalledWith(`/api/admin/orders/${ORDER_ID}/emails/email-1`, { cache: 'no-store' });
    // ダイアログの名前は押した直後（読み込み中）に変わるので、件名と本文は返事が届くまで待つ
    expect(await screen.findByText('【Le Fil des Heures】ご注文ありがとうございます')).toBeInTheDocument();
    expect(screen.getByText(/ご注文を承りました。/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '戻る' }));
    expect(screen.getByRole('dialog', { name: 'この注文の履歴' })).toBeInTheDocument();
  });

  it('本文を消した後は保存期間を過ぎたことを出す', async () => {
    mockClientFetch
      .mockResolvedValueOnce(json(history()))
      .mockResolvedValueOnce(json({ status: 'erased', sentAt: '2026-08-01T00:00:00.000Z' }));

    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '中身を見る' }));

    expect(await screen.findByText('本文の保存期間（45日）を過ぎました')).toBeInTheDocument();
  });

  it('再送は確かめてから送り、受け付けたら履歴を読み直す。送っている間はボタンを押せない', async () => {
    let resolvePost: (value: Response) => void = () => {};
    mockClientFetch
      .mockResolvedValueOnce(json(history()))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolvePost = resolve; }))
      .mockResolvedValueOnce(json(history()));

    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'お客様へ再送' }));

    expect(screen.getByRole('dialog', { name: 'お客様へ再送' })).toBeInTheDocument();
    expect(screen.getByText('注文確認のメールを、お客様（注文のメールアドレス）へもう一度送ります')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '再送する' }));

    expect(screen.getByRole('button', { name: '再送する' })).toBeDisabled();
    expect(mockClientFetch).toHaveBeenNthCalledWith(2, `/api/admin/orders/${ORDER_ID}/emails/resend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'paid' }),
    });

    resolvePost(json({ success: true, emailId: 'email-2' }));
    expect(await screen.findByText('再送を受け付けました。少し待つと届きます。')).toBeInTheDocument();
    expect(mockClientFetch).toHaveBeenCalledTimes(3);
  });

  it('「やめる」では送らない。断られたら理由を出す', async () => {
    mockClientFetch
      .mockResolvedValueOnce(json(history()))
      .mockResolvedValueOnce(json({ error: '同じメールの再送がまだ送られていません。少し待ってから履歴を確かめてください。' }, 409))
      .mockResolvedValueOnce(json(history()));

    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'お客様へ再送' }));
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    expect(mockClientFetch).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'お客様へ再送' }));
    fireEvent.click(screen.getByRole('button', { name: '再送する' }));
    expect(await screen.findByText('同じメールの再送がまだ送られていません。少し待ってから履歴を確かめてください。')).toBeInTheDocument();
  });

  it('権限・回数の制限など共通の守りの断りは英語の短い文なので出さず、日本語の文を出す', async () => {
    mockClientFetch
      .mockResolvedValueOnce(json(history()))
      .mockResolvedValueOnce(json({ error: 'Too many requests' }, 429))
      .mockResolvedValueOnce(json(history()));

    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'お客様へ再送' }));
    fireEvent.click(screen.getByRole('button', { name: '再送する' }));

    expect(await screen.findByText('再送を受け付けられませんでした。')).toBeInTheDocument();
    expect(screen.queryByText('Too many requests')).not.toBeInTheDocument();
  });

  it('再送できない行にはボタンを出さず、読めなければ知らせる', async () => {
    const entries = history().entries.map((entry) => (entry.type === 'email' ? { ...entry, resendable: false, canViewContent: false } : entry));
    mockClientFetch.mockResolvedValueOnce(json(history({ entries })));
    const { unmount } = render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
    await screen.findByText('宛先: hanako@example.com');
    expect(screen.queryByRole('button', { name: 'お客様へ再送' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '中身を見る' })).not.toBeInTheDocument();
    unmount();

    mockClientFetch.mockResolvedValueOnce(json({ error: 'Forbidden' }, 403));
    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
    // 知らせの入れ物（role="alert"）は最初から置いてあるので、文字が入るのを待つ
    expect(await screen.findByText('履歴を見る権限がありません。')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('履歴を見る権限がありません。');
  });

  it('Escape で閉じる', async () => {
    mockClientFetch.mockResolvedValueOnce(json(history()));
    const onClose = jest.fn();

    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={onClose} />);
    await screen.findByText('宛先: hanako@example.com');
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('閉じたら、開く前にフォーカスがあったボタンへ戻る', async () => {
    mockClientFetch.mockResolvedValueOnce(json(history()));
    function Harness() {
      const [orderId, setOrderId] = useState<string | null>(null);
      return (
        <>
          <button type="button" onClick={() => setOrderId(ORDER_ID)}>
            履歴を開く
          </button>
          <OrderHistoryDialog orderId={orderId} onClose={() => setOrderId(null)} />
        </>
      );
    }

    render(<Harness />);
    const opener = screen.getByRole('button', { name: '履歴を開く' });
    opener.focus();
    fireEvent.click(opener);
    await screen.findByText('宛先: hanako@example.com');
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('閉じて別の注文で開き直すと、前の注文の画面を引き継がず、フォーカスは中の「閉じる」へ移る', async () => {
    mockClientFetch.mockResolvedValueOnce(json(history()));
    const { rerender } = render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
    await screen.findByText('宛先: hanako@example.com');

    rerender(<OrderHistoryDialog orderId={null} onClose={jest.fn()} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // 次の注文の返事はまだ届かない間を確かめる
    mockClientFetch.mockImplementationOnce(() => new Promise<Response>(() => {}));
    rerender(<OrderHistoryDialog orderId="b1b2c3d4-1111-2222-8333-444455556666" onClose={jest.fn()} />);

    expect(screen.getByText('読み込み中です...')).toBeInTheDocument();
    expect(screen.queryByText('宛先: hanako@example.com')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '閉じる' })).toHaveFocus();
  });
});

// 設計書 5-5: 開いている間はフォーカスが中に留まる。画面を切り替えると、押したボタンごと画面が消える
describe('OrderHistoryDialog の画面の切り替えとフォーカス', () => {
  it('「戻る」「やめる」で履歴へ戻ると、同じメールの画面を開いた行のボタンへフォーカスが戻る', async () => {
    mockClientFetch.mockResolvedValueOnce(json(history({ entries: [sentEmailEntry({ emailId: 'email-2' }), sentEmailEntry()] })))
      .mockResolvedValueOnce(json(contentBody()));

    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
    press((await screen.findAllByRole('button', { name: '中身を見る' }))[1]);
    await screen.findByText(SUBJECT);
    expect(screen.getByRole('dialog', { name: '注文確認のメールの中身' })).toHaveFocus();

    press(screen.getByRole('button', { name: '戻る' }));
    expect(screen.getAllByRole('button', { name: '中身を見る' })[1]).toHaveFocus();

    press(screen.getAllByRole('button', { name: 'お客様へ再送' })[1]);
    expect(screen.getByRole('dialog', { name: 'お客様へ再送' })).toHaveFocus();

    press(screen.getByRole('button', { name: 'やめる' }));
    expect(screen.getAllByRole('button', { name: 'お客様へ再送' })[1]).toHaveFocus();
  });

  it('履歴へ戻る時に開いた行のボタンがもう無ければ、パネルへフォーカスを移す', async () => {
    const post = deferredResponse();
    mockClientFetch.mockResolvedValueOnce(json(history({ entries: [sentEmailEntry(), sentEmailEntry({ emailId: 'email-2' })] })))
      .mockReturnValueOnce(post.promise)
      .mockResolvedValueOnce(json(history({ entries: [sentEmailEntry({ resendable: false }), sentEmailEntry({ emailId: 'email-2', resendable: false })] })));
    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
    press((await screen.findAllByRole('button', { name: 'お客様へ再送' }))[0]);
    press(screen.getByRole('button', { name: '再送する' }));
    press(screen.getByRole('button', { name: 'やめる' }));
    press(screen.getAllByRole('button', { name: 'お客様へ再送' })[1]);
    await act(async () => { post.resolve(json({ success: true, emailId: 'email-3' })); });
    press(screen.getByRole('button', { name: 'やめる' }));

    expect(screen.queryByRole('button', { name: 'お客様へ再送' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'この注文の履歴' })).toHaveFocus();
  });

  it('再送の返事を待つ間に「やめる」を押したら、返事の後の読み直しで消える再送のボタンではなく、パネルへフォーカスを移す', async () => {
    const post = deferredResponse();
    mockClientFetch.mockResolvedValueOnce(json(history()))
      .mockReturnValueOnce(post.promise)
      .mockResolvedValueOnce(json(history({ entries: [sentEmailEntry({ resendable: false })] })));
    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
    press(await screen.findByRole('button', { name: 'お客様へ再送' }));
    press(screen.getByRole('button', { name: '再送する' }));
    press(screen.getByRole('button', { name: 'やめる' }));

    const panel = screen.getByRole('dialog', { name: 'この注文の履歴' });
    expect(panel).toHaveFocus();
    expect(screen.getByRole('button', { name: 'お客様へ再送' })).not.toHaveFocus();

    // 受け付けた後の読み直しで、再送のボタンが無くなる。フォーカスは body へ落ちず、パネルに留まる
    await act(async () => { post.resolve(json({ success: true, emailId: 'email-2' })); });
    expect(screen.queryByRole('button', { name: 'お客様へ再送' })).not.toBeInTheDocument();
    expect(panel).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent('再送を受け付けました。少し待つと届きます。');
  });

  it('再送が終わって履歴へ戻る時も、フォーカスはダイアログのパネルに留まる', async () => {
    mockClientFetch
      .mockResolvedValueOnce(json(history()))
      .mockResolvedValueOnce(json({ success: true, emailId: 'email-2' }))
      .mockResolvedValueOnce(json(history()));

    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
    press(await screen.findByRole('button', { name: 'お客様へ再送' }));
    press(screen.getByRole('button', { name: '再送する' }));
    await screen.findByText('再送を受け付けました。少し待つと届きます。');

    await waitFor(() => expect(screen.getByRole('dialog', { name: 'この注文の履歴' })).toHaveFocus());
  });

  it('最初の画面（履歴）では、フォーカスをパネルへ動かさない（Dialog が開いた時に決めた場所のまま）', async () => {
    mockClientFetch.mockResolvedValueOnce(json(history()));

    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
    await screen.findByText('宛先: hanako@example.com');

    expect(screen.getByRole('button', { name: '閉じる' })).toHaveFocus();
  });
});

// 結果の知らせは、画面の切り替えや履歴の読み直しの条件の外に最初から置いた入れ物の中の文字だけを変える
// （後から差し込んだ入れ物は読み上げられない環境が多い）。受け付けは status、断り・失敗は alert
describe('OrderHistoryDialog の再送の結果の知らせ', () => {
  const REFUSAL = '同じメールの再送がまだ送られていません。少し待ってから履歴を確かめてください。';

  it('再送の受け付けは、履歴のパネルへフォーカスを移した後の描画で status に入る', async () => {
    const post = deferredResponse();
    mockClientFetch.mockResolvedValueOnce(json(history())).mockReturnValueOnce(post.promise).mockResolvedValueOnce(json(history()));
    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
    press(await screen.findByRole('button', { name: 'お客様へ再送' }));
    press(screen.getByRole('button', { name: '再送する' }));
    const dialog = screen.getByRole('dialog', { name: 'お客様へ再送' });
    const status = screen.getByRole('status');
    const textsAtFocus: string[] = [];
    dialog.addEventListener('focus', () => { textsAtFocus.push(status.textContent ?? ''); });
    await act(async () => { post.resolve(json({ success: true, emailId: 'email-2' })); });

    expect(textsAtFocus).toEqual(['']);
    expect(dialog).toHaveFocus();
    expect(status).toHaveTextContent('再送を受け付けました。少し待つと届きます。');
  });

  it('入れ物は最初から置いてあり、同じ要素の文字だけが変わる（受け付けは status）', async () => {
    mockClientFetch
      .mockResolvedValueOnce(json(history()))
      .mockResolvedValueOnce(json({ success: true, emailId: 'email-2' }))
      .mockResolvedValueOnce(json(history()));

    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
    await screen.findByText('宛先: hanako@example.com');
    const status = screen.getByRole('status');
    const alert = screen.getByRole('alert');
    expect(status).toBeEmptyDOMElement();
    expect(alert).toBeEmptyDOMElement();

    press(screen.getByRole('button', { name: 'お客様へ再送' }));
    press(screen.getByRole('button', { name: '再送する' }));
    await screen.findByText('再送を受け付けました。少し待つと届きます。');

    expect(screen.getByRole('status')).toBe(status);
    expect(status).toHaveTextContent('再送を受け付けました。少し待つと届きます。');
    expect(screen.getByRole('alert')).toBe(alert);
    expect(alert).toBeEmptyDOMElement();
  });

  it('再送の後に履歴の読み直しが失敗しても、受け付けの知らせは消えない', async () => {
    mockClientFetch
      .mockResolvedValueOnce(json(history()))
      .mockResolvedValueOnce(json({ success: true, emailId: 'email-2' }))
      .mockResolvedValueOnce(json({ error: 'Failed to load history' }, 500));

    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
    press(await screen.findByRole('button', { name: 'お客様へ再送' }));
    press(screen.getByRole('button', { name: '再送する' }));

    expect(await screen.findByText('履歴を読み込めませんでした。')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('履歴を読み込めませんでした。');
    await screen.findByText('再送を受け付けました。少し待つと届きます。');
    expect(screen.getByRole('status')).toHaveTextContent('再送を受け付けました。少し待つと届きます。');
  });

  it('断られたら role="alert" の入れ物に出し、status には出さない', async () => {
    mockClientFetch
      .mockResolvedValueOnce(json(history()))
      .mockResolvedValueOnce(json({ error: REFUSAL }, 409))
      .mockResolvedValueOnce(json(history()));

    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
    press(await screen.findByRole('button', { name: 'お客様へ再送' }));
    press(screen.getByRole('button', { name: '再送する' }));

    expect(await screen.findByText(REFUSAL)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(REFUSAL);
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('通信が失敗しても、role="alert" の入れ物に一般の文を出す', async () => {
    mockClientFetch
      .mockResolvedValueOnce(json(history()))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json(history()));

    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
    press(await screen.findByRole('button', { name: 'お客様へ再送' }));
    press(screen.getByRole('button', { name: '再送する' }));

    expect(await screen.findByText('再送を受け付けられませんでした。')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('再送を受け付けられませんでした。');
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('403 で断られたら、管理画面の隣の操作と同じ「この操作の権限がありません。」を出す（英語は出さない）', async () => {
    mockClientFetch
      .mockResolvedValueOnce(json(history()))
      .mockResolvedValueOnce(json({ error: 'Forbidden', permission: 'admin.orders.manage' }, 403))
      .mockResolvedValueOnce(json(history()));

    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
    press(await screen.findByRole('button', { name: 'お客様へ再送' }));
    press(screen.getByRole('button', { name: '再送する' }));

    expect(await screen.findByText('この操作の権限がありません。')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('この操作の権限がありません。');
    expect(screen.queryByText('Forbidden')).not.toBeInTheDocument();
  });

  it('受け付けたら履歴を読み直し（3回目は履歴の窓口）、手で再送した行を出す', async () => {
    const reloaded = history({
      entries: [
        sentEmailEntry({
          emailId: 'email-2', at: '2026-10-09T02:00:00.000Z', manual: true, requestedByEmail: 'admin@example.com',
          stateLabel: '送信待ち', sentAt: null, canViewContent: false, resendable: false,
        }),
        sentEmailEntry({ resendable: false }),
      ],
    });
    mockClientFetch
      .mockResolvedValueOnce(json(history()))
      .mockResolvedValueOnce(json({ success: true, emailId: 'email-2' }))
      .mockResolvedValueOnce(json(reloaded));

    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
    press(await screen.findByRole('button', { name: 'お客様へ再送' }));
    press(screen.getByRole('button', { name: '再送する' }));

    expect(await screen.findByText('手で再送（admin@example.com）')).toBeInTheDocument();
    expect(mockClientFetch).toHaveBeenCalledTimes(3);
    expect(mockClientFetch).toHaveBeenNthCalledWith(3, `/api/admin/orders/${ORDER_ID}/history`, { cache: 'no-store' });
    expect(screen.queryByRole('button', { name: 'お客様へ再送' })).not.toBeInTheDocument();
  });

  it('前の知らせは、別の画面へ移ると消える（中身の画面に「受け付けました」を残さない）', async () => {
    mockClientFetch
      .mockResolvedValueOnce(json(history()))
      .mockResolvedValueOnce(json({ success: true, emailId: 'email-2' }))
      .mockResolvedValueOnce(json(history({ entries: [sentEmailEntry({ resendable: false })] })))
      .mockResolvedValueOnce(json(contentBody()));

    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
    press(await screen.findByRole('button', { name: 'お客様へ再送' }));
    press(screen.getByRole('button', { name: '再送する' }));
    await screen.findByText('再送を受け付けました。少し待つと届きます。');
    press(await screen.findByRole('button', { name: '中身を見る' }));
    await screen.findByText(SUBJECT);

    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });
});

// 利用者が先へ進んだ後に、遅れて届いた返事で画面を引き戻さない
describe('OrderHistoryDialog の遅れて届いた返事', () => {
  const contentUrl = (emailId: string) => `/api/admin/orders/${ORDER_ID}/emails/${emailId}`;

  /** 履歴は二通（email-2 が新しく上、email-1 が下）。中身の返事は試験が返すまで止めておく */
  function holdContents() {
    const pending: Record<string, (value: Response) => void> = {};
    const twoEmails = history({ entries: [sentEmailEntry({ emailId: 'email-2', at: '2026-10-09T02:00:00.000Z' }), sentEmailEntry()] });
    mockClientFetch.mockImplementation((url: string) => {
      if (url.endsWith('/history')) return Promise.resolve(json(twoEmails));
      return new Promise<Response>((resolve) => {
        pending[url] = resolve;
      });
    });
    return pending;
  }

  it.each(['HTTP', '通信', 'JSON'])('別のメールを開いた後、前の中身の読み込みが %s で失敗しても今の画面に誤りを出さない', async (failure) => {
    const oldContent = deferredResponse();
    mockClientFetch.mockResolvedValueOnce(json(history({ entries: [sentEmailEntry(), sentEmailEntry({ emailId: 'email-2', kindLabel: '発送' })] })))
      .mockReturnValueOnce(oldContent.promise).mockResolvedValueOnce(json(contentBody({ subject: 'B の件名' })));
    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
    press((await screen.findAllByRole('button', { name: '中身を見る' }))[0]);
    press(screen.getByRole('button', { name: '戻る' }));
    press(screen.getAllByRole('button', { name: '中身を見る' })[1]);
    await screen.findByText('B の件名');
    await act(async () => {
      if (failure === '通信') oldContent.reject(new TypeError('Failed to fetch'));
      else if (failure === 'JSON') oldContent.resolve({ ...json({}), json: async () => { throw new SyntaxError('Invalid JSON'); } } as Response);
      else oldContent.resolve(json({}, 500));
    });

    expect(screen.getByRole('dialog', { name: '発送のメールの中身' })).toBeInTheDocument();
    expect(screen.getByText('B の件名')).toBeInTheDocument();
    expect(screen.queryByText('メールの中身を読み込めませんでした。')).not.toBeInTheDocument();
  });

  it.each(['成功', 'HTTP の失敗', '通信の失敗'])('同じメールを開き直した後、前の要求が %s で終わっても新しい中身を上書きしない', async (result) => {
    const oldContent = deferredResponse();
    mockClientFetch.mockResolvedValueOnce(json(history())).mockReturnValueOnce(oldContent.promise)
      .mockResolvedValueOnce(json(contentBody({ subject: '新しい件名' })));
    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
    press(await screen.findByRole('button', { name: '中身を見る' }));
    press(screen.getByRole('button', { name: '戻る' }));
    press(screen.getByRole('button', { name: '中身を見る' }));
    await screen.findByText('新しい件名');
    await act(async () => {
      if (result === '通信の失敗') oldContent.reject(new TypeError('Failed to fetch'));
      else oldContent.resolve(result === '成功' ? json(contentBody({ subject: '古い件名' })) : json({}, 500));
    });

    expect(screen.getByText('新しい件名')).toBeInTheDocument();
    expect(screen.queryByText('古い件名')).not.toBeInTheDocument();
    expect(screen.queryByText('メールの中身を読み込めませんでした。')).not.toBeInTheDocument();
  });

  it.each(['成功', '拒否', '通信の失敗'])('別の行の再送の確かめへ移った後、前の再送が %s で終わっても画面と知らせを変えない', async (result) => {
    const post = deferredResponse();
    const twoEmails = history({ entries: [sentEmailEntry(), sentEmailEntry({ emailId: 'email-2', kindLabel: '発送', kind: 'shipped' })] });
    mockClientFetch.mockResolvedValueOnce(json(twoEmails)).mockReturnValueOnce(post.promise).mockResolvedValueOnce(json(twoEmails));
    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
    press((await screen.findAllByRole('button', { name: 'お客様へ再送' }))[0]);
    press(screen.getByRole('button', { name: '再送する' }));
    press(screen.getByRole('button', { name: 'やめる' }));
    press(screen.getAllByRole('button', { name: 'お客様へ再送' })[1]);
    await act(async () => {
      if (result === '通信の失敗') post.reject(new TypeError('Failed to fetch'));
      else post.resolve(result === '成功' ? json({ success: true, emailId: 'email-3' }) : json({ error: '今は再送できません。' }, 409));
    });

    expect(screen.getByRole('dialog', { name: 'お客様へ再送' })).toHaveTextContent('発送のメールを、お客様（注文のメールアドレス）へもう一度送ります');
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();
    expect(screen.getByRole('button', { name: '再送する' })).toBeEnabled();
  });

  it.each([
    ['成功', 'status', '再送を受け付けました。少し待つと届きます。'],
    ['拒否', 'alert', '今は再送できません。'],
    ['通信の失敗', 'alert', '再送を受け付けられませんでした。'],
  ] as const)('別の行の再送の確かめを開いている間に前の再送が %s で終わったら、知らせは取っておき、履歴へ戻った時に出す', async (result, role, text) => {
    const post = deferredResponse();
    const twoEmails = history({ entries: [sentEmailEntry(), sentEmailEntry({ emailId: 'email-2', kindLabel: '発送', kind: 'shipped' })] });
    mockClientFetch.mockResolvedValueOnce(json(twoEmails)).mockReturnValueOnce(post.promise).mockResolvedValueOnce(json(twoEmails));
    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
    press((await screen.findAllByRole('button', { name: 'お客様へ再送' }))[0]);
    press(screen.getByRole('button', { name: '再送する' }));
    press(screen.getByRole('button', { name: 'やめる' }));
    press(screen.getAllByRole('button', { name: 'お客様へ再送' })[1]);
    await act(async () => {
      if (result === '通信の失敗') post.reject(new TypeError('Failed to fetch'));
      else post.resolve(result === '成功' ? json({ success: true, emailId: 'email-3' }) : json({ error: '今は再送できません。' }, 409));
    });
    // 別の行の確かめを見ている間は、その行の結果と誤解されないよう、知らせを出さない
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();

    press(screen.getByRole('button', { name: 'やめる' }));

    expect(screen.getByRole('dialog', { name: 'この注文の履歴' })).toBeInTheDocument();
    expect(screen.getByRole(role)).toHaveTextContent(text);
    expect(screen.getByRole(role === 'status' ? 'alert' : 'status')).toBeEmptyDOMElement();
  });

  it('中身の返事を待つ間に「戻る」を押したら、返事が届いても履歴の画面のまま', async () => {
    const pending = holdContents();

    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
    press((await screen.findAllByRole('button', { name: '中身を見る' }))[0]);
    press(screen.getByRole('button', { name: '戻る' }));

    await act(async () => {
      pending[contentUrl('email-2')](json(contentBody({ subject: '二通目の件名' })));
    });

    expect(screen.getByRole('dialog', { name: 'この注文の履歴' })).toBeInTheDocument();
    expect(screen.queryByText('二通目の件名')).not.toBeInTheDocument();
  });

  it('A を開いて戻り、B を開いた後に A の返事が届いても、B の画面（読み込み中）のまま', async () => {
    const pending = holdContents();

    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
    press((await screen.findAllByRole('button', { name: '中身を見る' }))[1]);
    press(screen.getByRole('button', { name: '戻る' }));
    press(screen.getAllByRole('button', { name: '中身を見る' })[0]);
    expect(screen.getByText('読み込み中です...')).toBeInTheDocument();

    await act(async () => {
      pending[contentUrl('email-1')](json(contentBody({ subject: 'A の件名' })));
    });
    expect(screen.getByText('読み込み中です...')).toBeInTheDocument();
    expect(screen.queryByText('A の件名')).not.toBeInTheDocument();

    await act(async () => {
      pending[contentUrl('email-2')](json(contentBody({ subject: 'B の件名' })));
    });
    expect(screen.getByText('B の件名')).toBeInTheDocument();
    expect(screen.queryByText('A の件名')).not.toBeInTheDocument();
  });

  it('再送の返事を待つ間に別の画面へ移っていたら、画面は変えずに知らせだけ出す', async () => {
    let resolvePost: (value: Response) => void = () => {};
    mockClientFetch.mockImplementation((url: string) => {
      if (url.endsWith('/history')) return Promise.resolve(json(history()));
      if (url.endsWith('/emails/resend')) {
        return new Promise<Response>((resolve) => {
          resolvePost = resolve;
        });
      }
      // 中身の返事は届かないまま
      return new Promise<Response>(() => {});
    });

    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
    press(await screen.findByRole('button', { name: 'お客様へ再送' }));
    press(screen.getByRole('button', { name: '再送する' }));
    // 再送の返事を待つ間に履歴へ戻り、別の画面（中身）を開く
    press(screen.getByRole('button', { name: 'やめる' }));
    press(screen.getByRole('button', { name: '中身を見る' }));

    await act(async () => {
      resolvePost(json({ success: true, emailId: 'email-2' }));
    });

    expect(screen.getByRole('dialog', { name: '注文確認のメールの中身' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('再送を受け付けました。少し待つと届きます。');
  });
});

describe('OrderHistoryDialog の中身の画面', () => {
  it('送った時刻（日本時間）を出し、手で再送した行には「手で再送」の印も出す', async () => {
    const entries = [sentEmailEntry({ manual: true, requestedByEmail: 'admin@example.com' })];
    mockClientFetch.mockResolvedValueOnce(json(history({ entries }))).mockResolvedValueOnce(json(contentBody()));

    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
    press(await screen.findByRole('button', { name: '中身を見る' }));

    const dialog = await screen.findByRole('dialog', { name: '注文確認のメールの中身' });
    expect(await within(dialog).findByText('送った時刻: 2026/10/09 10:00')).toBeInTheDocument();
    expect(within(dialog).getByText('手で再送（admin@example.com）')).toBeInTheDocument();
  });

  it('自動で送ったメールには「手で再送」の印を出さない。本文を消した後でも送った時刻は出す', async () => {
    mockClientFetch
      .mockResolvedValueOnce(json(history({ entries: [sentEmailEntry()] })))
      .mockResolvedValueOnce(json({ status: 'erased', sentAt: '2026-08-01T05:30:00.000Z' }));

    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
    press(await screen.findByRole('button', { name: '中身を見る' }));

    const dialog = await screen.findByRole('dialog', { name: '注文確認のメールの中身' });
    expect(await within(dialog).findByText('送った時刻: 2026/08/01 14:30')).toBeInTheDocument();
    expect(within(dialog).getByText('本文の保存期間（45日）を過ぎました')).toBeInTheDocument();
    expect(within(dialog).queryByText(/手で再送/)).not.toBeInTheDocument();
  });

  it('本文の欄は、キーボードで届いてスクロールできるよう、フォーカスでき、名前が付く', async () => {
    mockClientFetch.mockResolvedValueOnce(json(history())).mockResolvedValueOnce(json(contentBody()));

    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
    press(await screen.findByRole('button', { name: '中身を見る' }));

    const body = await screen.findByRole('region', { name: 'メールの本文' });
    expect(body).toHaveAttribute('tabindex', '0');
    expect(body).toHaveTextContent('ご注文を承りました。');
    body.focus();
    expect(body).toHaveFocus();
  });
});

// 発送と仕上がり（グループ E-1）。履歴の窓口が返す4つの行の出し方と、発送・仕上がりの取消
const FULFILLMENT_ID = 'f1f1f1f1-1111-2222-8333-444455556666';
const COMPLETION_ID = 'c1c1c1c1-1111-2222-8333-444455556666';
const CANCEL_FULFILLMENT_URL = `/api/admin/orders/${ORDER_ID}/fulfillments/${FULFILLMENT_ID}/cancel`;
const CANCEL_COMPLETION_URL = `/api/admin/orders/${ORDER_ID}/completions/${COMPLETION_ID}/cancel`;
const HISTORY_URL = `/api/admin/orders/${ORDER_ID}/history`;

function fulfillmentEntry(overrides: Partial<OrderHistoryFulfillmentEntry> = {}): OrderHistoryFulfillmentEntry {
  return {
    type: 'fulfillment', at: '2026-10-10T02:00:00.000Z', fulfillmentId: FULFILLMENT_ID, number: 1, carrierLabel: 'ヤマト運輸',
    trackingNumber: '1234-5678', items: [{ name: 'シルクブラウス', quantity: 2 }], actorEmail: 'admin@example.com',
    notifyCustomer: true, completesOrder: false, cancelled: false, cancellable: true, legacy: false,
    ...overrides,
  };
}

function completionEntry(overrides: Partial<OrderHistoryCompletionEntry> = {}): OrderHistoryCompletionEntry {
  return {
    type: 'completion', at: '2026-10-10T01:00:00.000Z', completionId: COMPLETION_ID, items: [{ name: 'ウールコート', quantity: 1 }],
    actorEmail: 'admin@example.com', cancelled: false, cancellable: true, legacy: false,
    ...overrides,
  };
}

describe('OrderHistoryDialog の発送と仕上がりの行', () => {
  it('発送・発送の取消・仕上がり・仕上がりの取消の行を、決まった言葉で出す', async () => {
    const entries: OrderHistoryResponse['entries'] = [
      fulfillmentEntry({ number: 2, completesOrder: true, items: [{ name: 'シルクブラウス', quantity: 2 }, { name: 'ウールコート', quantity: 1 }] }),
      { type: 'fulfillment_cancel', at: '2026-10-10T03:00:00.000Z', fulfillmentId: 'fulfillment-0', number: 1, actorEmail: 'admin@example.com' },
      completionEntry(),
      { type: 'completion_cancel', at: '2026-10-10T00:30:00.000Z', completionId: 'completion-0', actorEmail: 'admin@example.com' },
    ];
    mockClientFetch.mockResolvedValueOnce(json(history({ entries })));

    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: 'この注文の履歴' });
    await within(dialog).findByText('宛先: hanako@example.com');
    const items = within(dialog).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent('発送（2回目）');
    expect(items[0]).toHaveTextContent('配送業者: ヤマト運輸 / 伝票番号: 1234-5678');
    expect(items[0]).toHaveTextContent('商品: シルクブラウス × 2 / ウールコート × 1');
    expect(items[0]).toHaveTextContent('お客様へのメール: 送る');
    expect(items[0]).toHaveTextContent('この発送で全部を送りました');
    expect(items[0]).toHaveTextContent('操作: admin@example.com');
    expect(items[1]).toHaveTextContent('発送（1回目）を取り消しました');
    expect(items[1]).toHaveTextContent('操作: admin@example.com');
    expect(items[2]).toHaveTextContent('受注生産の品が仕上がりました');
    expect(items[2]).toHaveTextContent('商品: ウールコート × 1');
    expect(items[3]).toHaveTextContent('仕上がりを取り消しました');
    expect(within(items[0]).getByRole('button', { name: 'この発送を取り消す' })).toBeInTheDocument();
    expect(within(items[2]).getByRole('button', { name: 'この仕上がりを取り消す' })).toBeInTheDocument();
  });

  it('メールを送らなかった発送と、一部だけの発送は、その通りに出す。取り消し済みの行には印を出し、取消のボタンは出さない', async () => {
    const entries: OrderHistoryResponse['entries'] = [
      fulfillmentEntry({ notifyCustomer: false, completesOrder: false }),
      fulfillmentEntry({ fulfillmentId: 'fulfillment-2', number: 2, cancelled: true, cancellable: false }),
      completionEntry({ cancelled: true, cancellable: false }),
    ];
    mockClientFetch.mockResolvedValueOnce(json(history({ entries })));

    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: 'この注文の履歴' });
    await within(dialog).findByText('宛先: hanako@example.com');
    const items = within(dialog).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('お客様へのメール: 送らない');
    expect(items[0]).not.toHaveTextContent('この発送で全部を送りました');
    expect(items[0]).not.toHaveTextContent('取り消し済み');
    expect(items[1]).toHaveTextContent('取り消し済み');
    expect(items[2]).toHaveTextContent('取り消し済み');
    expect(within(dialog).getAllByRole('button', { name: 'この発送を取り消す' })).toHaveLength(1);
    expect(within(dialog).queryByRole('button', { name: 'この仕上がりを取り消す' })).not.toBeInTheDocument();
  });

  it('発送のメールの行は「発送（n回目）のメール」と出し、再送はその発送の番号を窓口へ送る', async () => {
    const shippedEmail = sentEmailEntry({
      emailId: 'email-9', kind: 'shipped', kindLabel: '発送（2回目）', fulfillmentId: FULFILLMENT_ID, fulfillmentNumber: 2,
    });
    mockClientFetch
      .mockResolvedValueOnce(json(history({ entries: [shippedEmail] })))
      .mockResolvedValueOnce(json({ success: true, emailId: 'email-10' }))
      .mockResolvedValueOnce(json(history({ entries: [shippedEmail] })));

    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);

    expect(await screen.findByText('発送（2回目）のメール')).toBeInTheDocument();
    press(screen.getByRole('button', { name: 'お客様へ再送' }));
    expect(screen.getByRole('dialog', { name: 'お客様へ再送' })).toHaveTextContent(
      '発送（2回目）のメールを、お客様（注文のメールアドレス）へもう一度送ります',
    );
    press(screen.getByRole('button', { name: '再送する' }));

    await screen.findByText('再送を受け付けました。少し待つと届きます。');
    expect(mockClientFetch).toHaveBeenNthCalledWith(2, `/api/admin/orders/${ORDER_ID}/emails/resend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'shipped', fulfillmentId: FULFILLMENT_ID }),
    });
  });
});

describe('OrderHistoryDialog の発送の取消', () => {
  it('確かめの画面の文を出し、「取り消す」で窓口へ送り、履歴を読み直して、親に知らせる', async () => {
    const reloaded = history({
      entries: [
        { type: 'fulfillment_cancel', at: '2026-10-10T03:00:00.000Z', fulfillmentId: FULFILLMENT_ID, number: 1, actorEmail: 'admin@example.com' },
        fulfillmentEntry({ cancelled: true, cancellable: false }),
        { type: 'created', at: '2026-10-09T00:59:00.000Z' },
      ],
    });
    mockClientFetch
      .mockResolvedValueOnce(json(history({ entries: [fulfillmentEntry(), { type: 'created', at: '2026-10-09T00:59:00.000Z' }] })))
      .mockResolvedValueOnce(json({ outcome: 'cancelled', orderStatus: 'paid' }))
      .mockResolvedValueOnce(json(reloaded));
    const onChanged = jest.fn();
    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} onChanged={onChanged} />);

    press(await screen.findByRole('button', { name: 'この発送を取り消す' }));

    expect(screen.getByRole('dialog', { name: 'この発送を取り消す' })).toHaveTextContent(
      '発送（1回目）を取り消し、その商品を発送準備中に戻します。お客様にメールは送りません。送った発送のメールがあれば、店からお客様に連絡してください。',
    );
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
    press(screen.getByRole('button', { name: '取り消す' }));

    expect(await screen.findByText('発送（1回目）を取り消しました。')).toBeInTheDocument();
    expect(mockClientFetch).toHaveBeenNthCalledWith(2, CANCEL_FULFILLMENT_URL, { method: 'POST' });
    expect(mockClientFetch).toHaveBeenNthCalledWith(3, HISTORY_URL, { cache: 'no-store' });
    expect(onChanged).toHaveBeenCalledTimes(1);
    const dialog = screen.getByRole('dialog', { name: 'この注文の履歴' });
    expect(screen.getByRole('status')).toHaveTextContent('発送（1回目）を取り消しました。');
    expect(within(dialog).queryByRole('button', { name: 'この発送を取り消す' })).not.toBeInTheDocument();
    const items = within(dialog).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('発送（1回目）を取り消しました');
    expect(items[1]).toHaveTextContent('取り消し済み');
  });

  it('もう取り消してあった（already_cancelled）時も、取り消せた時と同じ知らせにする', async () => {
    mockClientFetch
      .mockResolvedValueOnce(json(history({ entries: [fulfillmentEntry()] })))
      .mockResolvedValueOnce(json({ outcome: 'already_cancelled', orderStatus: 'paid' }))
      .mockResolvedValueOnce(json(history({ entries: [fulfillmentEntry({ cancelled: true, cancellable: false })] })));
    const onChanged = jest.fn();
    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} onChanged={onChanged} />);
    press(await screen.findByRole('button', { name: 'この発送を取り消す' }));
    press(screen.getByRole('button', { name: '取り消す' }));

    expect(await screen.findByText('発送（1回目）を取り消しました。')).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('「やめる」では送らず、取消を開いた行のボタンへフォーカスが戻る', async () => {
    mockClientFetch.mockResolvedValueOnce(
      json(history({ entries: [fulfillmentEntry({ number: 2, fulfillmentId: 'fulfillment-2' }), fulfillmentEntry()] })),
    );
    const onChanged = jest.fn();
    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} onChanged={onChanged} />);

    press((await screen.findAllByRole('button', { name: 'この発送を取り消す' }))[1]);
    expect(screen.getByRole('dialog', { name: 'この発送を取り消す' })).toHaveFocus();
    press(screen.getByRole('button', { name: 'やめる' }));

    expect(screen.getByRole('dialog', { name: 'この注文の履歴' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'この発送を取り消す' })[1]).toHaveFocus();
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('取り消せた後は、履歴のパネルにフォーカスが留まる（消えたボタンへ戻さない）', async () => {
    mockClientFetch
      .mockResolvedValueOnce(json(history({ entries: [fulfillmentEntry()] })))
      .mockResolvedValueOnce(json({ outcome: 'cancelled', orderStatus: 'paid' }))
      .mockResolvedValueOnce(json(history({ entries: [fulfillmentEntry({ cancelled: true, cancellable: false })] })));
    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
    press(await screen.findByRole('button', { name: 'この発送を取り消す' }));
    press(screen.getByRole('button', { name: '取り消す' }));
    await screen.findByText('発送（1回目）を取り消しました。');

    await waitFor(() => expect(screen.getByRole('dialog', { name: 'この注文の履歴' })).toHaveFocus());
  });

  it('送っている間は「取り消す」を押せず、二重に送らない', async () => {
    const post = deferredResponse();
    mockClientFetch
      .mockResolvedValueOnce(json(history({ entries: [fulfillmentEntry()] })))
      .mockReturnValueOnce(post.promise)
      .mockResolvedValueOnce(json(history({ entries: [fulfillmentEntry({ cancelled: true, cancellable: false })] })));
    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
    press(await screen.findByRole('button', { name: 'この発送を取り消す' }));
    press(screen.getByRole('button', { name: '取り消す' }));

    expect(screen.getByRole('button', { name: '取り消す' })).toBeDisabled();
    press(screen.getByRole('button', { name: '取り消す' }));
    expect(mockClientFetch).toHaveBeenCalledTimes(2);

    await act(async () => { post.resolve(json({ outcome: 'cancelled', orderStatus: 'paid' })); });
    expect(await screen.findByText('発送（1回目）を取り消しました。')).toBeInTheDocument();
  });

  it.each([
    [409, { error: 'この発送は取り消せません。注文の状態を確かめてください。', code: 'fulfillment_cancel_not_allowed' }, 'この発送は取り消せません。注文の状態を確かめてください。'],
    [404, { error: '発送の記録が見つかりません。', code: 'fulfillment_not_found' }, '発送の記録が見つかりません。'],
    [403, { error: 'Forbidden' }, 'この操作の権限がありません。'],
    [429, { error: 'Too many requests' }, '発送の取消に失敗しました。'],
  ])('窓口が断った（%i）時は、確かめの画面に留まって理由を出し、親には知らせない', async (status, body, message) => {
    mockClientFetch
      .mockResolvedValueOnce(json(history({ entries: [fulfillmentEntry()] })))
      .mockResolvedValueOnce(json(body, status))
      .mockResolvedValueOnce(json(history({ entries: [fulfillmentEntry()] })));
    const onChanged = jest.fn();
    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} onChanged={onChanged} />);
    press(await screen.findByRole('button', { name: 'この発送を取り消す' }));
    press(screen.getByRole('button', { name: '取り消す' }));

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(screen.getByRole('dialog', { name: 'この発送を取り消す' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取り消す' })).toBeEnabled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.queryByText('Too many requests')).not.toBeInTheDocument();
  });

  it('答えが分からない時は、履歴へ戻って読み直し、取り消されたか確かめるよう知らせて、親にも知らせる', async () => {
    mockClientFetch
      .mockResolvedValueOnce(json(history({ entries: [fulfillmentEntry()] })))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json(history({ entries: [fulfillmentEntry({ cancelled: true, cancellable: false })] })));
    const onChanged = jest.fn();
    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} onChanged={onChanged} />);
    press(await screen.findByRole('button', { name: 'この発送を取り消す' }));
    press(screen.getByRole('button', { name: '取り消す' }));

    const message = '結果を確かめられませんでした。履歴を読み直しました。取り消されたかどうかは、この履歴で確かめてください。';
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('dialog', { name: 'この注文の履歴' })).toBeInTheDocument();
    expect(mockClientFetch).toHaveBeenNthCalledWith(3, HISTORY_URL, { cache: 'no-store' });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});

describe('OrderHistoryDialog の仕上がりの取消', () => {
  it('確かめの画面の文を出し、「取り消す」で窓口へ送り、履歴を読み直して、親に知らせる', async () => {
    mockClientFetch
      .mockResolvedValueOnce(json(history({ entries: [completionEntry()] })))
      .mockResolvedValueOnce(json({ outcome: 'cancelled' }))
      .mockResolvedValueOnce(json(history({
        entries: [
          { type: 'completion_cancel', at: '2026-10-10T03:00:00.000Z', completionId: COMPLETION_ID, actorEmail: 'admin@example.com' },
          completionEntry({ cancelled: true, cancellable: false }),
        ],
      })));
    const onChanged = jest.fn();
    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} onChanged={onChanged} />);

    press(await screen.findByRole('button', { name: 'この仕上がりを取り消す' }));

    expect(screen.getByRole('dialog', { name: 'この仕上がりを取り消す' })).toHaveTextContent(
      'この仕上がりを取り消し、その商品を受注生産中に戻します。',
    );
    press(screen.getByRole('button', { name: '取り消す' }));

    expect(await screen.findByText('仕上がりを取り消しました。')).toBeInTheDocument();
    expect(mockClientFetch).toHaveBeenNthCalledWith(2, CANCEL_COMPLETION_URL, { method: 'POST' });
    expect(mockClientFetch).toHaveBeenNthCalledWith(3, HISTORY_URL, { cache: 'no-store' });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog', { name: 'この注文の履歴' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'この仕上がりを取り消す' })).not.toBeInTheDocument();
  });

  it('もう発送した数を下回る取消は断られ、その理由を確かめの画面に出す', async () => {
    const message = 'もう発送した数があるため、取り消せません。';
    mockClientFetch
      .mockResolvedValueOnce(json(history({ entries: [completionEntry()] })))
      .mockResolvedValueOnce(json({ error: message, code: 'completion_already_shipped' }, 409))
      .mockResolvedValueOnce(json(history({ entries: [completionEntry({ cancellable: false })] })));
    const onChanged = jest.fn();
    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} onChanged={onChanged} />);
    press(await screen.findByRole('button', { name: 'この仕上がりを取り消す' }));
    press(screen.getByRole('button', { name: '取り消す' }));

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'この仕上がりを取り消す' })).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();

    // 読み直した履歴では、この仕上がりはもう取り消せない行になっている
    press(screen.getByRole('button', { name: 'やめる' }));
    expect(screen.queryByRole('button', { name: 'この仕上がりを取り消す' })).not.toBeInTheDocument();
  });
});

// 返金（グループ E-2）。履歴の窓口が返す返金・確保し直しの行と、返金のお知らせのメールの行の出し方
const REFUND_ID = 'e1e1e1e1-1111-2222-8333-444455556666';

function refundEntry(overrides: Partial<OrderHistoryRefundEntry> = {}): OrderHistoryRefundEntry {
  return {
    type: 'refund', at: '2026-10-11T01:00:00.000Z', refundId: REFUND_ID, source: 'admin', sourceLabel: '管理画面',
    actorEmail: 'admin@example.com', amount: 12800, shippingAmount: 800,
    items: [{ name: 'シルクブラウス（白 / M）', quantity: 1, beforeShipment: true, restockedQuantity: 1 }],
    steps: [
      { status: 'awaiting_response', label: '返事待ち', at: '2026-10-11T01:00:00.000Z' },
      { status: 'pending', label: '保留', at: '2026-10-11T01:00:02.000Z' },
      { status: 'succeeded', label: '成功', at: '2026-10-16T05:30:00.000Z' },
    ],
    failureReasonLabel: null, referenceNumber: '123456789012', customerActionExpiresAt: null,
    note: '色違いで再注文', stripeReasonLabel: 'お客様の希望', cancelReasonLabel: null,
    ...overrides,
  };
}

/** 履歴を開き、行（li）を上から順に返す */
async function openHistory(entries: OrderHistoryResponse['entries']): Promise<HTMLElement[]> {
  mockClientFetch.mockResolvedValueOnce(json(history({ entries })));
  render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
  const dialog = await screen.findByRole('dialog', { name: 'この注文の履歴' });
  await within(dialog).findByText('宛先: hanako@example.com');
  return within(dialog).getAllByRole('listitem');
}

describe('OrderHistoryDialog の返金の行', () => {
  it('返金の行は、題（額）・どこから・状態の移り変わり・細目を決まった言葉で出す。ボタンは出さない', async () => {
    const [item] = await openHistory([refundEntry()]);

    // 金額は formatYen の形（全角の ￥ と桁区切り）
    expect(item).toHaveTextContent('返金 ￥12,800');
    expect(item).toHaveTextContent('管理画面');
    expect(item).toHaveTextContent('返事待ち（2026/10/11 10:00） → 保留（2026/10/11 10:00） → 成功（2026/10/16 14:30）');
    expect(item).toHaveTextContent('送料 ￥800');
    expect(item).toHaveTextContent('商品: シルクブラウス（白 / M） × 1');
    expect(item).toHaveTextContent('在庫に戻した数: 1');
    expect(item).toHaveTextContent('照会番号: 123456789012');
    expect(item).toHaveTextContent('Stripe に伝えた理由: お客様の希望');
    expect(item).toHaveTextContent('メモ: 色違いで再注文');
    expect(item).toHaveTextContent('操作: admin@example.com');
    expect(item).not.toHaveTextContent('失敗の理由');
    expect(item).not.toHaveTextContent('取消の理由');
    expect(item).not.toHaveTextContent('口座の入力の期限');
    expect(within(item).queryAllByRole('button')).toHaveLength(0);
  });

  it('失敗した返金は印を danger にして失敗の理由を出す。取消の理由と口座の入力の期限があれば出し、ほかの細目が無ければその行を出さない', async () => {
    const [item] = await openHistory([
      refundEntry({
        source: 'order_cancel', sourceLabel: '注文のキャンセル', actorEmail: null, amount: 5000, shippingAmount: 0, items: [],
        steps: [
          { status: 'awaiting_response', label: '返事待ち', at: '2026-10-11T01:00:00.000Z' },
          { status: 'pending', label: '保留', at: '2026-10-11T01:00:02.000Z' },
          { status: 'failed', label: '失敗', at: '2026-10-16T05:30:00.000Z' },
        ],
        failureReasonLabel: '口座の入力の期限が過ぎました', customerActionExpiresAt: '2026-11-25T14:59:59.000Z',
        referenceNumber: null, note: null, stripeReasonLabel: null, cancelReasonLabel: '在庫切れ',
      }),
    ]);

    expect(item).toHaveTextContent('返金 ￥5,000');
    expect(item).toHaveTextContent('注文のキャンセル');
    expect(within(item).getByText('失敗', { selector: 'span' })).toHaveAttribute('data-ui-badge-tone', 'danger');
    expect(item).toHaveTextContent('失敗の理由: 口座の入力の期限が過ぎました');
    expect(item).toHaveTextContent('口座の入力の期限: 2026/11/25 23:59');
    expect(item).toHaveTextContent('取消の理由: 在庫切れ');
    for (const absent of ['送料', '商品:', '在庫に戻した数', '照会番号', 'Stripe に伝えた理由', 'メモ:', '操作:']) {
      expect(item).not.toHaveTextContent(absent);
    }
  });

  it.each<[OrderRefundStatus, string, string]>([
    ['awaiting_response', '返事待ち', 'neutral'],
    ['error', 'エラー', 'danger'],
    ['pending', '保留', 'neutral'],
    ['succeeded', '成功', 'neutral'],
    ['failed', '失敗', 'danger'],
  ])('いまの状態が %s の返金は、題の隣の印に「%s」と出し、tone は %s', async (status, label, tone) => {
    const [item] = await openHistory([
      refundEntry({ steps: [{ status, label, at: '2026-10-11T01:00:00.000Z' }] }),
    ]);

    expect(within(item).getByText(label, { selector: 'span' })).toHaveAttribute('data-ui-badge-tone', tone);
  });

  it('「在庫に戻した数」は発送前の商品がある返金にだけ出す（戻さない返金は 0 と出す）。発送後の商品だけの返金と、商品の無い返金には出さない', async () => {
    const items = await openHistory([
      refundEntry({
        refundId: 'refund-restocked',
        items: [
          { name: 'A', quantity: 2, beforeShipment: true, restockedQuantity: 2 },
          { name: 'B', quantity: 1, beforeShipment: true, restockedQuantity: 1 },
        ],
      }),
      refundEntry({ refundId: 'refund-not-restocked', items: [{ name: 'C', quantity: 1, beforeShipment: true, restockedQuantity: 0 }] }),
      refundEntry({ refundId: 'refund-shipped-only', items: [{ name: 'D', quantity: 1, beforeShipment: false, restockedQuantity: 0 }] }),
      refundEntry({ refundId: 'refund-amount-only', items: [] }),
    ]);

    expect(items[0]).toHaveTextContent('在庫に戻した数: 3');
    expect(items[1]).toHaveTextContent('在庫に戻した数: 0');
    expect(items[2]).toHaveTextContent('商品: D × 1');
    expect(items[2]).not.toHaveTextContent('在庫に戻した数');
    expect(items[3]).not.toHaveTextContent('商品:');
    expect(items[3]).not.toHaveTextContent('在庫に戻した数');
  });

  it('確保し直しの行は「返金の失敗で在庫を確保し直しました」と商品（品名 × 数）を出し、足りなかった数があれば合計を「足りなかった数: {n}」の1行で出す。無ければその行を出さない', async () => {
    const withShortage: OrderHistoryRefundRereserveEntry = {
      type: 'refund_rereserve', at: '2026-10-12T01:00:00.000Z', refundId: REFUND_ID,
      items: [
        { name: 'シルクブラウス（白 / M）', quantity: 1, shortage: 1 },
        { name: 'ウールコート（黒 / L）', quantity: 2, shortage: 2 },
        { name: 'ストール', quantity: 1, shortage: 0 },
      ],
    };
    const withoutShortage: OrderHistoryRefundRereserveEntry = {
      ...withShortage,
      refundId: 'refund-without-shortage',
      items: [{ name: 'シルクブラウス（白 / M）', quantity: 1, shortage: 0 }],
    };
    const [first, second] = await openHistory([withShortage, withoutShortage]);

    expect(first).toHaveTextContent('2026/10/12 10:00');
    expect(first).toHaveTextContent('返金の失敗で在庫を確保し直しました');
    expect(first).toHaveTextContent('商品: シルクブラウス（白 / M） × 1 / ウールコート（黒 / L） × 2 / ストール × 1');
    // 約束の文そのままの1つの要素にする（品名などを前に付けない）。数は商品ごとの足りなかった数の合計
    expect(within(first).getByText('足りなかった数: 3')).toBeInTheDocument();
    expect(within(first).getAllByText(/足りなかった数/)).toHaveLength(1);
    expect(second).toHaveTextContent('返金の失敗で在庫を確保し直しました');
    expect(second).not.toHaveTextContent('足りなかった数');
    expect(within(first).queryAllByRole('button')).toHaveLength(0);
  });

  it('確保し直せた数が0の商品は「× 0」を付けず品名だけを出す。確保し直せた商品には今のまま「× 数」を付け、足りなかった数の行も今のまま出す', async () => {
    const someZero: OrderHistoryRefundRereserveEntry = {
      type: 'refund_rereserve', at: '2026-10-12T01:00:00.000Z', refundId: REFUND_ID,
      items: [
        { name: 'シルクブラウス（白 / M）', quantity: 0, shortage: 1 },
        { name: 'ウールコート（黒 / L）', quantity: 2, shortage: 1 },
      ],
    };
    const allZero: OrderHistoryRefundRereserveEntry = {
      ...someZero,
      refundId: 'refund-all-zero',
      items: [{ name: 'シルクブラウス（白 / M）', quantity: 0, shortage: 2 }],
    };
    const [first, second] = await openHistory([someZero, allZero]);

    expect(first).toHaveTextContent('商品: シルクブラウス（白 / M） / ウールコート（黒 / L） × 2');
    expect(first).not.toHaveTextContent('× 0');
    expect(within(first).getByText('足りなかった数: 2')).toBeInTheDocument();
    expect(within(second).getByText('商品: シルクブラウス（白 / M）')).toBeInTheDocument();
    expect(second).not.toHaveTextContent('× 0');
    expect(within(second).getByText('足りなかった数: 2')).toBeInTheDocument();
  });

  it('返金のお知らせのメールの行は「返金のお知らせのメール」と出す。再送のボタンは窓口が決めた値のとおり出さない', async () => {
    const [item] = await openHistory([
      sentEmailEntry({ emailId: 'email-refund', kind: 'refund', kindLabel: '返金のお知らせ', resendable: false }),
    ]);

    expect(item).toHaveTextContent('返金のお知らせのメール');
    expect(within(item).getByRole('button', { name: '中身を見る' })).toBeInTheDocument();
    expect(within(item).queryByRole('button', { name: 'お客様へ再送' })).not.toBeInTheDocument();
  });
});


// 返品（グループ E-3）。履歴の窓口が返す返品の行（文は窓口が組み立て済み）と、返品の返金の「どこから」の出し方
const RETURN_ID = 'f1f1f1f1-1111-2222-8333-444455556666';

function returnEntry(overrides: Partial<OrderHistoryReturnEntry> = {}): OrderHistoryReturnEntry {
  return {
    type: 'return', kind: 'receive', id: 'receipt:r1', at: '2026-10-12T01:00:00.000Z', returnId: RETURN_ID,
    title: '返品の受け取り（ORD-A1B2C3D4-R1）', details: ['在庫に戻す 2点', '検品待ち 1点'], actorEmail: 'admin@example.com',
    ...overrides,
  };
}

describe('OrderHistoryDialog の返品の行', () => {
  it('時刻・題・細目（1行に1つ）・操作した人を出し、ボタンは出さない', async () => {
    const [item] = await openHistory([returnEntry()]);

    expect(item).toHaveTextContent('2026/10/12 10:00');
    expect(within(item).getByText('返品の受け取り（ORD-A1B2C3D4-R1）')).toBeInTheDocument();
    expect(within(item).getByText('在庫に戻す 2点')).toBeInTheDocument();
    expect(within(item).getByText('検品待ち 1点')).toBeInTheDocument();
    expect(item).toHaveTextContent('操作: admin@example.com');
    expect(within(item).queryAllByRole('button')).toHaveLength(0);
  });

  it('細目が空の行は細目の行を出さない（段落は「操作:」の1行だけ）', async () => {
    const [item] = await openHistory([
      returnEntry({ kind: 'created', id: 'created:r1', title: '返品を作った（ORD-A1B2C3D4-R1）', details: [] }),
    ]);

    expect(item).toHaveTextContent('返品を作った（ORD-A1B2C3D4-R1）');
    expect(item.querySelectorAll('p')).toHaveLength(1);
  });

  it('操作した人（actorEmail）が空の行は「操作:」の行を出さない', async () => {
    const [item] = await openHistory([
      returnEntry({ kind: 'cancel', id: 'cancel:r1', title: '返品を取り消した（ORD-A1B2C3D4-R1）', details: [], actorEmail: null }),
    ]);

    expect(item).toHaveTextContent('返品を取り消した（ORD-A1B2C3D4-R1）');
    expect(item).not.toHaveTextContent('操作:');
    expect(item.querySelectorAll('p')).toHaveLength(0);
  });

  it.each<[OrderHistoryReturnEntry['kind'], string]>([
    ['close_missing', '「届かない」として返品を終えた（ORD-A1B2C3D4-R1・2点）'],
    ['refund_waived', '返金しないで終えた（ORD-A1B2C3D4-R1・3点）'],
    ['fee_received', '手数料の受け取りを記録した（￥1,200）'],
  ])('%s の行は、窓口が組み立てた題をそのまま出す', async (kind, title) => {
    const [item] = await openHistory([returnEntry({ kind, id: `${kind}:r1`, title, details: [] })]);

    expect(item).toHaveTextContent(title);
  });

  it('交換の品を足した行（返品の番号を持たない。returnId が null）も、題を出す', async () => {
    const [item] = await openHistory([
      returnEntry({
        kind: 'exchange_added', id: 'exchange:i1', returnId: null,
        title: '交換の品を足した（シルクブラウス（黒 / L） × 1）', details: [], actorEmail: null,
      }),
    ]);

    expect(item).toHaveTextContent('交換の品を足した（シルクブラウス（黒 / L） × 1）');
  });

  it('同じ返品の行が並んでも（returnId が同じ）、行の key が重ならず、警告を出さない', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const items = await openHistory([
        returnEntry({ id: 'receipt:r2' }),
        returnEntry({ kind: 'created', id: 'created:r1', title: '返品を作った（ORD-A1B2C3D4-R1）', details: [] }),
      ]);

      expect(items).toHaveLength(2);
      expect(error.mock.calls.some(([message]) => String(message).includes('same key'))).toBe(false);
    } finally {
      error.mockRestore();
    }
  });

  it('返品の返金の行は、どこからに窓口が決めた「返品（番号）」をそのまま出す（表示は sourceLabel だけを使う）', async () => {
    const [item] = await openHistory([refundEntry({ source: 'return', sourceLabel: '返品（ORD-A1B2C3D4-R1）', note: null })]);

    expect(within(item).getByText('返品（ORD-A1B2C3D4-R1）')).toBeInTheDocument();
  });
});

// 返品・キャンセルの申し込みの行（グループ E-3 段2 の Task 12。本計画 P17）。窓口（Task 8 の buildOrderHistory）が組み立てた題を、今の返品の行の描き方で出す。
// 見本は Task 8 の Step 12 が返す形のとおり: kind と id の綴り、細目 details は空、お客様の申し込みの行は actorEmail が null、キャンセルの申し込みの行は returnId が null
describe('OrderHistoryDialog の申し込みの行（P17）', () => {
  const requestEntry = (overrides: Partial<OrderHistoryReturnEntry>) =>
    returnEntry({ details: [], actorEmail: null, ...overrides });

  it.each<[OrderHistoryReturnEntry['kind'], string, string, string | null]>([
    ['request', 'request:r1', '返品の申し込み（ORD-A1B2C3D4-R1）', null],
    ['approve', 'approve:r1', '返品の申し込みを承認した（ORD-A1B2C3D4-R1）', 'admin@example.com'],
    ['decline', 'decline:r1', '返品の申し込みをお断りした（ORD-A1B2C3D4-R1）', 'support@example.com'],
    ['cancel_request', 'cancel-request:c1', 'キャンセルの申し込み', null],
    ['cancel_request_decline', 'cancel-request-decline:c1', 'キャンセルの申し込みをお断りした', 'admin@example.com'],
    ['cancel_request_close', 'cancel-request-close:c1', 'キャンセルの申し込みを解決済みにした', 'support@example.com'],
    ['cancel_request_resolve', 'cancel-request-resolve:c1', 'キャンセルの申し込みを解決した（返金）', 'admin@example.com'],
    ['cancel_request_resolve', 'cancel-request-resolve:c2', 'キャンセルの申し込みを解決した（キャンセル）', 'admin@example.com'],
  ])('%s（%s）の行は、題をそのまま出し、した人がいる時だけ「操作:」を出す。ボタンは出さない', async (kind, id, title, actorEmail) => {
    const [item] = await openHistory([
      requestEntry({ kind, id, title, actorEmail, returnId: kind.startsWith('cancel_request') ? null : RETURN_ID }),
    ]);

    expect(within(item).getByText(title)).toBeInTheDocument();
    if (actorEmail) {
      expect(item).toHaveTextContent(`操作: ${actorEmail}`);
    } else {
      expect(item).not.toHaveTextContent('操作:');
    }
    expect(within(item).queryAllByRole('button')).toHaveLength(0);
  });

  it('キャンセルの申し込みの行は細目が空（窓口は品を細目に入れない）。題だけを出し、細目の行は出さない（段落は「操作:」の分だけ）', async () => {
    const [requested, declined] = await openHistory([
      requestEntry({ kind: 'cancel_request', id: 'cancel-request:c1', returnId: null, title: 'キャンセルの申し込み' }),
      requestEntry({
        kind: 'cancel_request_decline', id: 'cancel-request-decline:c1', returnId: null,
        title: 'キャンセルの申し込みをお断りした', actorEmail: 'admin@example.com',
      }),
    ]);

    expect(requested).toHaveTextContent('キャンセルの申し込み');
    expect(requested.querySelectorAll('p')).toHaveLength(0);
    expect(declined).toHaveTextContent('キャンセルの申し込みをお断りした');
    expect(declined.querySelectorAll('p')).toHaveLength(1);
    expect(declined).toHaveTextContent('操作: admin@example.com');
  });

  it.each([
    '返品のお申し込みの受付のお知らせ',
    '返品のお申し込みについてのお知らせ',
    '店への知らせ（返品の申し込み）',
    'キャンセルのお申し込みの受付のお知らせ',
    'キャンセルのお申し込みについてのお知らせ',
    '店への知らせ（キャンセルの申し込み）',
  ])('メールの行の名前「%s」は、窓口が決めた名前を「{名前}のメール」と出す', async (kindLabel) => {
    const [item] = await openHistory([sentEmailEntry({ kindLabel })]);

    expect(item).toHaveTextContent(`${kindLabel}のメール`);
  });

  it('返品の申し込みの行とキャンセルの申し込みの行が並んでも、行の key が重ならず、警告を出さない', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const items = await openHistory([
        requestEntry({ kind: 'request', id: 'request:r1', title: '返品の申し込み（ORD-A1B2C3D4-R1）' }),
        requestEntry({ kind: 'cancel_request', id: 'cancel-request:c1', returnId: null, title: 'キャンセルの申し込み' }),
        requestEntry({
          kind: 'cancel_request_decline', id: 'cancel-request-decline:c1', returnId: null,
          title: 'キャンセルの申し込みをお断りした', actorEmail: 'admin@example.com',
        }),
      ]);

      expect(items).toHaveLength(3);
      expect(error.mock.calls.some(([message]) => String(message).includes('same key'))).toBe(false);
    } finally {
      error.mockRestore();
    }
  });
});

// 配送の状況（グループ E-4 の Task 10）。設計書 6-1 の表と、計画の C-5 の言葉。履歴の窓口が返す配送の行（Task 9）と、直す・配達済みにする画面とのつなぎ
const DELIVERED_AT = '2026-10-21T03:00:00.000Z';
const TRACKING_POST_URL = `/api/admin/orders/${ORDER_ID}/fulfillments/${FULFILLMENT_ID}/tracking`;
const DELIVERED_POST_URL = `/api/admin/orders/${ORDER_ID}/fulfillments/${FULFILLMENT_ID}/delivered`;

function deliveryDetail(overrides: Partial<FulfillmentDeliveryDetail> = {}): FulfillmentDeliveryDetail {
  return {
    fulfillmentId: FULFILLMENT_ID, number: 1, carrier: 'yamato', trackingNumber: '1234-5678', notifyCustomer: true,
    shippedAt: '2026-10-10T02:00:00.000Z', cancelledAt: null, trackingVersion: 1, deliveryStatus: 'in_transit',
    deliveryStatusAt: DELIVERED_AT, deliveredAt: null, deliveredSource: null,
    registration: { state: 'registered', failureKind: null, stopReason: null, expiresAt: '2026-11-09T02:00:00.000Z', everRegistered: true },
    events: [], trackingChanges: [],
    ...overrides,
  };
}

/** 配送の現在値（delivery）つきの発送の行。取り消した発送なら、取り消し済みの行の形にする */
function shipmentWithDelivery(
  delivery: Partial<FulfillmentDeliveryDetail> = {},
  overrides: Partial<OrderHistoryFulfillmentEntry> = {},
): OrderHistoryFulfillmentEntry {
  const detail = deliveryDetail(delivery);
  const cancelled = detail.cancelledAt !== null;
  return fulfillmentEntry({
    fulfillmentId: detail.fulfillmentId, number: detail.number, cancelled, cancellable: !cancelled, delivery: detail, ...overrides,
  });
}

function deliveryEvent(overrides: Partial<DeliveryEvent> = {}, number = 1): OrderHistoryDeliveryEventEntry {
  const event: DeliveryEvent = {
    id: 'event-1', trackingVersion: 1, status: 'in_transit', happenedAt: '2026-10-12T02:00:00.000Z',
    recordedAt: '2026-10-12T02:00:05.000Z', source: 'tracking', providerSubStatus: 'InTransit_PickedUp', actorEmail: null,
    ...overrides,
  };
  return { type: 'delivery_event', at: event.happenedAt, fulfillmentId: FULFILLMENT_ID, number, event };
}

function trackingChangeEntry(overrides: Partial<TrackingChange> = {}, number = 1): OrderHistoryTrackingChangeEntry {
  const change: TrackingChange = {
    id: 'change-1', fromCarrier: 'yamato', fromTrackingNumber: '1234-5678', toCarrier: 'sagawa', toTrackingNumber: 'AB-99',
    trackingVersion: 2, notifyCustomer: true, changedAt: '2026-10-13T02:00:00.000Z', actorEmail: 'admin@example.com',
    emailStatus: 'sent',
    ...overrides,
  };
  return { type: 'tracking_change', at: change.changedAt, fulfillmentId: FULFILLMENT_ID, number, change };
}

/** 履歴を開く。enabled は履歴の窓口が返す追跡のオン・オフ（省くと、窓口が返さない昔の見本の形） */
async function openDeliveryHistory(
  entries: OrderHistoryResponse['entries'],
  options: { enabled?: boolean; canManage?: boolean; onChanged?: () => void } = {},
) {
  mockClientFetch.mockResolvedValueOnce(
    json(history({ entries, ...(options.enabled === undefined ? {} : { deliveryTrackingEnabled: options.enabled }) })),
  );
  const onClose = jest.fn();
  render(
    <OrderHistoryDialog
      orderId={ORDER_ID}
      onClose={onClose}
      onChanged={options.onChanged}
      canManageDelivery={options.canManage ?? true}
    />,
  );
  const dialog = await screen.findByRole('dialog', { name: 'この注文の履歴' });
  await within(dialog).findByText('宛先: hanako@example.com');
  return { dialog, onClose, items: within(dialog).getAllByRole('listitem') };
}

type TableRow = {
  label: string;
  entries: () => OrderHistoryResponse['entries'];
  probe: () => HTMLElement | null;
  off: boolean;
  on: boolean;
};

// 設計書 6-1 の表を1行ずつ。off・on は、追跡オフ・オンの履歴で出すか
const TABLE_ROWS: TableRow[] = [
  {
    label: '配達済みなら届いた日と出どころ',
    entries: () => [shipmentWithDelivery({ deliveryStatus: 'delivered', deliveredAt: DELIVERED_AT, deliveredSource: 'manual' })],
    probe: () => screen.queryByText('お届け日 10月21日（手で）'),
    off: true, on: true,
  },
  {
    label: '伝票番号の直しの記録',
    entries: () => [shipmentWithDelivery(), trackingChangeEntry()],
    probe: () => screen.queryByText('伝票番号を直した（1回目）'),
    off: true, on: true,
  },
  {
    label: '今の配送の状況と最後に変わった時刻',
    entries: () => [shipmentWithDelivery({ deliveryStatus: 'attempted_delivery' })],
    probe: () => screen.queryByText('最後の更新 2026/10/21 12:00'),
    off: false, on: true,
  },
  {
    label: '移り変わり（状況と細かい状況）',
    entries: () => [shipmentWithDelivery(), deliveryEvent()],
    probe: () => screen.queryByText('InTransit_PickedUp'),
    off: true, on: true,
  },
  {
    label: '追跡の登録の状態',
    entries: () => [shipmentWithDelivery()],
    probe: () => screen.queryByText('追跡中'),
    off: false, on: true,
  },
  {
    label: 'ボタン「伝票番号を直す」',
    entries: () => [shipmentWithDelivery()],
    probe: () => screen.queryByRole('button', { name: '伝票番号を直す' }),
    off: true, on: true,
  },
  {
    label: 'ボタン「配達済みにする」',
    entries: () => [shipmentWithDelivery()],
    probe: () => screen.queryByRole('button', { name: '配達済みにする' }),
    off: true, on: true,
  },
];

function tableCases(): Array<[string, string, boolean, boolean, TableRow]> {
  return TABLE_ROWS.flatMap((row): Array<[string, string, boolean, boolean, TableRow]> => [
    [row.label, 'オフ', false, row.off, row],
    [row.label, 'オン', true, row.on, row],
  ]);
}

describe('OrderHistoryDialog の配送の表示（設計書 6-1 の表）', () => {
  it.each(tableCases())('「%s」は、追跡%sの履歴で出す物か', async (_label, _mode, enabled, shown, row) => {
    await openDeliveryHistory(row.entries(), { enabled });

    if (shown) {
      expect(row.probe()).toBeVisible();
    } else {
      expect(row.probe()).not.toBeInTheDocument();
    }
  });

  it('追跡のオン・オフを窓口が返さない昔の見本は、オフとして読む（現在の状況も登録の状態も出さない）', async () => {
    await openDeliveryHistory([shipmentWithDelivery({ deliveryStatus: 'attempted_delivery' })]);

    expect(screen.queryByText('最後の更新 2026/10/21 12:00')).not.toBeInTheDocument();
    expect(screen.queryByText('追跡中')).not.toBeInTheDocument();
    expect(screen.queryByText('不在で持ち帰り')).not.toBeInTheDocument();
  });

  it('OFFの履歴にも配達済みと直しと過去の移り変わりを出す', async () => {
    await openDeliveryHistory(
      [
        shipmentWithDelivery({ deliveryStatus: 'delivered', deliveredAt: DELIVERED_AT, deliveredSource: 'manual' }),
        trackingChangeEntry(),
        deliveryEvent({ status: 'delivered', source: 'manual', providerSubStatus: null, actorEmail: 'admin@example.com' }),
      ],
      { enabled: false },
    );

    expect(screen.getByText('お届け日 10月21日（手で）')).toBeVisible();
    expect(screen.getByText('伝票番号を直した（1回目）')).toBeVisible();
    expect(screen.getByText('配送の状況（1回目）')).toBeVisible();
    expect(screen.queryByText('追跡中')).not.toBeInTheDocument();
    expect(screen.queryByText(/最後の更新/)).not.toBeInTheDocument();
  });

  it('ONは現在の状況・最後の更新・登録・細かい記号を出す', async () => {
    await openDeliveryHistory(
      [
        shipmentWithDelivery({ deliveryStatus: 'attempted_delivery', deliveryStatusAt: '2026-10-21T03:00:00.000Z' }),
        deliveryEvent({ status: 'attempted_delivery', providerSubStatus: 'Exception_Absent' }),
      ],
      { enabled: true },
    );

    expect(screen.getAllByText('不在で持ち帰り')).toHaveLength(2);
    expect(screen.getByText('最後の更新 2026/10/21 12:00')).toBeVisible();
    expect(screen.getByText('追跡中')).toBeVisible();
    expect(screen.getByText('Exception_Absent')).toBeVisible();
    expect(screen.getAllByText('配送の状況（1回目）')).toHaveLength(2);
  });

  it.each([
    ['confirmed', '受付済み'],
    ['in_transit', '輸送中'],
    ['out_for_delivery', '配達中'],
    ['attempted_delivery', '不在で持ち帰り'],
    ['ready_for_pickup', '受け取り待ち'],
    ['delivered', '配達済み'],
    ['delayed', '遅れ'],
    ['failure', '問題あり'],
  ] as const)('追跡オンの現在の状況 %s は「%s」と出す', async (status, label) => {
    await openDeliveryHistory([shipmentWithDelivery({ deliveryStatus: status })], { enabled: true });

    expect(screen.getByText(label, { selector: 'span' })).toBeVisible();
  });

  it.each([
    ['pending', '登録待ち'],
    ['registered', '追跡中'],
    ['stopped', '止めた'],
    ['failed', '登録できない'],
  ] as const)('追跡オンの登録の状態 %s は「%s」と出す', async (state, label) => {
    await openDeliveryHistory(
      [shipmentWithDelivery({ registration: { state, failureKind: null, stopReason: null, expiresAt: '2026-11-09T02:00:00.000Z', everRegistered: state === 'registered' } })],
      { enabled: true },
    );

    expect(screen.getByText(label)).toBeVisible();
  });

  it('追跡オンでも、登録の行が無い発送には登録の状態を出さない', async () => {
    await openDeliveryHistory([shipmentWithDelivery({ registration: null })], { enabled: true });

    for (const label of ['登録待ち', '追跡中', '止めた', '登録できない']) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
  });

  it('追跡で配達済みになった発送は「（追跡）」の出どころを出す。届いた日が無い発送には出さない', async () => {
    await openDeliveryHistory(
      [
        shipmentWithDelivery({ deliveryStatus: 'delivered', deliveredAt: DELIVERED_AT, deliveredSource: 'tracking' }),
        shipmentWithDelivery({ fulfillmentId: 'fulfillment-2', number: 2 }),
      ],
      { enabled: true },
    );

    expect(screen.getByText('お届け日 10月21日（追跡）')).toBeVisible();
    expect(screen.getAllByText(/お届け日/)).toHaveLength(1);
  });

  it('届いた日は日本時間の日付で出す（世界時の前日でも、日本時間で翌日なら翌日）', async () => {
    await openDeliveryHistory(
      [shipmentWithDelivery({ deliveryStatus: 'delivered', deliveredAt: '2026-10-20T16:30:00.000Z', deliveredSource: 'manual' })],
    );

    expect(screen.getByText('お届け日 10月21日（手で）')).toBeVisible();
  });

  it('取り消した発送には、現在の状況も登録の状態も、2つのボタンも出さない', async () => {
    await openDeliveryHistory(
      [shipmentWithDelivery({ cancelledAt: '2026-10-11T00:00:00.000Z', deliveryStatus: 'in_transit' })],
      { enabled: true },
    );

    expect(screen.queryByText(/最後の更新/)).not.toBeInTheDocument();
    expect(screen.queryByText('追跡中')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '伝票番号を直す' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '配達済みにする' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'この発送を取り消す' })).not.toBeInTheDocument();
  });

  it('取消には2つのボタン無し、配達済みには直すだけ', async () => {
    await openDeliveryHistory(
      [
        shipmentWithDelivery({ deliveryStatus: 'delivered', deliveredAt: DELIVERED_AT, deliveredSource: 'tracking' }),
      ],
    );

    expect(screen.getByRole('button', { name: '伝票番号を直す' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '配達済みにする' })).not.toBeInTheDocument();
  });

  it('管理の権限（canManageDelivery）が無い人には、2つのボタンを出さない（省いた時も同じ）', async () => {
    const { dialog } = await openDeliveryHistory([shipmentWithDelivery()], { canManage: false });
    expect(within(dialog).queryByRole('button', { name: '伝票番号を直す' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: '配達済みにする' })).not.toBeInTheDocument();
    cleanup();

    mockClientFetch.mockResolvedValueOnce(json(history({ entries: [shipmentWithDelivery()] })));
    render(<OrderHistoryDialog orderId={ORDER_ID} onClose={jest.fn()} />);
    await screen.findByText('宛先: hanako@example.com');
    expect(screen.queryByRole('button', { name: '伝票番号を直す' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '配達済みにする' })).not.toBeInTheDocument();
    // 取り消す操作は今までどおり（配送の権限とは別）
    expect(screen.getByRole('button', { name: 'この発送を取り消す' })).toBeVisible();
  });

  it('窓口が配送の現在値を付けなかった昔の見本の発送には、2つのボタンを出さない', async () => {
    await openDeliveryHistory([fulfillmentEntry()]);

    expect(screen.queryByRole('button', { name: '伝票番号を直す' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '配達済みにする' })).not.toBeInTheDocument();
  });
});

describe('OrderHistoryDialog の配送の出来事と伝票番号の直しの行', () => {
  it('出来事の行は、日時・「配送の状況（n回目）」・状況・細かい状況を決まった言葉で出す。した人がいれば「操作:」も出す。ボタンは出さない', async () => {
    const { items } = await openDeliveryHistory([
      deliveryEvent({ status: 'delivered', source: 'manual', providerSubStatus: null, actorEmail: 'admin@example.com' }, 2),
      deliveryEvent({ id: 'event-2', status: 'failure', providerSubStatus: 'Exception_Other', happenedAt: '2026-10-11T02:00:00.000Z' }),
    ]);

    expect(items[0]).toHaveTextContent('2026/10/12 11:00');
    expect(items[0]).toHaveTextContent('配送の状況（2回目）');
    expect(items[0]).toHaveTextContent('配達済み');
    expect(items[0]).toHaveTextContent('操作: admin@example.com');
    expect(items[0]).not.toHaveTextContent('InTransit');
    expect(items[1]).toHaveTextContent('配送の状況（1回目）');
    expect(items[1]).toHaveTextContent('問題あり');
    expect(items[1]).toHaveTextContent('Exception_Other');
    expect(within(items[1]).getByText('Exception_Other')).toHaveClass('lk-text-4xs');
    expect(items[1]).not.toHaveTextContent('操作:');
    for (const item of items) {
      expect(within(item).queryAllByRole('button')).toHaveLength(0);
    }
  });

  it('出来事の細かい状況は、HTML としては読まず、文字のまま出す', async () => {
    const { dialog } = await openDeliveryHistory([
      deliveryEvent({ providerSubStatus: '<img src=x onerror=alert(1)>', actorEmail: '<b>admin</b>@example.com' }),
    ]);

    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeVisible();
    expect(dialog.querySelector('img')).toBeNull();
    expect(dialog.querySelector('b')).toBeNull();
  });

  it('伝票番号を直した行は、題・前の値 → 新しい値・メールの状態・した人を決まった言葉で出す', async () => {
    const [item] = (await openDeliveryHistory([trackingChangeEntry({}, 2)])).items;

    expect(item).toHaveTextContent('2026/10/13 11:00');
    expect(item).toHaveTextContent('伝票番号を直した（2回目）');
    expect(within(item).getByText('ヤマト運輸 1234-5678 → 佐川急便 AB-99')).toBeVisible();
    expect(item).toHaveTextContent('お客様へのメール：送信済み');
    expect(item).toHaveTextContent('操作: admin@example.com');
    expect(within(item).queryAllByRole('button')).toHaveLength(0);
  });

  it('前の値が空の直しは「記録なし」と出す（配送業者だけ・番号だけが空でも、空の側だけを省く）', async () => {
    const items = (await openDeliveryHistory([
      trackingChangeEntry({ id: 'change-1', fromCarrier: null, fromTrackingNumber: null, toCarrier: 'japanpost', toTrackingNumber: '9999' }),
      trackingChangeEntry({ id: 'change-2', fromCarrier: null, fromTrackingNumber: '1234', toCarrier: 'yamato', toTrackingNumber: '5678', changedAt: '2026-10-12T02:00:00.000Z' }),
    ])).items;

    expect(within(items[0]).getByText('記録なし → 日本郵便 9999')).toBeVisible();
    expect(within(items[1]).getByText('1234 → ヤマト運輸 5678')).toBeVisible();
  });

  it.each<[OrderEmailStatus | null, string]>([
    ['sent', '送信済み'],
    ['pending', '送信待ち'],
    ['sending', '送信待ち'],
    ['retry_wait', '送信待ち'],
    ['dead', '送れなかった'],
    ['skipped', '送らない'],
    [null, '送らない'],
  ])('メールの状態 %s は「お客様へのメール：%s」と出す', async (emailStatus, label) => {
    const [item] = (await openDeliveryHistory([trackingChangeEntry({ emailStatus, notifyCustomer: emailStatus !== null })])).items;

    expect(within(item).getByText(`お客様へのメール：${label}`)).toBeVisible();
  });

  it('伝票番号の欄は、390px の狭い画面でも長い番号が折り返せる（はみ出さない）', async () => {
    await openDeliveryHistory([shipmentWithDelivery({ trackingNumber: 'A'.repeat(64) }, { trackingNumber: 'A'.repeat(64) }), trackingChangeEntry({ toTrackingNumber: 'B'.repeat(64) })]);

    expect(screen.getByText(`配送業者: ヤマト運輸 / 伝票番号: ${'A'.repeat(64)}`)).toHaveClass('break-all');
    expect(screen.getByText(`ヤマト運輸 1234-5678 → 佐川急便 ${'B'.repeat(64)}`)).toHaveClass('break-all');
  });

  it('配達済みのお知らせなど、配送のメールの行には再送のボタンを出さない（窓口が再送できないと決めた行）', async () => {
    const { items } = await openDeliveryHistory([
      sentEmailEntry({ emailId: 'email-delivered', kind: 'delivered', kindLabel: '配達済みのお知らせ', resendable: false, canViewContent: true }),
      deliveryEvent({ status: 'delivered', source: 'tracking' }),
    ]);

    expect(items[0]).toHaveTextContent('配達済みのお知らせのメール');
    expect(within(items[0]).queryByRole('button', { name: 'お客様へ再送' })).not.toBeInTheDocument();
    expect(within(items[1]).queryByRole('button', { name: 'お客様へ再送' })).not.toBeInTheDocument();
  });

  it('出来事・直しの行が並んでも、行の key が重ならず、警告を出さない', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { items } = await openDeliveryHistory([
        shipmentWithDelivery(),
        deliveryEvent({ id: 'event-1' }),
        deliveryEvent({ id: 'event-2', status: 'out_for_delivery' }),
        trackingChangeEntry({ id: 'change-1' }),
        trackingChangeEntry({ id: 'change-2' }),
      ]);

      expect(items).toHaveLength(5);
      expect(error.mock.calls.some(([message]) => String(message).includes('same key'))).toBe(false);
    } finally {
      error.mockRestore();
    }
  });
});

describe('OrderHistoryDialog の伝票番号を直す・配達済みにする画面', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** 履歴へ戻った後の読み直しの返事を待つ（待たずに終えると、終わった後の描き直しが act の外になる） */
  const flush = () => act(async () => {});

  const submitIn = (name: string) => within(screen.getByRole('dialog', { name })).getByRole('button', { name });

  it('「伝票番号を直す」で直す画面へ移る。履歴のダイアログは重ねず、最初の入力へフォーカスが移り、追跡オンの説明を出す', async () => {
    await openDeliveryHistory([shipmentWithDelivery()], { enabled: true });

    press(screen.getByRole('button', { name: '伝票番号を直す' }));

    const dialog = screen.getByRole('dialog', { name: '伝票番号を直す' });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.queryByRole('dialog', { name: 'この注文の履歴' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('配送業者')).toHaveFocus();
    expect(screen.getByLabelText('伝票番号')).toHaveValue('1234-5678');
    expect(dialog).toHaveTextContent('直すと配送の状況は受付済みに戻り、新しい伝票番号で追跡します。チェックを外すと、この先の配達中・配達済みのメールも送りません');
  });

  it('追跡オフの履歴から開いた直す画面と配達済みの画面には、オフの説明を出す', async () => {
    await openDeliveryHistory([shipmentWithDelivery()], { enabled: false });
    mockClientFetch.mockResolvedValueOnce(json(history({ entries: [shipmentWithDelivery()], deliveryTrackingEnabled: false })));

    press(screen.getByRole('button', { name: '伝票番号を直す' }));
    expect(screen.getByText('チェックを外すと、この先の配達済みのメールも送りません')).toBeVisible();
    press(screen.getByRole('button', { name: '戻る' }));
    await flush();
    press(screen.getByRole('button', { name: '配達済みにする' }));

    expect(screen.getByRole('dialog', { name: '配達済みにする' })).toBeInTheDocument();
    expect(screen.getByText('お客様に届いたことが分かった時に使います。返品の期限は、この日から数えます')).toBeVisible();
  });

  it('配達済みの発送を直す画面には、返品の期限の警告を出す', async () => {
    await openDeliveryHistory([
      shipmentWithDelivery({ deliveryStatus: 'delivered', deliveredAt: DELIVERED_AT, deliveredSource: 'manual' }),
    ]);

    press(screen.getByRole('button', { name: '伝票番号を直す' }));

    expect(screen.getByText('配達済みの記録が消え、返品の期限は新しい届いた日から数え直します')).toBeVisible();
  });

  it('「戻る」で履歴へ戻ると、開いた行のボタンへフォーカスが返り、履歴を読み直す。親には知らせない', async () => {
    const entries = [shipmentWithDelivery({ fulfillmentId: 'fulfillment-2', number: 2 }), shipmentWithDelivery()];
    const onChanged = jest.fn();
    await openDeliveryHistory(entries, { onChanged });
    mockClientFetch.mockResolvedValueOnce(json(history({ entries })));

    press(screen.getAllByRole('button', { name: '伝票番号を直す' })[1]);
    press(screen.getByRole('button', { name: '戻る' }));

    expect(screen.getByRole('dialog', { name: 'この注文の履歴' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '伝票番号を直す' })[1]).toHaveFocus();
    expect(mockClientFetch).toHaveBeenCalledTimes(2);
    expect(mockClientFetch).toHaveBeenNthCalledWith(2, HISTORY_URL, { cache: 'no-store' });
    expect(onChanged).not.toHaveBeenCalled();
    await flush();
    expect(screen.getAllByRole('button', { name: '伝票番号を直す' })[1]).toHaveFocus();
  });

  it('配達済みの画面から「戻る」でも、その行の「配達済みにする」へフォーカスが返る', async () => {
    const entries = [shipmentWithDelivery({ fulfillmentId: 'fulfillment-2', number: 2 }), shipmentWithDelivery()];
    await openDeliveryHistory(entries);
    mockClientFetch.mockResolvedValueOnce(json(history({ entries })));

    press(screen.getAllByRole('button', { name: '配達済みにする' })[1]);
    expect(screen.getByRole('dialog', { name: '配達済みにする' })).toBeInTheDocument();
    press(screen.getByRole('button', { name: '戻る' }));

    expect(screen.getAllByRole('button', { name: '配達済みにする' })[1]).toHaveFocus();
    await flush();
  });

  it('Escape では、履歴ごと閉じずに、直す画面だけを閉じて履歴へ戻る', async () => {
    const { onClose } = await openDeliveryHistory([shipmentWithDelivery()]);
    mockClientFetch.mockResolvedValueOnce(json(history({ entries: [shipmentWithDelivery()] })));

    press(screen.getByRole('button', { name: '伝票番号を直す' }));
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.getByRole('dialog', { name: 'この注文の履歴' })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '伝票番号を直す' })).toHaveFocus();
    await flush();
  });

  it('直せたら、窓口へ送り、履歴を読み直し、親に知らせ、成功の知らせを出す。フォーカスは同じ行のボタンへ戻る', async () => {
    const onChanged = jest.fn();
    await openDeliveryHistory([shipmentWithDelivery()], { enabled: true, onChanged });
    mockClientFetch
      .mockResolvedValueOnce(json({ data: { trackingChangeId: 'change-9', trackingVersion: 2, replayed: false } }))
      .mockResolvedValueOnce(json(history({
        entries: [trackingChangeEntry({ id: 'change-9' }), shipmentWithDelivery({ carrier: 'sagawa', trackingNumber: 'AB-99', trackingVersion: 2, deliveryStatus: 'confirmed' })],
        deliveryTrackingEnabled: true,
      })));

    press(screen.getByRole('button', { name: '伝票番号を直す' }));
    fireEvent.change(screen.getByLabelText('配送業者'), { target: { value: 'sagawa' } });
    fireEvent.change(screen.getByLabelText('伝票番号'), { target: { value: 'AB-99' } });
    press(submitIn('伝票番号を直す'));

    expect(await screen.findByText('伝票番号を直しました。')).toBeInTheDocument();
    expect(mockClientFetch).toHaveBeenNthCalledWith(2, TRACKING_POST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: expect.any(String),
    });
    const body = JSON.parse((mockClientFetch.mock.calls[1][1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body).toEqual({ requestKey: expect.any(String), carrier: 'sagawa', trackingNumber: 'AB-99', notifyCustomer: true });
    expect(mockClientFetch).toHaveBeenNthCalledWith(3, HISTORY_URL, { cache: 'no-store' });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('伝票番号を直しました。');
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();
    await waitFor(() => expect(screen.getByText('伝票番号を直した（1回目）')).toBeVisible());
    expect(screen.getByRole('button', { name: '伝票番号を直す' })).toHaveFocus();
  });

  it('直す画面は履歴と同じダイアログ（同じパネル）の中で切り替わる。重ねず、戻っても作り直さない', async () => {
    await openDeliveryHistory([shipmentWithDelivery()], { enabled: true });
    mockClientFetch.mockResolvedValueOnce(json(history({ entries: [shipmentWithDelivery()], deliveryTrackingEnabled: true })));
    const panel = screen.getByRole('dialog', { name: 'この注文の履歴' });

    press(screen.getByRole('button', { name: '伝票番号を直す' }));
    expect(screen.getByRole('dialog', { name: '伝票番号を直す' })).toBe(panel);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    press(screen.getByRole('button', { name: '戻る' }));

    expect(screen.getByRole('dialog', { name: 'この注文の履歴' })).toBe(panel);
    await flush();
  });

  it('成功の知らせの入れ物（status・alert）は、直す画面を開いて閉じても作り直されず、同じ要素の中に文字が入る', async () => {
    await openDeliveryHistory([shipmentWithDelivery()], { enabled: true });
    const status = screen.getByRole('status');
    const historyAlert = screen.getByRole('alert');
    mockClientFetch
      .mockResolvedValueOnce(json({ data: { trackingChangeId: 'change-9', trackingVersion: 2, replayed: false } }))
      .mockResolvedValueOnce(json(history({ entries: [shipmentWithDelivery()], deliveryTrackingEnabled: true })));

    press(screen.getByRole('button', { name: '伝票番号を直す' }));
    // 直す画面を開いている間も、同じ入れ物が残っている
    expect(screen.getByRole('status')).toBe(status);
    expect(status).toBeEmptyDOMElement();
    fireEvent.change(screen.getByLabelText('伝票番号'), { target: { value: 'AB-99' } });
    press(submitIn('伝票番号を直す'));

    expect(await screen.findByText('伝票番号を直しました。')).toBeInTheDocument();
    expect(screen.getByRole('status')).toBe(status);
    expect(status).toHaveTextContent('伝票番号を直しました。');
    expect(screen.getByRole('alert')).toBe(historyAlert);
    expect(historyAlert).toBeEmptyDOMElement();
  });

  it('配達済みにできた後の成功の知らせは、履歴のパネルへフォーカスを移した後の描画で、残っている入れ物に入る', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-21T03:00:00.000Z'));
    await openDeliveryHistory([shipmentWithDelivery()]);
    const status = screen.getByRole('status');
    const panel = screen.getByRole('dialog', { name: 'この注文の履歴' });
    mockClientFetch
      .mockResolvedValueOnce(json({ data: { eventId: 'event-9', deliveredAt: '2026-10-21T03:00:00.000Z', replayed: false } }))
      .mockResolvedValueOnce(json(history({
        entries: [shipmentWithDelivery({ deliveryStatus: 'delivered', deliveredAt: '2026-10-21T03:00:00.000Z', deliveredSource: 'manual' })],
      })));

    press(screen.getByRole('button', { name: '配達済みにする' }));
    const textsAtFocus: string[] = [];
    panel.addEventListener('focus', () => { textsAtFocus.push(status.textContent ?? ''); });
    press(submitIn('配達済みにする'));

    expect(await screen.findByText('配達済みにしました。')).toBeInTheDocument();
    expect(textsAtFocus).toEqual(['']);
    expect(panel).toHaveFocus();
    expect(screen.getByRole('status')).toBe(status);
    expect(status).toHaveTextContent('配達済みにしました。');
  });

  it('直す画面で背景を押しても、履歴ごとは閉じず、直す画面だけを閉じる。送っている間は閉じない', async () => {
    const post = deferredResponse();
    const { onClose } = await openDeliveryHistory([shipmentWithDelivery()]);
    mockClientFetch
      .mockReturnValueOnce(post.promise)
      .mockResolvedValueOnce(json(history({ entries: [shipmentWithDelivery()] })));

    press(screen.getByRole('button', { name: '伝票番号を直す' }));
    fireEvent.change(screen.getByLabelText('伝票番号'), { target: { value: 'AB-99' } });
    press(submitIn('伝票番号を直す'));
    const overlay = screen.getByRole('dialog', { name: '伝票番号を直す' }).parentElement as HTMLElement;
    fireEvent.click(overlay);
    expect(screen.getByRole('dialog', { name: '伝票番号を直す' })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => { post.resolve(json({ data: { trackingChangeId: 'change-9', trackingVersion: 2, replayed: false } })); });
    await flush();
    expect(screen.getByRole('dialog', { name: 'この注文の履歴' })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('配達済みにできたら、窓口へ送り、履歴を読み直し、親に知らせ、成功の知らせを出す。消えたボタンではなくパネルにフォーカスが留まる', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-21T03:00:00.000Z'));
    const onChanged = jest.fn();
    await openDeliveryHistory([shipmentWithDelivery()], { onChanged });
    mockClientFetch
      .mockResolvedValueOnce(json({ data: { eventId: 'event-9', deliveredAt: '2026-10-15T03:00:00.000Z', replayed: false } }))
      .mockResolvedValueOnce(json(history({
        entries: [shipmentWithDelivery({ deliveryStatus: 'delivered', deliveredAt: '2026-10-15T03:00:00.000Z', deliveredSource: 'manual' })],
      })));

    press(screen.getByRole('button', { name: '配達済みにする' }));
    fireEvent.change(screen.getByLabelText('届いた日'), { target: { value: '2026-10-15' } });
    press(submitIn('配達済みにする'));

    expect(await screen.findByText('配達済みにしました。')).toBeInTheDocument();
    expect(mockClientFetch).toHaveBeenNthCalledWith(2, DELIVERED_POST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: expect.any(String),
    });
    const body = JSON.parse((mockClientFetch.mock.calls[1][1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body).toEqual({ requestKey: expect.any(String), deliveredOn: '2026-10-15', notifyCustomer: true });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('配達済みにしました。');
    await waitFor(() => expect(screen.getByText('お届け日 10月15日（手で）')).toBeVisible());
    expect(screen.queryByRole('button', { name: '配達済みにする' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'この注文の履歴' })).toHaveFocus();
  });

  it('結果が分からないまま戻ると、履歴を読み直し、親にも知らせるが、成功の知らせは出さない', async () => {
    const onChanged = jest.fn();
    await openDeliveryHistory([shipmentWithDelivery()], { onChanged });
    mockClientFetch
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json(history({ entries: [shipmentWithDelivery()] })));

    press(screen.getByRole('button', { name: '伝票番号を直す' }));
    fireEvent.change(screen.getByLabelText('伝票番号'), { target: { value: 'AB-99' } });
    press(submitIn('伝票番号を直す'));
    await screen.findByText('結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。');
    press(screen.getByRole('button', { name: '戻る' }));

    expect(screen.getByRole('dialog', { name: 'この注文の履歴' })).toBeInTheDocument();
    expect(mockClientFetch).toHaveBeenNthCalledWith(3, HISTORY_URL, { cache: 'no-store' });
    expect(onChanged).toHaveBeenCalledTimes(1);
    await flush();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();
  });

  it('断られた間は直す画面に留まり、親には知らせない', async () => {
    const onChanged = jest.fn();
    await openDeliveryHistory([shipmentWithDelivery()], { onChanged });
    mockClientFetch.mockResolvedValueOnce(json({ error: '取り消した発送は変更できません。', code: 'DELIVERY_FULFILLMENT_CANCELLED' }, 409));

    press(screen.getByRole('button', { name: '伝票番号を直す' }));
    fireEvent.change(screen.getByLabelText('伝票番号'), { target: { value: 'AB-99' } });
    press(submitIn('伝票番号を直す'));

    expect(await screen.findByText('取り消した発送は変更できません。')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: '伝票番号を直す' })).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });
});
