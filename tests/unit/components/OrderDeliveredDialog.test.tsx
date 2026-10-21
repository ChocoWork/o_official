import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FulfillmentDeliveryDetail } from '@/lib/orders/tracking/delivery-types';

const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));

import OrderDeliveredDialog from '@/components/OrderDeliveredDialog';

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const FULFILLMENT_ID = 'f1f1f1f1-1111-2222-8333-444455556666';
const DELIVERED_URL = `/api/admin/orders/${ORDER_ID}/fulfillments/${FULFILLMENT_ID}/delivered`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATA = { eventId: 'event-1', deliveredAt: '2026-10-21T03:00:00.000Z', replayed: false };

/** 日本時間 2026-10-21 12:00 */
const NOW = Date.parse('2026-10-21T03:00:00.000Z');
/** 日本時間 2026-10-10 11:00 */
const SHIPPED_AT = '2026-10-10T02:00:00.000Z';

const OFF_TEXT = 'お客様に届いたことが分かった時に使います。返品の期限は、この日から数えます';
const ON_TEXT = '追跡で配達済みにならない時に使います。この後、この伝票番号の追跡は止まります';
const DATE_INVALID = '届いた日は、発送の日から今日までの日を選んでください。';
const UNKNOWN = '結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。';

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function unreadable(status: number) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError('Unexpected end of JSON input');
    },
  } as unknown as Response;
}

function deferredResponse() {
  let resolve: (value: Response) => void = () => {};
  const promise = new Promise<Response>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function detail(overrides: Partial<FulfillmentDeliveryDetail> = {}): FulfillmentDeliveryDetail {
  return {
    fulfillmentId: FULFILLMENT_ID, number: 1, carrier: 'yamato', trackingNumber: '1234-5678', notifyCustomer: true,
    shippedAt: SHIPPED_AT, cancelledAt: null, trackingVersion: 1, deliveryStatus: 'in_transit',
    deliveryStatusAt: '2026-10-11T02:00:00.000Z', deliveredAt: null, deliveredSource: null, registration: null,
    events: [], trackingChanges: [],
    ...overrides,
  };
}

function renderDialog(options: { fulfillment?: Partial<FulfillmentDeliveryDetail>; trackingEnabled?: boolean } = {}) {
  const handlers = { onClose: jest.fn(), onChanged: jest.fn(), onUncertain: jest.fn() };
  const view = render(
    <OrderDeliveredDialog
      open
      orderId={ORDER_ID}
      fulfillment={detail(options.fulfillment)}
      trackingEnabled={options.trackingEnabled ?? false}
      {...handlers}
    />,
  );
  return { ...handlers, ...view };
}

function sentBodies(): Array<Record<string, unknown>> {
  return mockClientFetch.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, unknown>);
}

const dateField = () => screen.getByLabelText('届いた日');
const submitButton = () => screen.getByRole('button', { name: '配達済みにする' });
const notifyBox = () => screen.getByRole('checkbox', { name: 'お客様に配達済みのメールを送る' });

