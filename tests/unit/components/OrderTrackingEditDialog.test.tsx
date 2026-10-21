import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FulfillmentDeliveryDetail } from '@/lib/orders/tracking/delivery-types';

const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));

import OrderTrackingEditDialog from '@/components/OrderTrackingEditDialog';

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const FULFILLMENT_ID = 'f1f1f1f1-1111-2222-8333-444455556666';
const TRACKING_URL = `/api/admin/orders/${ORDER_ID}/fulfillments/${FULFILLMENT_ID}/tracking`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATA = { trackingChangeId: 'change-1', trackingVersion: 2, replayed: false };

const ON_TEXT = '直すと配送の状況は受付済みに戻り、新しい伝票番号で追跡します。チェックを外すと、この先の配達中・配達済みのメールも送りません';
const OFF_TEXT = 'チェックを外すと、この先の配達済みのメールも送りません';
const RESET_WARNING = '配達済みの記録が消え、返品の期限は新しい届いた日から数え直します';
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
    shippedAt: '2026-10-10T02:00:00.000Z', cancelledAt: null, trackingVersion: 1, deliveryStatus: 'confirmed',
    deliveryStatusAt: '2026-10-10T02:00:00.000Z', deliveredAt: null, deliveredSource: null, registration: null,
    events: [], trackingChanges: [],
    ...overrides,
  };
}

function renderDialog(options: { fulfillment?: Partial<FulfillmentDeliveryDetail>; trackingEnabled?: boolean } = {}) {
  const handlers = { onClose: jest.fn(), onChanged: jest.fn(), onUncertain: jest.fn() };
  const view = render(
    <OrderTrackingEditDialog
      open
      orderId={ORDER_ID}
      fulfillment={detail(options.fulfillment)}
      trackingEnabled={options.trackingEnabled ?? false}
      {...handlers}
    />,
  );
  return { ...handlers, ...view };
}

/** 窓口へ送った本文を、送った順に返す */
function sentBodies(): Array<Record<string, unknown>> {
  return mockClientFetch.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, unknown>);
}

function fill(carrier: string, trackingNumber: string) {
  fireEvent.change(screen.getByLabelText('配送業者'), { target: { value: carrier } });
  fireEvent.change(screen.getByLabelText('伝票番号'), { target: { value: trackingNumber } });
}

const submitButton = () => screen.getByRole('button', { name: '伝票番号を直す' });

beforeEach(() => {
  mockClientFetch.mockReset();
});

