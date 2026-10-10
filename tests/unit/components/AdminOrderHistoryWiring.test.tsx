import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import AdminPage from '@/app/admin/page';

/**
 * 管理画面の ORDER タブと、履歴・発送・仕上がりの画面のつなぎ込み（グループ D の Task 7、グループ E-1 の Task 7）。
 * 部品ごとの試験（OrderHistoryDialog・OrderShipDialog・OrderCompletionDialog・OrderSection）では見えない、
 * 管理画面の中での配線を確かめる。一覧と各画面は本物を使い、窓口（clientFetch）だけを差し替える。
 */
const clientFetchMock = jest.fn();
const mockAttention = jest.fn();

jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('tab=ORDER'),
}));
jest.mock('@/contexts/LoginContext', () => ({
  useLogin: () => ({
    isLoggedIn: true,
    isAuthResolved: true,
    userRole: 'admin',
    isMfaVerified: true,
  }),
}));
jest.mock('@/lib/client-fetch', () => ({
  clientFetch: (...args: unknown[]) =>
    String(args[0]) === '/api/admin/order-attention'
      ? mockAttention(...args)
      : clientFetchMock(...args),
}));
jest.mock('@/components/AdminSideNav', () => () => null);
jest.mock('@/components/KpiSection', () => () => null);
jest.mock('@/components/AccountingSection', () => () => null);
jest.mock('@/components/NewsSection', () => () => null);
jest.mock('@/components/ItemSection', () => () => null);
jest.mock('@/components/LookSection', () => () => null);
jest.mock('@/components/StockistSection', () => () => null);
jest.mock('@/components/UserSection', () => () => null);

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const ITEM_ID = 'b1b2c3d4-1111-2222-8333-444455556666';
const COAT_ID = 'c1c2c3d4-1111-2222-8333-444455556666';
const FULFILLMENT_ID = 'f1f1f1f1-1111-2222-8333-444455556666';
/** 一覧に並ぶ、もう1つの注文 */
const OTHER_ORDER_ID = 'd1d2d3d4-1111-2222-8333-444455556666';

const BLOUSE = {
  id: ITEM_ID, name: 'シルクブラウス', color: '白', size: 'M', quantity: 1, fulfillmentType: 'stock',
  shipped: 0, inProduction: 0, readyUnshipped: 1,
};
const COAT_IN_PRODUCTION = {
  id: COAT_ID, name: 'ウールコート', color: '黒', size: 'L', quantity: 1, fulfillmentType: 'backorder',
  shipped: 0, inProduction: 1, readyUnshipped: 0,
};

/** 発送を待つ注文（在庫の品が1つ） */
function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    customerName: '山田 花子',
    customerEmail: 'hanako@example.com',
    orderDate: '2026-10-09',
    itemCount: '1点',
    items: [BLOUSE],
    totalAmount: '¥28,800',
    status: '発送準備中',
    orderStatus: 'paid',
    progressKey: 'ready',
    partiallyShipped: false,
    canShip: true,
    canRecordCompletion: false,
    ...overrides,
  };
}

/** 発送の画面・仕上がりの画面が読む「発送の材料」 */
function materialsBody(lines: unknown[]) {
  return {
    order: { id: ORDER_ID, orderNumber: 'ORD-A1B2C3D4', status: 'paid', progress: { key: 'ready', label: '発送準備中', partiallyShipped: false } },
    blockedReason: null,
    lines,
    fulfillments: [],
  };
}

const BLOUSE_LINE = {
  orderItemId: ITEM_ID, name: 'シルクブラウス', color: '白', size: 'M', fulfillmentType: 'stock',
  quantity: 1, shipped: 0, inProduction: 0, readyUnshipped: 1, unshipped: 1,
};
const COAT_LINE = {
  orderItemId: COAT_ID, name: 'ウールコート', color: '黒', size: 'L', fulfillmentType: 'backorder',
  quantity: 1, shipped: 0, inProduction: 1, readyUnshipped: 0, unshipped: 1,
};

const historyBody = {
  order: { id: ORDER_ID, orderNumber: 'ORD-A1B2C3D4', statusLabel: '決済完了', recipient: 'hanako@example.com' },
  sendPaused: null,
  entries: [{ type: 'created', at: '2026-10-09T00:59:00.000Z' }],
};

function ok(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body });
}

function refused(status: number, body: unknown) {
  return Promise.resolve({ ok: false, status, json: async () => body });
}

/** 管理画面が一覧を読んだ呼び出し（注文一覧の窓口） */
function listRequests() {
  return clientFetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/admin/orders?'));
}

