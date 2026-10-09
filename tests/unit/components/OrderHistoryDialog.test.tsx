import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { OrderHistoryResponse } from '@/lib/orders/email/order-history';

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
      },
      { type: 'status', at: '2026-10-09T01:00:00.000Z', fromLabel: '支払い手続き中', toLabel: '決済完了', actorEmail: null, detail: null },
      { type: 'created', at: '2026-10-09T00:59:00.000Z' },
    ],
    ...overrides,
  };
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
    expect(await screen.findByRole('alert')).toHaveTextContent('履歴を見る権限がありません。');
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