describe('OrderTrackingEditDialog の表示', () => {
  it('題が名前のダイアログに、配送業者・伝票番号・メールのチェックを、今の発送の値で出す', () => {
    renderDialog();

    expect(screen.getByRole('dialog', { name: '伝票番号を直す' })).toBeInTheDocument();
    expect(screen.getByLabelText('配送業者')).toHaveValue('yamato');
    expect(screen.getByLabelText('伝票番号')).toHaveValue('1234-5678');
    expect(screen.getByRole('checkbox', { name: 'お客様に発送の更新のメールを送る' })).toBeChecked();
    expect(screen.getByRole('button', { name: '戻る' })).toBeInTheDocument();
    expect(submitButton()).toBeEnabled();
  });

  it('メールのチェックの最初の値は、その発送のメールの選択（送らない発送なら外れている）', () => {
    renderDialog({ fulfillment: { notifyCustomer: false } });

    expect(screen.getByRole('checkbox', { name: 'お客様に発送の更新のメールを送る' })).not.toBeChecked();
  });

  it('配送業者が分からない昔の発送は、選ばれていない状態で出す', () => {
    renderDialog({ fulfillment: { carrier: null, trackingNumber: null } });

    expect(screen.getByLabelText('配送業者')).toHaveValue('');
    expect(screen.getByLabelText('伝票番号')).toHaveValue('');
  });

  it('追跡オンの説明の全文を出し、オフの説明は出さない', () => {
    renderDialog({ trackingEnabled: true });

    expect(screen.getByText(ON_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(OFF_TEXT)).not.toBeInTheDocument();
  });

  it('追跡オフの説明の全文を出し、オンの説明は出さない', () => {
    renderDialog({ trackingEnabled: false });

    expect(screen.getByText(OFF_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(ON_TEXT)).not.toBeInTheDocument();
  });

  it('配達済みの発送を直す時だけ、返品の期限の警告を出す', () => {
    const { unmount } = renderDialog({ fulfillment: { deliveredAt: '2026-10-12T03:00:00.000Z', deliveryStatus: 'delivered', deliveredSource: 'manual' } });
    expect(screen.getByText(RESET_WARNING)).toBeVisible();
    unmount();

    renderDialog();
    expect(screen.queryByText(RESET_WARNING)).not.toBeInTheDocument();
  });

  it('伝票番号の欄は、狭い画面でも枠いっぱいに広がり、はみ出さない', () => {
    renderDialog();

    expect(screen.getByLabelText('伝票番号')).toHaveClass('w-full');
    expect(screen.getByLabelText('配送業者')).toHaveClass('w-full');
  });
});

describe('OrderTrackingEditDialog の送信', () => {
  it('配送業者・伝票番号（前後の空白を除く）・メールの選択と、開いた時の番号だけを送る', async () => {
    mockClientFetch.mockResolvedValueOnce(json({ data: DATA }));
    const { onChanged, onClose } = renderDialog();

    fill('sagawa', ' AB-99 ');
    fireEvent.click(screen.getByRole('checkbox', { name: 'お客様に発送の更新のメールを送る' }));
    fireEvent.click(submitButton());

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
    expect(mockClientFetch).toHaveBeenCalledWith(TRACKING_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: expect.any(String),
    });
    expect(sentBodies()[0]).toEqual({
      requestKey: expect.stringMatching(UUID),
      carrier: 'sagawa',
      trackingNumber: 'AB-99',
      notifyCustomer: false,
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('成功したら、親へ知らせてから閉じる（前の結果の再送でも同じ）', async () => {
    mockClientFetch.mockResolvedValueOnce(json({ data: { ...DATA, replayed: true } }));
    const order: string[] = [];
    const onChanged = jest.fn(() => order.push('changed'));
    const onClose = jest.fn(() => order.push('close'));
    render(
      <OrderTrackingEditDialog open orderId={ORDER_ID} fulfillment={detail()} trackingEnabled={false} onChanged={onChanged} onClose={onClose} />,
    );

    fill('japanpost', '9876');
    fireEvent.click(submitButton());

    await waitFor(() => expect(order).toEqual(['changed', 'close']));
  });

  it('送っている間は「保存しています…」になり、ボタンは押せず、二重に送らない。戻る・Escape でも閉じない', async () => {
    const post = deferredResponse();
    mockClientFetch.mockReturnValueOnce(post.promise);
    const { onChanged, onClose } = renderDialog();
    fill('sagawa', 'AB-99');
    fireEvent.click(submitButton());

    const saving = await screen.findByRole('button', { name: '保存しています…' });
    expect(saving).toBeDisabled();
    expect(screen.getByRole('button', { name: '戻る' })).toBeDisabled();
    expect(screen.getByLabelText('伝票番号')).toBeDisabled();
    fireEvent.click(saving);
    fireEvent.click(screen.getByRole('button', { name: '戻る' }));
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

describe('OrderTrackingEditDialog の入力の誤り', () => {
  it('配送業者が選ばれていなければ送らず、文を出す', () => {
    renderDialog({ fulfillment: { carrier: null } });

    fireEvent.change(screen.getByLabelText('伝票番号'), { target: { value: '1234' } });
    fireEvent.click(submitButton());

    expect(screen.getByRole('alert')).toHaveTextContent('配送業者を選んでください。');
    expect(mockClientFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['空', ''],
    ['空白だけ', '   '],
    ['日本語', 'あいう'],
    ['記号', 'AB_12'],
    ['65字', 'A'.repeat(65)],
  ])('伝票番号が %s なら送らず、文を出す', (_label, value) => {
    renderDialog();

    fill('yamato', value);
    fireEvent.click(submitButton());

    expect(screen.getByRole('alert')).toHaveTextContent('伝票番号は英数字とハイフンで1〜64字にしてください。');
    expect(mockClientFetch).not.toHaveBeenCalled();
  });

  it('64字ちょうどの英数字とハイフンは送る', async () => {
    mockClientFetch.mockResolvedValueOnce(json({ data: DATA }));
    const { onChanged } = renderDialog();

    fill('yamato', `${'A'.repeat(63)}-`);
    fireEvent.click(submitButton());

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(sentBodies()[0].trackingNumber).toBe(`${'A'.repeat(63)}-`);
  });

  it('直し直して送ると、前の誤りの文は消える', async () => {
    mockClientFetch.mockResolvedValueOnce(json({ data: DATA }));
    renderDialog();
    fill('yamato', 'あいう');
    fireEvent.click(submitButton());
    expect(screen.getByRole('alert')).toBeInTheDocument();

    fill('yamato', 'AB-1');
    fireEvent.click(submitButton());

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});

describe('OrderTrackingEditDialog の窓口の答えの分け方と二重防止の番号', () => {
  it.each([
    [401, '認証が必要です。再ログインしてください。'],
    [403, 'この操作の権限がありません。'],
    [429, 'しばらくしてから、もう一度お試しください。'],
  ])('%i は文を出し、入力と番号を保つ。押し直すと同じ番号で送る', async (status, message) => {
    mockClientFetch.mockResolvedValueOnce(json({ error: 'Forbidden' }, status)).mockResolvedValueOnce(json({ data: DATA }));
    const { onChanged } = renderDialog();
    fill('sagawa', 'AB-99');
    fireEvent.click(submitButton());

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(screen.getByLabelText('伝票番号')).toBeEnabled();
    expect(screen.getByLabelText('伝票番号')).toHaveValue('AB-99');
    expect(screen.queryByRole('button', { name: 'もう一度確かめる' })).not.toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();

    fireEvent.click(submitButton());

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    const [first, second] = sentBodies();
    expect(second.requestKey).toBe(first.requestKey);
    expect(second).toEqual(first);
  });

  it.each([
    [400, '入力を確かめてください。'],
    [404, '発送の記録が見つかりません。'],
    [409, '取り消した発送は変更できません。'],
  ])('%i は窓口の文を出し、入力へ戻して、次は新しい番号で送る', async (status, message) => {
    mockClientFetch.mockResolvedValueOnce(json({ error: message, code: 'X' }, status)).mockResolvedValueOnce(json({ data: DATA }));
    const { onChanged } = renderDialog();
    fill('sagawa', 'AB-99');
    fireEvent.click(submitButton());

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByLabelText('伝票番号')).toBeEnabled();
    expect(onChanged).not.toHaveBeenCalled();

    fill('sagawa', 'AB-100');
    fireEvent.click(submitButton());

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    const [first, second] = sentBodies();
    expect(first.requestKey).toMatch(UUID);
    expect(second.requestKey).toMatch(UUID);
    expect(second.requestKey).not.toBe(first.requestKey);
    expect(second.trackingNumber).toBe('AB-100');
  });

  it.each([
    ['500', () => Promise.resolve(json({}, 500))],
    ['通信切れ', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['読めない成功', () => Promise.resolve(unreadable(200))],
  ])('結果が分からない（%s）時は入力を止め、同じ番号と同じ中身だけで「もう一度確かめる」', async (_label, outcome) => {
    mockClientFetch.mockImplementationOnce(outcome).mockResolvedValueOnce(json({ data: { ...DATA, replayed: true } }));
    const { onChanged, onClose } = renderDialog();
    fill('sagawa', 'AB-99');
    fireEvent.click(submitButton());

    expect(await screen.findByText(UNKNOWN)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(UNKNOWN);
    expect(screen.getByLabelText('配送業者')).toBeDisabled();
    expect(screen.getByLabelText('伝票番号')).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'お客様に発送の更新のメールを送る' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '伝票番号を直す' })).not.toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'もう一度確かめる' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
    const [firstBody, secondBody] = sentBodies();
    expect(secondBody.requestKey).toBe(firstBody.requestKey);
    expect(secondBody).toEqual(firstBody);
  });

  it('結果不明のままもう一度確かめて、また分からなければ、入力は止めたまま同じ中身を保つ', async () => {
    mockClientFetch
      .mockResolvedValueOnce(json({}, 503))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json({ data: DATA }));
    const { onChanged } = renderDialog();
    fill('sagawa', 'AB-99');
    fireEvent.click(submitButton());
    await screen.findByText(UNKNOWN);

    fireEvent.click(screen.getByRole('button', { name: 'もう一度確かめる' }));
    await waitFor(() => expect(mockClientFetch).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(UNKNOWN)).toBeInTheDocument();
    expect(screen.getByLabelText('伝票番号')).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'もう一度確かめる' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    const bodies = sentBodies();
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
  });

  it('結果不明の間に権限や回数の制限で断られても、番号・中身・結果不明の状態を保ち、断りの文の後に続ける', async () => {
    mockClientFetch
      .mockResolvedValueOnce(json({}, 500))
      .mockResolvedValueOnce(json({ error: 'Too many requests' }, 429))
      .mockResolvedValueOnce(json({ data: DATA }));
    const { onChanged } = renderDialog();
    fill('sagawa', 'AB-99');
    fireEvent.click(submitButton());
    await screen.findByText(UNKNOWN);

    fireEvent.click(screen.getByRole('button', { name: 'もう一度確かめる' }));

    expect(await screen.findByText('しばらくしてから、もう一度お試しください。')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(UNKNOWN);
    expect(screen.getByLabelText('伝票番号')).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'もう一度確かめる' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    const bodies = sentBodies();
    expect(bodies[2]).toEqual(bodies[0]);
  });

  it('結果不明の確かめ直しが窓口に断られたら、入力へ戻して新しい番号にする', async () => {
    mockClientFetch
      .mockResolvedValueOnce(json({}, 500))
      .mockResolvedValueOnce(json({ error: '配送業者か伝票番号を直してください。' }, 409))
      .mockResolvedValueOnce(json({ data: DATA }));
    renderDialog();
    fill('sagawa', 'AB-99');
    fireEvent.click(submitButton());
    await screen.findByText(UNKNOWN);
    fireEvent.click(screen.getByRole('button', { name: 'もう一度確かめる' }));

    expect(await screen.findByText('配送業者か伝票番号を直してください。')).toBeInTheDocument();
    expect(screen.queryByText(UNKNOWN)).not.toBeInTheDocument();
    expect(screen.getByLabelText('伝票番号')).toBeEnabled();

    fill('sagawa', 'AB-100');
    fireEvent.click(submitButton());
    await waitFor(() => expect(mockClientFetch).toHaveBeenCalledTimes(3));
    const bodies = sentBodies();
    expect(bodies[2].requestKey).not.toBe(bodies[0].requestKey);
  });

  it('開き直すたびに新しい二重防止の番号になる', async () => {
    mockClientFetch.mockResolvedValue(json({ data: DATA }));
    const common = { orderId: ORDER_ID, fulfillment: detail(), trackingEnabled: false, onChanged: jest.fn(), onClose: jest.fn() };
    const { rerender } = render(<OrderTrackingEditDialog open {...common} />);
    fill('sagawa', 'AB-99');
    fireEvent.click(submitButton());
    await waitFor(() => expect(mockClientFetch).toHaveBeenCalledTimes(1));

    rerender(<OrderTrackingEditDialog open={false} {...common} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    rerender(<OrderTrackingEditDialog open {...common} />);
    fill('sagawa', 'AB-99');
    fireEvent.click(submitButton());
    await waitFor(() => expect(mockClientFetch).toHaveBeenCalledTimes(2));

    const [first, second] = sentBodies();
    expect(second.requestKey).not.toBe(first.requestKey);
  });
});

describe('OrderTrackingEditDialog の閉じ方とフォーカス', () => {
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
    fill('sagawa', 'AB-99');
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
            直す画面を開く
          </button>
          <OrderTrackingEditDialog
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
    const opener = screen.getByRole('button', { name: '直す画面を開く' });
    opener.focus();
    fireEvent.click(opener);

    expect(screen.getByLabelText('配送業者')).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: '戻る' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('Tab は中で循環し、外へ出ない', () => {
    renderDialog();

    submitButton().focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByLabelText('配送業者')).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(submitButton()).toHaveFocus();
  });
});