/** 窓口（url の終わりが suffix）へ POST した本文。送っていなければ undefined */
function postedBody(suffix: string): Record<string, unknown> | undefined {
  const call = clientFetchMock.mock.calls.find(
    ([url, init]) => String(url).endsWith(suffix) && (init as RequestInit | undefined)?.method === 'POST',
  );
  return call ? (JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>) : undefined;
}

/** 一覧が返す行。窓口を呼んだ後に差し替えて、読み直した結果を再現する */
let orderRows: unknown[] = [];
/** 発送・仕上がり・取消の POST への答え（既定は成功） */
let postAnswer: (url: string) => Promise<unknown> = () => ok({});

/** 返事を止めておく。release(返事) で返す（画面の更新まで待つ） */
function hold() {
  let resolve: (answer: unknown) => void = () => undefined;
  const held = new Promise<unknown>((resolveHeld) => {
    resolve = resolveHeld;
  });
  return {
    held,
    release: (answer: unknown) =>
      act(async () => {
        resolve(answer);
        await held;
      }),
  };
}

/** 窓口（url の終わりが suffix）への POST の返事を止めておく。返すときは、戻り値の関数に返事を渡す */
function holdPost(suffix: string) {
  const { held, release } = hold();
  const previous = postAnswer;
  postAnswer = (url) => (url.endsWith(suffix) ? held : previous(url));
  return release;
}

/** 履歴に出す、取り消せる発送の行 */
const CANCELLABLE_SHIPMENT = {
  type: 'fulfillment', at: '2026-10-10T02:00:00.000Z', fulfillmentId: FULFILLMENT_ID, number: 1, carrierLabel: 'ヤマト運輸',
  trackingNumber: '1234-5678', items: [{ name: 'シルクブラウス', quantity: 1 }], actorEmail: 'admin@example.com',
  notifyCustomer: true, completesOrder: true, cancelled: false, cancellable: true, legacy: false,
};

/** 窓口の差し替え。一覧は orderRows、POST は postAnswer。発送の材料と履歴の行は引数で決める */
function serveOrdersApi({ lines = [BLOUSE_LINE], entries = historyBody.entries }: { lines?: unknown[]; entries?: unknown[] } = {}) {
  clientFetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const target = String(url);
    if (init?.method === 'POST') return postAnswer(target);
    if (target.startsWith('/api/admin/orders?')) {
      return ok({ data: orderRows, pagination: { page: 1, pageSize: 20, total: orderRows.length, totalPages: 1 } });
    }
    if (target.endsWith('/history')) return ok({ ...historyBody, entries });
    if (target.endsWith('/fulfillments')) return ok(materialsBody(lines));
    return ok({});
  });
}

