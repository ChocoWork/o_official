import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type {
  OrderHistoryCompletionEntry,
  OrderHistoryEmailEntry,
  OrderHistoryFulfillmentEntry,
  OrderHistoryResponse,
} from '@/lib/orders/email/order-history';

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