beforeEach(() => {
  mockClientFetch.mockReset();
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('OrderDeliveredDialog の表示', () => {
  it('題が名前のダイアログに、届いた日（最初は日本時間の今日）とメールのチェック（最初はオン）を出す', () => {
    renderDialog();

    expect(screen.getByRole('dialog', { name: '配達済みにする' })).toBeInTheDocument();
    expect(dateField()).toHaveValue('2026-10-21');
    expect(notifyBox()).toBeChecked();
    expect(screen.getByRole('button', { name: '戻る' })).toBeInTheDocument();
    expect(submitButton()).toBeEnabled();
  });

  it('届いた日の下限は発送の日（日本時間）、上限は今日（日本時間）', () => {
    renderDialog();

    expect(dateField()).toHaveAttribute('min', '2026-10-10');
    expect(dateField()).toHaveAttribute('max', '2026-10-21');
  });

  it('日付の境目: 世界時の前日でも日本時間で翌日なら、今日は日本時間の日付。発送の日も日本時間で数える', () => {
    // 世界時 2026-10-20 15:30 は、日本時間では 2026-10-21 00:30
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-20T15:30:00.000Z'));
    // 世界時 2026-10-09 16:00 は、日本時間では 2026-10-10 01:00
    renderDialog({ fulfillment: { shippedAt: '2026-10-09T16:00:00.000Z' } });

    expect(dateField()).toHaveValue('2026-10-21');
    expect(dateField()).toHaveAttribute('max', '2026-10-21');
    expect(dateField()).toHaveAttribute('min', '2026-10-10');
  });

  it('追跡オフの説明の全文を出し、オンの説明は出さない', () => {
    renderDialog({ trackingEnabled: false });

    expect(screen.getByText(OFF_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(ON_TEXT)).not.toBeInTheDocument();
  });

  it('追跡オンの説明の全文を出し、オフの説明は出さない', () => {
    renderDialog({ trackingEnabled: true });

    expect(screen.getByText(ON_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(OFF_TEXT)).not.toBeInTheDocument();
  });

  it('発送のメールを送らない発送には、配達済みのメールのチェックを出さない', () => {
    renderDialog({ fulfillment: { notifyCustomer: false } });

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});

describe('OrderDeliveredDialog の送信', () => {
  it('届いた日・メールの選択と、開いた時の番号だけを送る', async () => {
    mockClientFetch.mockResolvedValueOnce(json({ data: DATA }));
    const { onChanged, onClose } = renderDialog();

    fireEvent.change(dateField(), { target: { value: '2026-10-15' } });
    fireEvent.click(submitButton());

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(mockClientFetch).toHaveBeenCalledWith(DELIVERED_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: expect.any(String),
    });
    expect(sentBodies()[0]).toEqual({
      requestKey: expect.stringMatching(UUID),
      deliveredOn: '2026-10-15',
      notifyCustomer: true,
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('チェックを外すと notifyCustomer=false で送る', async () => {
    mockClientFetch.mockResolvedValueOnce(json({ data: DATA }));
    const { onChanged } = renderDialog();

    fireEvent.click(notifyBox());
    fireEvent.click(submitButton());

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(sentBodies()[0].notifyCustomer).toBe(false);
  });

  it('発送のメールを送らない発送は、チェックが無いので notifyCustomer=false で送る', async () => {
    mockClientFetch.mockResolvedValueOnce(json({ data: DATA }));
    const { onChanged } = renderDialog({ fulfillment: { notifyCustomer: false } });

    fireEvent.click(submitButton());

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(sentBodies()[0].notifyCustomer).toBe(false);
  });

  it('成功したら、親へ知らせてから閉じる（前の結果の再送でも同じ）', async () => {
    mockClientFetch.mockResolvedValueOnce(json({ data: { ...DATA, replayed: true } }));
    const order: string[] = [];
    const onChanged = jest.fn(() => order.push('changed'));
    const onClose = jest.fn(() => order.push('close'));
    render(
      <OrderDeliveredDialog open orderId={ORDER_ID} fulfillment={detail()} trackingEnabled onChanged={onChanged} onClose={onClose} />,
    );

    fireEvent.click(submitButton());

    await waitFor(() => expect(order).toEqual(['changed', 'close']));
  });

  it('送っている間は「保存しています…」になり、ボタンは押せず、二重に送らない。戻る・Escape でも閉じない', async () => {
    const post = deferredResponse();
    mockClientFetch.mockReturnValueOnce(post.promise);
    const { onChanged, onClose } = renderDialog();
    fireEvent.click(submitButton());

    const saving = await screen.findByRole('button', { name: '保存しています…' });
    expect(saving).toBeDisabled();
    expect(screen.getByRole('button', { name: '戻る' })).toBeDisabled();
    expect(dateField()).toBeDisabled();
    fireEvent.click(saving);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      post.resolve(json({ data: DATA }));
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
  });
});

describe('OrderDeliveredDialog の日付の誤り', () => {
  it.each([
    ['未入力', ''],
    ['発送の日より前', '2026-10-09'],
    ['今日より後', '2026-10-22'],
    ['日付の形でない', '2026/10/15'],
    ['無い日付', '2026-02-30'],
  ])('届いた日が %s なら送らず、文を出す', (_label, value) => {
    renderDialog();

    fireEvent.change(dateField(), { target: { value } });
    fireEvent.click(submitButton());

    expect(screen.getByRole('alert')).toHaveTextContent(DATE_INVALID);
    expect(mockClientFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['発送の日', '2026-10-10'],
    ['今日', '2026-10-21'],
  ])('届いた日が %s なら送れる', async (_label, value) => {
    mockClientFetch.mockResolvedValueOnce(json({ data: DATA }));
    const { onChanged } = renderDialog();

    fireEvent.change(dateField(), { target: { value } });
    fireEvent.click(submitButton());

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(sentBodies()[0].deliveredOn).toBe(value);
  });

  it('日付を直して送ると、前の誤りの文は消える', async () => {
    mockClientFetch.mockResolvedValueOnce(json({ data: DATA }));
    renderDialog();
    fireEvent.change(dateField(), { target: { value: '' } });
    fireEvent.click(submitButton());
    expect(screen.getByRole('alert')).toBeInTheDocument();

    fireEvent.change(dateField(), { target: { value: '2026-10-15' } });
    fireEvent.click(submitButton());

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});

describe('OrderDeliveredDialog の窓口の答えの分け方と二重防止の番号', () => {
  it.each([
    [401, '認証が必要です。再ログインしてください。'],
    [403, 'この操作の権限がありません。'],
    [429, 'しばらくしてから、もう一度お試しください。'],
  ])('%i は文を出し、入力と番号を保つ。押し直すと同じ番号で送る', async (status, message) => {
    mockClientFetch.mockResolvedValueOnce(json({ error: 'Forbidden' }, status)).mockResolvedValueOnce(json({ data: DATA }));
    const { onChanged } = renderDialog();
    fireEvent.change(dateField(), { target: { value: '2026-10-15' } });
    fireEvent.click(submitButton());

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(dateField()).toBeEnabled();
    expect(dateField()).toHaveValue('2026-10-15');
    expect(screen.queryByRole('button', { name: 'もう一度確かめる' })).not.toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();

    fireEvent.click(submitButton());

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    const [first, second] = sentBodies();
    expect(second.requestKey).toBe(first.requestKey);
    expect(second).toEqual(first);
  });

  it.each([
    [400, DATE_INVALID],
    [404, '発送の記録が見つかりません。'],
    [409, 'すでに配達済みです。履歴を読み直してください。'],
  ])('%i は窓口の文を出し、入力へ戻して、次は新しい番号で送る', async (status, message) => {
    mockClientFetch.mockResolvedValueOnce(json({ error: message, code: 'X' }, status)).mockResolvedValueOnce(json({ data: DATA }));
    const { onChanged } = renderDialog();
    fireEvent.click(submitButton());

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(dateField()).toBeEnabled();
    expect(onChanged).not.toHaveBeenCalled();

    fireEvent.click(submitButton());

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    const [first, second] = sentBodies();
    expect(second.requestKey).toMatch(UUID);
    expect(second.requestKey).not.toBe(first.requestKey);
  });

  it.each([
    ['500', () => Promise.resolve(json({}, 500))],
    ['通信切れ', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['読めない成功', () => Promise.resolve(unreadable(200))],
  ])('結果が分からない（%s）時は入力を止め、同じ番号と同じ中身だけで「もう一度確かめる」', async (_label, outcome) => {
    mockClientFetch.mockImplementationOnce(outcome).mockResolvedValueOnce(json({ data: { ...DATA, replayed: true } }));
    const { onChanged, onClose } = renderDialog();
    fireEvent.change(dateField(), { target: { value: '2026-10-15' } });
    fireEvent.click(submitButton());

    expect(await screen.findByText(UNKNOWN)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(UNKNOWN);
    expect(dateField()).toBeDisabled();
    expect(notifyBox()).toBeDisabled();
    expect(screen.queryByRole('button', { name: '配達済みにする' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'もう一度確かめる' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
    const [firstBody, secondBody] = sentBodies();
    expect(secondBody.requestKey).toBe(firstBody.requestKey);
    expect(secondBody).toEqual(firstBody);
  });

  it('結果不明の確かめ直しが窓口に断られたら、入力へ戻して新しい番号にする', async () => {
    mockClientFetch
      .mockResolvedValueOnce(json({}, 500))
      .mockResolvedValueOnce(json({ error: 'すでに配達済みです。履歴を読み直してください。' }, 409))
      .mockResolvedValueOnce(json({ data: DATA }));
    renderDialog();
    fireEvent.click(submitButton());
    await screen.findByText(UNKNOWN);
    fireEvent.click(screen.getByRole('button', { name: 'もう一度確かめる' }));

    expect(await screen.findByText('すでに配達済みです。履歴を読み直してください。')).toBeInTheDocument();
    expect(screen.queryByText(UNKNOWN)).not.toBeInTheDocument();
    expect(dateField()).toBeEnabled();

    fireEvent.click(submitButton());
    await waitFor(() => expect(mockClientFetch).toHaveBeenCalledTimes(3));
    const bodies = sentBodies();
    expect(bodies[2].requestKey).not.toBe(bodies[0].requestKey);
  });

  it('開き直すたびに新しい二重防止の番号になり、届いた日も今日に戻る', async () => {
    mockClientFetch.mockResolvedValue(json({ data: DATA }));
    const common = { orderId: ORDER_ID, fulfillment: detail(), trackingEnabled: false, onChanged: jest.fn(), onClose: jest.fn() };
    const { rerender } = render(<OrderDeliveredDialog open {...common} />);
    fireEvent.change(dateField(), { target: { value: '2026-10-15' } });
    fireEvent.click(submitButton());
    await waitFor(() => expect(mockClientFetch).toHaveBeenCalledTimes(1));

    rerender(<OrderDeliveredDialog open={false} {...common} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    rerender(<OrderDeliveredDialog open {...common} />);
    expect(dateField()).toHaveValue('2026-10-21');
    fireEvent.click(submitButton());
    await waitFor(() => expect(mockClientFetch).toHaveBeenCalledTimes(2));

    const [first, second] = sentBodies();
    expect(second.requestKey).not.toBe(first.requestKey);
  });
});

describe('OrderDeliveredDialog の閉じ方とフォーカス', () => {
  it('戻るでは何も送らず、親の読み直しも頼まない', () => {
    const { onClose, onChanged, onUncertain } = renderDialog();

    fireEvent.click(screen.getByRole('button', { name: '戻る' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onChanged).not.toHaveBeenCalled();
    expect(onUncertain).not.toHaveBeenCalled();
    expect(mockClientFetch).not.toHaveBeenCalled();
  });

  it('結果が分からないまま戻ると、記録されたかもしれないので、親に読み直しを頼んでから閉じる', async () => {
    mockClientFetch.mockResolvedValueOnce(json({}, 500));
    const { onClose, onChanged, onUncertain } = renderDialog();
    fireEvent.click(submitButton());
    await screen.findByText(UNKNOWN);

    fireEvent.click(screen.getByRole('button', { name: '戻る' }));

    expect(onUncertain).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('Escape で閉じる', () => {
    const { onClose } = renderDialog();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('開くと中の最初の入力へフォーカスが移り、戻ると開いたボタンへフォーカスが返る', () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            配達済みの画面を開く
          </button>
          <OrderDeliveredDialog
            open={open}
            orderId={ORDER_ID}
            fulfillment={detail()}
            trackingEnabled={false}
            onClose={() => setOpen(false)}
            onChanged={jest.fn()}
          />
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole('button', { name: '配達済みの画面を開く' });
    opener.focus();
    fireEvent.click(opener);

    expect(dateField()).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: '戻る' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('Tab は中で循環し、外へ出ない', () => {
    renderDialog();

    submitButton().focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(dateField()).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(submitButton()).toHaveFocus();
  });
});