describe('管理画面の注文の履歴・発送・仕上がりのつなぎ込み', () => {
  beforeEach(() => {
    clientFetchMock.mockReset();
    mockAttention.mockReset();
    mockAttention.mockImplementation(() => ok({ data: { exceptions: [], reviews: [], counts: { exceptions: 0, reviews: 0 } } }));
    orderRows = [orderRow()];
    postAnswer = (url) => {
      if (url.endsWith('/fulfillments')) {
        return ok({ fulfillmentId: 'fulfillment-1', number: 1, completesOrder: true, orderStatus: 'shipped', replayed: false });
      }
      if (url.endsWith('/completions')) return ok({ completionIds: ['completion-1'], replayed: false });
      return ok({ outcome: 'cancelled', orderStatus: 'paid' });
    };
    clientFetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const target = String(url);
      if (init?.method === 'POST') return postAnswer(target);
      if (target.startsWith('/api/admin/orders?')) {
        return ok({ data: orderRows, pagination: { page: 1, pageSize: 20, total: orderRows.length, totalPages: 1 } });
      }
      if (target.endsWith('/history')) return ok(historyBody);
      if (target.endsWith('/fulfillments')) return ok(materialsBody([BLOUSE_LINE]));
      return ok({});
    });
  });

  it.each(['送信元のドメインの設定', null])('送信を止めている時は ORDER の帯に原因 %s と再開の案内を出す', async (reasonLabel) => {
    mockAttention.mockImplementation(() => ok({ data: {
      exceptions: [], reviews: [], counts: { exceptions: 0, reviews: 0 }, emailSending: { paused: true, reasonLabel },
    } }));
    render(<AdminPage />);

    const title = await screen.findByText('お客様への注文のメールの送信を止めています');
    const banner = title.closest('[role="alert"]');
    expect(banner).toHaveAttribute('data-ui-banner-alert-variant', 'error');
    expect(banner).toHaveTextContent(`原因: ${reasonLabel ?? '不明'}。原因を直すと、15分ごとに1件ずつ試して自動で再開します（1日の送信の上限の時は日本時間 9時から）。手順は「注文のメールの手順書」の「送信の一時停止」にあります。`);
    expect(await screen.findByRole('button', { name: 'ORD-A1B2C3D4 の履歴' })).toBeInTheDocument();
  });

  it.each([
    ['止めていない', { emailSending: { paused: false, reasonLabel: null } }],
    ['値が null', { emailSending: null }],
    ['項目が無い', {}],
  ])('送信状態が %s 時は帯を出さず、注文を読み込める', async (_label, sending) => {
    mockAttention.mockImplementation(() => ok({ data: {
      exceptions: [], reviews: [], counts: { exceptions: 0, reviews: 0 }, ...sending,
    } }));
    render(<AdminPage />);
    await screen.findByRole('button', { name: 'ORD-A1B2C3D4 の履歴' });

    expect(screen.queryByText('お客様への注文のメールの送信を止めています')).not.toBeInTheDocument();
    expect(screen.queryByText('要対応・要確認を読み込めませんでした。')).not.toBeInTheDocument();
  });

  it('「履歴」を押すと履歴のダイアログが開き、Escape で閉じると、その「履歴」のボタンへフォーカスが戻る', async () => {
    render(<AdminPage />);
    const historyButton = await screen.findByRole('button', { name: 'ORD-A1B2C3D4 の履歴' });
    historyButton.focus();
    fireEvent.click(historyButton);

    const dialog = await screen.findByRole('dialog', { name: 'この注文の履歴' });
    await within(dialog).findByText('宛先: hanako@example.com');
    expect(clientFetchMock).toHaveBeenCalledWith(`/api/admin/orders/${ORDER_ID}/history`, { cache: 'no-store' });

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(historyButton).toHaveFocus();
  });

  it('履歴の画面で発送を取り消すと、履歴は開いたまま、一覧を読み直す', async () => {
    clientFetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const target = String(url);
      if (init?.method === 'POST') return postAnswer(target);
      if (target.startsWith('/api/admin/orders?')) {
        return ok({ data: orderRows, pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 } });
      }
      if (target.endsWith('/history')) {
        return ok({
          ...historyBody,
          entries: [
            {
              type: 'fulfillment', at: '2026-10-10T02:00:00.000Z', fulfillmentId: FULFILLMENT_ID, number: 1, carrierLabel: 'ヤマト運輸',
              trackingNumber: '1234-5678', items: [{ name: 'シルクブラウス', quantity: 1 }], actorEmail: 'admin@example.com',
              notifyCustomer: true, completesOrder: true, cancelled: false, cancellable: true, legacy: false,
            },
          ],
        });
      }
      return ok({});
    });
    render(<AdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'ORD-A1B2C3D4 の履歴' }));
    fireEvent.click(await screen.findByRole('button', { name: 'この発送を取り消す' }));
    expect(listRequests()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '取り消す' }));

    await waitFor(() => expect(listRequests()).toHaveLength(2));
    expect(clientFetchMock).toHaveBeenCalledWith(
      `/api/admin/orders/${ORDER_ID}/fulfillments/${FULFILLMENT_ID}/cancel`,
      { method: 'POST' },
    );
    expect(screen.getByRole('dialog', { name: 'この注文の履歴' })).toBeInTheDocument();
  });

  it('発送: 発送の画面が材料を読み、チェックを外すと notifyCustomer=false で発送の窓口へ送り、画面を閉じて、一覧を読み直す', async () => {
    postAnswer = (url) => {
      orderRows = [orderRow({
        status: '配送中', orderStatus: 'shipped', progressKey: 'in_transit', canShip: false,
        items: [{ ...BLOUSE, shipped: 1, readyUnshipped: 0 }],
      })];
      return url.endsWith('/fulfillments')
        ? ok({ fulfillmentId: 'fulfillment-1', number: 1, completesOrder: true, orderStatus: 'shipped', replayed: false })
        : ok({});
    };
    render(<AdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: '発送済みにする' }));

    const dialog = await screen.findByRole('dialog', { name: '発送済みにする' });
    expect(clientFetchMock).toHaveBeenCalledWith(`/api/admin/orders/${ORDER_ID}/fulfillments`, { cache: 'no-store' });
    const checkbox = await within(dialog).findByRole('checkbox', { name: 'お客様に発送のメールを送る' });
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    fireEvent.change(within(dialog).getByLabelText('追跡番号'), { target: { value: ' E2E-1 ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(postedBody('/fulfillments')).toEqual({
      requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
      carrier: 'yamato',
      trackingNumber: 'E2E-1',
      notifyCustomer: false,
      lines: [{ orderItemId: ITEM_ID, quantity: 1 }],
    });
    // 前の状態の窓口（/status）へは送らない。手元で言葉を書き換えず、読み直した一覧の言葉（配送中）を出す
    expect(clientFetchMock.mock.calls.some(([url]) => String(url).endsWith('/status'))).toBe(false);
    expect(await screen.findByText('配送中', { selector: 'span' })).toBeInTheDocument();
    expect(listRequests()).toHaveLength(2);
    expect(screen.queryByRole('button', { name: '発送済みにする' })).not.toBeInTheDocument();
  });

  it('発送: 既定のままなら notifyCustomer=true で送る', async () => {
    render(<AdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: '発送済みにする' }));
    const dialog = await screen.findByRole('dialog', { name: '発送済みにする' });
    await within(dialog).findByRole('checkbox', { name: 'お客様に発送のメールを送る' });
    fireEvent.change(within(dialog).getByLabelText('追跡番号'), { target: { value: '1234-5678' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));

    await waitFor(() => expect(postedBody('/fulfillments')).toBeDefined());
    expect(postedBody('/fulfillments')).toMatchObject({ carrier: 'yamato', trackingNumber: '1234-5678', notifyCustomer: true });
  });

  it('発送: 追跡番号が不正なら、画面の中に知らせて、送らず、画面は開いたまま', async () => {
    render(<AdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: '発送済みにする' }));
    const dialog = await screen.findByRole('dialog', { name: '発送済みにする' });
    await within(dialog).findByLabelText('追跡番号');
    fireEvent.change(within(dialog).getByLabelText('追跡番号'), { target: { value: 'あいう' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));

    expect(within(dialog).getByRole('alert')).toHaveTextContent('追跡番号は英数字とハイフンで入力してください。');
    expect(postedBody('/fulfillments')).toBeUndefined();
    expect(screen.getByRole('dialog', { name: '発送済みにする' })).toBeInTheDocument();
  });

  it('発送: 窓口が断ったら、画面を開いたまま理由を出し、一覧は読み直さない', async () => {
    const message = '発送する数が発送準備中の数を超えています。受注生産の品は、先に仕上がりを記録してください。';
    postAnswer = () => refused(409, { error: message, code: 'quantity_exceeds_ready' });
    render(<AdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: '発送済みにする' }));
    const dialog = await screen.findByRole('dialog', { name: '発送済みにする' });
    await within(dialog).findByLabelText('追跡番号');
    fireEvent.change(within(dialog).getByLabelText('追跡番号'), { target: { value: '1234-5678' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('dialog', { name: '発送済みにする' })).toBeInTheDocument();
    expect(listRequests()).toHaveLength(1);
  });

  it('発送: 「キャンセル」で閉じ、送らない。開き直すと既定（チェックは入っている）に戻る', async () => {
    render(<AdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: '発送済みにする' }));
    const dialog = await screen.findByRole('dialog', { name: '発送済みにする' });
    fireEvent.click(await within(dialog).findByRole('checkbox', { name: 'お客様に発送のメールを送る' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(postedBody('/fulfillments')).toBeUndefined();

    fireEvent.click(screen.getByRole('button', { name: '発送済みにする' }));
    expect(await screen.findByRole('checkbox', { name: 'お客様に発送のメールを送る' })).toBeChecked();
  });

  it('仕上がり: 「仕上がりを記録する」で仕上がりの画面を開き、記録すると画面を閉じ、知らせを出して一覧を読み直す', async () => {
    orderRows = [orderRow({
      status: '受注生産中', progressKey: 'in_production', items: [COAT_IN_PRODUCTION], canShip: true, canRecordCompletion: true,
    })];
    clientFetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const target = String(url);
      if (init?.method === 'POST') return postAnswer(target);
      if (target.startsWith('/api/admin/orders?')) {
        return ok({ data: orderRows, pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 } });
      }
      if (target.endsWith('/fulfillments')) return ok(materialsBody([COAT_LINE]));
      return ok({});
    });
    render(<AdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: '仕上がりを記録する' }));

    const dialog = await screen.findByRole('dialog', { name: '仕上がりを記録する' });
    const group = await within(dialog).findByRole('group', { name: 'ウールコート（黒 / L）' });
    fireEvent.change(within(group).getByLabelText('仕上がった数'), { target: { value: '1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '記録する' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(postedBody('/completions')).toEqual({
      requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
      lines: [{ orderItemId: COAT_ID, quantity: 1 }],
    });
    expect(await screen.findByText('仕上がりを記録しました。')).toBeInTheDocument();
    expect(listRequests()).toHaveLength(2);
  });

  it('一部だけ送った注文には「一部発送済み」の印と、0でない数だけの商品の欄を出す', async () => {
    orderRows = [orderRow({
      status: '受注生産中', progressKey: 'in_production', partiallyShipped: true, itemCount: '3点',
      items: [{ ...BLOUSE, quantity: 2, shipped: 2, readyUnshipped: 0 }, COAT_IN_PRODUCTION],
      canRecordCompletion: true,
    })];
    render(<AdminPage />);

    expect(await screen.findByText('一部発送済み')).toBeInTheDocument();
    expect(screen.getByText('シルクブラウス（白 / M）×2（発送済み 2）')).toBeInTheDocument();
    expect(screen.getByText('ウールコート（黒 / L）×1（受注生産中 1）')).toBeInTheDocument();
  });

  it('発送: 注文 A の返事を待つ間に注文 B の画面を開いても、A の返事で B の画面は閉じず、一覧は読み直す', async () => {
    orderRows = [orderRow(), orderRow({ id: OTHER_ORDER_ID })];
    const release = holdPost('/fulfillments');
    render(<AdminPage />);
    fireEvent.click((await screen.findAllByRole('button', { name: '発送済みにする' }))[0]);
    const dialogForA = await screen.findByRole('dialog', { name: '発送済みにする' });
    await within(dialogForA).findByRole('checkbox', { name: 'お客様に発送のメールを送る' });
    fireEvent.change(within(dialogForA).getByLabelText('追跡番号'), { target: { value: '1234-5678' } });
    fireEvent.click(within(dialogForA).getByRole('button', { name: '発送する' }));
    await waitFor(() => expect(clientFetchMock).toHaveBeenCalledWith(
      `/api/admin/orders/${ORDER_ID}/fulfillments`,
      expect.objectContaining({ method: 'POST' }),
    ));

    // 返事を待つ間に、注文 B の発送の画面を開く（A の画面の後ろの行のボタンなので hidden: true で探す）
    fireEvent.click(screen.getAllByRole('button', { name: '発送済みにする', hidden: true })[1]);
    await waitFor(() => expect(clientFetchMock).toHaveBeenCalledWith(
      `/api/admin/orders/${OTHER_ORDER_ID}/fulfillments`,
      { cache: 'no-store' },
    ));
    const dialogForB = await screen.findByRole('dialog', { name: '発送済みにする' });
    await within(dialogForB).findByRole('checkbox', { name: 'お客様に発送のメールを送る' });

    await release(ok({ fulfillmentId: 'fulfillment-1', number: 1, completesOrder: true, orderStatus: 'shipped', replayed: false }));

    await waitFor(() => expect(listRequests()).toHaveLength(2));
    expect(screen.getByRole('dialog', { name: '発送済みにする' })).toBeInTheDocument();
  });

  it('発送: 成功しても、一覧の知らせは出さない（言葉は、読み直した記録から出す）', async () => {
    postAnswer = () => {
      orderRows = [orderRow({
        status: '配送中', orderStatus: 'shipped', progressKey: 'in_transit', canShip: false,
        items: [{ ...BLOUSE, shipped: 1, readyUnshipped: 0 }],
      })];
      return ok({ fulfillmentId: 'fulfillment-1', number: 1, completesOrder: true, orderStatus: 'shipped', replayed: false });
    };
    render(<AdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: '発送済みにする' }));
    const dialog = await screen.findByRole('dialog', { name: '発送済みにする' });
    await within(dialog).findByRole('checkbox', { name: 'お客様に発送のメールを送る' });
    fireEvent.change(within(dialog).getByLabelText('追跡番号'), { target: { value: '1234-5678' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // 読み直した一覧が出てから確かめる（読み込み中は、知らせも出ない）
    expect(await screen.findByText('配送中', { selector: 'span' })).toBeInTheDocument();
    expect(screen.queryAllByRole('status')).toHaveLength(0);
  });

  // 発送・仕上がり・履歴の取消・要確認の確認は、窓口の返事を待ってから一覧を読み直す。返事を待つ間に絞り込みが変わっても、
  // 読み直しは、押した時点の（古い）条件ではなく、今の条件で頼む
  describe('返事を待つ間に絞り込みを変えても、返事の後の読み直しは今の絞り込みで頼む', () => {
    /** 絞り込みを「発送待ち」へ変える。窓口へは status=paid で頼むはず（画面の後ろのボタンなので hidden: true で探す） */
    async function changeFilterToAwaitingShipment() {
      fireEvent.click(screen.getByRole('button', { name: '発送待ち（受注生産中・発送準備中）', hidden: true }));
      await waitFor(() => expect(String(listRequests().at(-1)?.[0])).toContain('status=paid'));
    }

    /** 返事の後に一覧を読み直した（最初の表示・絞り込みの変更に続く3回目）こと。その頼みが、今の絞り込みであること */
    async function expectReloadedWithCurrentFilter() {
      await waitFor(() => expect(listRequests()).toHaveLength(3));
      expect(String(listRequests().at(-1)?.[0])).toContain('status=paid');
    }

    it('発送', async () => {
      const release = holdPost('/fulfillments');
      render(<AdminPage />);
      fireEvent.click(await screen.findByRole('button', { name: '発送済みにする' }));
      const dialog = await screen.findByRole('dialog', { name: '発送済みにする' });
      await within(dialog).findByRole('checkbox', { name: 'お客様に発送のメールを送る' });
      fireEvent.change(within(dialog).getByLabelText('追跡番号'), { target: { value: '1234-5678' } });
      fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));
      await waitFor(() => expect(postedBody('/fulfillments')).toBeDefined());

      await changeFilterToAwaitingShipment();
      await release(ok({ fulfillmentId: 'fulfillment-1', number: 1, completesOrder: true, orderStatus: 'shipped', replayed: false }));

      await expectReloadedWithCurrentFilter();
    });

    it('仕上がりの記録', async () => {
      orderRows = [orderRow({
        status: '受注生産中', progressKey: 'in_production', items: [COAT_IN_PRODUCTION], canShip: true, canRecordCompletion: true,
      })];
      serveOrdersApi({ lines: [COAT_LINE] });
      const release = holdPost('/completions');
      render(<AdminPage />);
      fireEvent.click(await screen.findByRole('button', { name: '仕上がりを記録する' }));
      const dialog = await screen.findByRole('dialog', { name: '仕上がりを記録する' });
      const group = await within(dialog).findByRole('group', { name: 'ウールコート（黒 / L）' });
      fireEvent.change(within(group).getByLabelText('仕上がった数'), { target: { value: '1' } });
      fireEvent.click(within(dialog).getByRole('button', { name: '記録する' }));
      await waitFor(() => expect(postedBody('/completions')).toBeDefined());

      await changeFilterToAwaitingShipment();
      await release(ok({ completionIds: ['completion-1'], replayed: false }));

      await expectReloadedWithCurrentFilter();
    });

    it('履歴の発送の取消', async () => {
      serveOrdersApi({ entries: [CANCELLABLE_SHIPMENT] });
      const release = holdPost('/cancel');
      render(<AdminPage />);
      fireEvent.click(await screen.findByRole('button', { name: 'ORD-A1B2C3D4 の履歴' }));
      fireEvent.click(await screen.findByRole('button', { name: 'この発送を取り消す' }));
      fireEvent.click(screen.getByRole('button', { name: '取り消す' }));
      await waitFor(() => expect(clientFetchMock).toHaveBeenCalledWith(
        `/api/admin/orders/${ORDER_ID}/fulfillments/${FULFILLMENT_ID}/cancel`,
        { method: 'POST' },
      ));

      await changeFilterToAwaitingShipment();
      await release(ok({ outcome: 'cancelled', orderStatus: 'paid' }));

      await expectReloadedWithCurrentFilter();
    });

    it('要確認の「確認済みにする」', async () => {
      mockAttention.mockImplementation(() => ok({ data: {
        exceptions: [],
        reviews: [{
          orderId: ORDER_ID, orderNumber: 'ORD-A1B2C3D4', orderStatus: 'paid', reviewReason: 'stock_not_reserved',
          reviewReasonLabel: '在庫を確保できませんでした', reviewMarkedAt: null,
        }],
        counts: { exceptions: 0, reviews: 1 },
      } }));
      const release = holdPost('/review');
      render(<AdminPage />);
      fireEvent.click(await screen.findByRole('button', { name: '確認済みにする' }));
      await waitFor(() => expect(clientFetchMock).toHaveBeenCalledWith(`/api/admin/orders/${ORDER_ID}/review`, { method: 'POST' }));

      await changeFilterToAwaitingShipment();
      await release(ok({}));

      await expectReloadedWithCurrentFilter();
    });
  });
});

describe('管理画面の絞り込み・件数・CSV', () => {
  beforeEach(() => {
    clientFetchMock.mockReset();
    mockAttention.mockReset();
    mockAttention.mockImplementation(() => ok({ data: { exceptions: [], reviews: [], counts: { exceptions: 0, reviews: 0 } } }));
    orderRows = [
      orderRow({ id: 'order-paid' }),
      orderRow({ id: 'order-pending', status: '未決済', orderStatus: 'pending', progressKey: 'unpaid', canShip: false }),
      orderRow({ id: 'order-shipped', status: '配送中', orderStatus: 'shipped', progressKey: 'in_transit', canShip: false }),
    ];
    clientFetchMock.mockImplementation((url: string) => {
      if (String(url).startsWith('/api/admin/orders?')) {
        return ok({ data: orderRows, pagination: { page: 1, pageSize: 20, total: orderRows.length, totalPages: 1 } });
      }
      return ok({});
    });
  });

  it('絞り込みは決まった名前で並ぶ', async () => {
    render(<AdminPage />);
    await screen.findByText('order-paid');

    for (const label of [
      'すべて',
      '支払い手続き中',
      '未決済',
      '発送待ち（受注生産中・発送準備中）',
      '発送済み（配送中・配達済み）',
      '決済失敗',
      '放棄',
      'キャンセル',
    ]) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: '決済完了' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '発送済み' })).not.toBeInTheDocument();
  });

  it.each([
    ['支払い手続き中', 'payment_in_progress'],
    ['未決済', 'pending'],
    ['発送待ち（受注生産中・発送準備中）', 'paid'],
    ['発送済み（配送中・配達済み）', 'shipped'],
    ['決済失敗', 'failed'],
    ['放棄', 'abandoned'],
    ['キャンセル', 'cancelled'],
  ])('絞り込み「%s」を選ぶと、DB の状態 status=%s で窓口へ頼む', async (label, status) => {
    render(<AdminPage />);
    await screen.findByText('order-paid');
    fireEvent.click(screen.getByRole('button', { name: label }));

    await waitFor(() => expect(String(listRequests().at(-1)?.[0])).toContain(`status=${status}`));
  });

  it('2つ選んだ時は status を送らず、DB の状態（orderStatus）で手元の一覧を絞る', async () => {
    render(<AdminPage />);
    await screen.findByText('order-paid');
    fireEvent.click(screen.getByRole('button', { name: '発送待ち（受注生産中・発送準備中）' }));
    await waitFor(() => expect(String(listRequests().at(-1)?.[0])).toContain('status=paid'));
    fireEvent.click(screen.getByRole('button', { name: '未決済' }));

    await waitFor(() => expect(String(listRequests().at(-1)?.[0])).not.toContain('status='));
    await waitFor(() => expect(screen.queryByText('order-shipped')).not.toBeInTheDocument());
    expect(screen.getByText('order-paid')).toBeInTheDocument();
    expect(screen.getByText('order-pending')).toBeInTheDocument();
    expect(screen.getByText(/（表示 2件）/)).toBeInTheDocument();
  });

  it('件数の表示は「未決済」と「発送待ち」。言葉ではなく DB の状態（orderStatus）で数える', async () => {
    orderRows = [
      ...orderRows,
      orderRow({ id: 'order-production', status: '受注生産中', progressKey: 'in_production', items: [COAT_IN_PRODUCTION], canRecordCompletion: true }),
    ];
    render(<AdminPage />);
    await screen.findByText('order-paid');

    expect(screen.getByText('未決済: 1')).toBeInTheDocument();
    // 発送準備中も受注生産中も、DB の状態は決済完了（paid）なので、どちらも発送待ちに数える
    expect(screen.getByText('発送待ち: 2')).toBeInTheDocument();
    expect(screen.queryByText(/決済完了:/)).not.toBeInTheDocument();
  });

  // 絞り込みを続けて変えると、一覧の読みが重なる。使うのは、最後に始めた読みの答えだけ
  describe('一覧の読みが重なった時', () => {
    const list = () => ({
      data: orderRows,
      pagination: { page: 1, pageSize: 20, total: orderRows.length, totalPages: 1 },
    });
    /** 古い条件（放棄）の答え。1件だけ返る */
    const abandonedAnswer = () => ok({
      data: [orderRow({ id: 'order-abandoned', status: '放棄', orderStatus: 'abandoned', progressKey: 'abandoned', canShip: false })],
      pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
    });

    it('遅れて返った古い条件の答えは、新しい条件の一覧・件数を上書きしない', async () => {
      const abandoned = hold();
      clientFetchMock.mockImplementation((url: string) => {
        if (String(url).includes('status=abandoned')) return abandoned.held;
        if (String(url).startsWith('/api/admin/orders?')) return ok(list());
        return ok({});
      });
      render(<AdminPage />);
      await screen.findByText('order-paid');

      // 「放棄」を選ぶ（窓口の返事は遅れる）→ すぐ「すべて」へ戻す（こちらはすぐ返る）
      fireEvent.click(screen.getByRole('button', { name: '放棄' }));
      await waitFor(() => expect(String(listRequests().at(-1)?.[0])).toContain('status=abandoned'));
      fireEvent.click(screen.getByRole('button', { name: 'すべて' }));
      await waitFor(() => expect(listRequests()).toHaveLength(3));
      expect(await screen.findByText('order-paid')).toBeInTheDocument();

      // 古い条件（放棄）の答えが、あとから返る
      await abandoned.release(abandonedAnswer());

      expect(screen.queryByText('order-abandoned')).not.toBeInTheDocument();
      expect(screen.getByText('order-paid')).toBeInTheDocument();
      expect(screen.getByText(/3件（表示 3件）/)).toBeInTheDocument();
    });

    it('古い条件の答えが先に返っても、新しい条件の答えが返るまで、読み込み中の表示を消さない', async () => {
      const abandoned = hold();
      const latest = hold();
      let readsWithoutStatus = 0;
      clientFetchMock.mockImplementation((url: string) => {
        if (String(url).includes('status=abandoned')) return abandoned.held;
        if (String(url).startsWith('/api/admin/orders?')) {
          // 1回目（最初の表示）はすぐ返し、2回目（「すべて」へ戻した読み）は止めておく
          readsWithoutStatus += 1;
          return readsWithoutStatus === 1 ? ok(list()) : latest.held;
        }
        return ok({});
      });
      render(<AdminPage />);
      await screen.findByText('order-paid');
      fireEvent.click(screen.getByRole('button', { name: '放棄' }));
      await waitFor(() => expect(String(listRequests().at(-1)?.[0])).toContain('status=abandoned'));
      fireEvent.click(screen.getByRole('button', { name: 'すべて' }));
      await waitFor(() => expect(listRequests()).toHaveLength(3));
      expect(screen.getByText('注文一覧を読み込み中です...')).toBeInTheDocument();

      // 古い条件の答えが先に返っても、新しい読みの途中なので読み込み中のまま。古い答えは出さない
      await abandoned.release(abandonedAnswer());
      expect(screen.getByText('注文一覧を読み込み中です...')).toBeInTheDocument();
      expect(screen.queryByText('order-abandoned')).not.toBeInTheDocument();

      // 新しい条件の答えが返ると、一覧が出て、読み込み中の表示が消える
      await latest.release(ok(list()));
      expect(await screen.findByText('order-paid')).toBeInTheDocument();
      expect(screen.queryByText('注文一覧を読み込み中です...')).not.toBeInTheDocument();
    });
  });

  describe('CSV', () => {
    const originalCreateObjectURL = window.URL.createObjectURL;
    const originalRevokeObjectURL = window.URL.revokeObjectURL;

    afterEach(() => {
      window.URL.createObjectURL = originalCreateObjectURL;
      window.URL.revokeObjectURL = originalRevokeObjectURL;
      jest.restoreAllMocks();
    });

    function readBlob(blob: Blob): Promise<string> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(blob);
      });
    }

    it('発送待ち（DB の状態が決済完了）の注文だけを書き出し、商品の欄は発送準備中の数にする', async () => {
      orderRows = [
        orderRow({
          id: 'order-paid',
          status: '受注生産中',
          progressKey: 'in_production',
          items: [{ ...BLOUSE, quantity: 3, shipped: 1, readyUnshipped: 2 }, COAT_IN_PRODUCTION],
        }),
        orderRow({ id: 'order-pending', status: '未決済', orderStatus: 'pending', progressKey: 'unpaid', canShip: false }),
        orderRow({ id: 'order-shipped', status: '配送中', orderStatus: 'shipped', progressKey: 'in_transit', canShip: false }),
      ];
      const createObjectURL = jest.fn<string, [Blob]>(() => 'blob:orders');
      window.URL.createObjectURL = createObjectURL;
      window.URL.revokeObjectURL = jest.fn();
      jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
      render(<AdminPage />);
      await screen.findByText('order-paid');
      fireEvent.click(screen.getByRole('button', { name: '表示中の注文をCSV出力' }));

      const csv = await readBlob(createObjectURL.mock.calls[0][0]);
      expect(csv).toContain('"order-paid"');
      expect(csv).not.toContain('order-pending');
      expect(csv).not.toContain('order-shipped');
      // 送った品（1つ）と、まだ作っている品（コート）は詰めない
      expect(csv).toContain('"シルクブラウス x2"');
      expect(csv).not.toContain('ウールコート');
      expect(csv).toContain('"受注生産中"');
    });
  });
});
