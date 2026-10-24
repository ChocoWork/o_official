import { render, screen, within, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ItemStockSection } from '@/app/admin/item/ItemStockSection';
import { clientFetch } from '@/lib/client-fetch';

jest.mock('@/lib/client-fetch', () => ({ clientFetch: jest.fn() }));

const mockedFetch = clientFetch as jest.MockedFunction<typeof clientFetch>;

const EXPLANATION =
  'すぐ出せる数は今すぐ売れる数、引き当て済みは注文のために取ってある数、手元の数は棚に実際にある数、受注生産はこれから作る数。';

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function screenTime(iso: string): string {
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

const VARIANT = {
  id: 11,
  colorName: 'BLACK',
  colorHex: '#000000',
  sizeLabel: 'M',
  sku: null,
  stockQuantity: 4,
  isActive: true,
  committedQuantity: 3,
  onHandQuantity: 7,
  backorderQuantity: 2,
};

// 注文で1点売れた行（記録した人は無い）
const PURCHASE = {
  id: 9,
  variantId: 11,
  delta: -1,
  reason: 'purchase',
  note: null,
  createdAt: '2026-09-22T01:30:00.000Z',
  actorEmail: null,
  orderId: 'a1b2c3d4-1111-4222-8333-444455556666',
  orderNumber: 'ORD-A1B2C3D4',
  balanceAfter: 4,
};

// 管理者が4点入荷した行（注文は無い）
const RESTOCK = {
  id: 5,
  variantId: 11,
  delta: 4,
  reason: 'restock',
  note: '初回入荷',
  createdAt: '2026-09-21T01:00:00.000Z',
  actorEmail: 'admin@example.com',
  orderId: null,
  orderNumber: null,
  balanceAfter: 5,
};

async function renderLoaded(options: { variants?: unknown[]; movements?: unknown[]; allocationEvents?: unknown[] } = {}) {
  mockedFetch.mockResolvedValue(
    json({
      variants: options.variants ?? [VARIANT],
      movements: options.movements ?? [PURCHASE, RESTOCK],
      allocationEvents: options.allocationEvents ?? [],
    }),
  );
  render(<ItemStockSection itemId="7" />);
  await screen.findByRole('heading', { name: '履歴' });
}

describe('ItemStockSection の4つの数と履歴（グループ E-1）', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it('色・サイズごとに、すぐ出せる数・引き当て済み・手元の数・受注生産の4つを出す', async () => {
    await renderLoaded();

    expect(mockedFetch).toHaveBeenCalledWith('/api/admin/items/7/variants');
    const row = screen.getByTestId('variant-row-11');
    expect(within(row).getByText('すぐ出せる数')).toBeInTheDocument();
    expect(within(row).getByText('引き当て済み')).toBeInTheDocument();
    expect(within(row).getByText('手元の数')).toBeInTheDocument();
    expect(within(row).getByText('受注生産')).toBeInTheDocument();
    expect(within(row).getByTestId('variant-stock')).toHaveTextContent(/^4$/);
    expect(within(row).getByTestId('variant-committed')).toHaveTextContent(/^3$/);
    expect(within(row).getByTestId('variant-on-hand')).toHaveTextContent(/^7$/);
    expect(within(row).getByTestId('variant-backorder')).toHaveTextContent(/^2$/);
  });

  it('4つの言葉の説明を、色・サイズが複数あっても画面に1回だけ書く', async () => {
    await renderLoaded({ variants: [VARIANT, { ...VARIANT, id: 12, sizeLabel: 'L' }] });

    expect(screen.getAllByText(EXPLANATION)).toHaveLength(1);
    expect(screen.getByTestId('stock-terms-explanation')).toHaveTextContent(EXPLANATION);
  });

  it('履歴は日時・色とサイズ・理由・増減・変わった後の数・記録した人・注文番号・備考を出す', async () => {
    await renderLoaded();

    const rows = screen.getAllByTestId('stock-movement-row');
    expect(rows).toHaveLength(2);
    const [purchase, restock] = rows;

    expect(within(purchase).getByTestId('stock-movement-time')).toHaveTextContent(screenTime(PURCHASE.createdAt));
    expect(within(purchase).getByTestId('stock-movement-variant')).toHaveTextContent('BLACK / M');
    expect(within(purchase).getByTestId('stock-movement-reason')).toHaveTextContent('注文への確保');
    expect(within(purchase).getByTestId('stock-movement-delta')).toHaveTextContent(/^-1$/);
    expect(within(purchase).getByTestId('stock-movement-balance')).toHaveTextContent('変わった後 4');
    expect(within(purchase).getByTestId('stock-movement-order')).toHaveTextContent('ORD-A1B2C3D4');

    expect(within(restock).getByTestId('stock-movement-time')).toHaveTextContent(screenTime(RESTOCK.createdAt));
    expect(within(restock).getByTestId('stock-movement-reason')).toHaveTextContent('入荷');
    expect(within(restock).getByTestId('stock-movement-delta')).toHaveTextContent(/^\+4$/);
    expect(within(restock).getByTestId('stock-movement-balance')).toHaveTextContent('変わった後 5');
    expect(within(restock).getByTestId('stock-movement-actor')).toHaveTextContent('admin@example.com');
    expect(within(restock).getByTestId('stock-movement-note')).toHaveTextContent('初回入荷');
  });

  it('記録した人が空の行は「自動」と出し、注文の無い行には注文番号を出さない', async () => {
    await renderLoaded();

    const [purchase, restock] = screen.getAllByTestId('stock-movement-row');
    expect(within(purchase).getByTestId('stock-movement-actor')).toHaveTextContent(/^自動処理$/);
    expect(within(restock).queryByTestId('stock-movement-order')).not.toBeInTheDocument();
  });

  it('履歴が空なら案内を出す', async () => {
    await renderLoaded({ movements: [] });

    expect(screen.getByText('まだ記録がありません。')).toBeInTheDocument();
    expect(screen.queryAllByTestId('stock-movement-row')).toHaveLength(0);
  });
});

describe('ItemStockSection の止めた組み合わせ（FREQ-517）', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  // 商品から外した色・サイズの組み合わせは隠さず、「止めた」と分かるように出す（在庫が残っていると合計を見誤るため）
  it('止めた組み合わせの行には「止めた」を出し、有効な行には出さない', async () => {
    await renderLoaded({ variants: [VARIANT, { ...VARIANT, id: 12, colorName: 'IVORY', isActive: false }] });

    expect(within(screen.getByTestId('variant-row-12')).getByText('止めた')).toBeInTheDocument();
    expect(within(screen.getByTestId('variant-row-11')).queryByText('止めた')).not.toBeInTheDocument();
    // 止めた行も在庫の数はそのまま出す
    expect(within(screen.getByTestId('variant-row-12')).getByTestId('variant-stock')).toHaveTextContent(/^4$/);
  });
});

describe('ItemStockSection の返金で動いた履歴の行（グループ E-2）', () => {
  const REFUND_ID = 'e1e1e1e1-1111-4222-8333-444455556666';

  beforeEach(() => {
    mockedFetch.mockReset();
  });

  // 返金の番号（refundId）が付いた行だけ、同じ理由でも言葉を変える。
  // 棚卸調整は「在庫に戻さない」を選んだ返金が手元の数を減らした行、販売は返金の失敗で確保し直した行
  it.each<[string, string | null, string]>([
    ['refund', REFUND_ID, '返金'],
    ['adjustment', REFUND_ID, '棚卸調整（返金で在庫に戻さない）'],
    ['purchase', REFUND_ID, '注文への確保（返金の失敗で再割当）'],
    ['adjustment', null, '棚卸調整'],
    ['purchase', null, '注文への確保'],
  ])('理由 %s・返金の番号 %s の行は「%s」と出す', async (reason, refundId, label) => {
    await renderLoaded({ movements: [{ ...PURCHASE, reason, refundId }] });

    expect(screen.getByTestId('stock-movement-reason').textContent).toBe(label);
  });
});

describe('ItemStockSection の返品で動いた履歴の行（グループ E-3）', () => {
  const RETURN_ID = 'f1f1f1f1-1111-4222-8333-444455556666';
  const RETURN_NUMBER = 'ORD-A1B2C3D4-R1';

  beforeEach(() => {
    mockedFetch.mockReset();
  });

  // 返品の受け取りで在庫に戻した行（+n）と、交換の品を在庫から確保した行（−n）は、注文の処理が書く理由で、返品の番号が付く。
  // 言葉は理由で決め、注文の番号の欄には注文番号の代わりに返品の番号を出す（uuid は出さない）
  it.each<[string, number, string]>([
    ['return', 1, '返品の受け取り'],
    ['exchange', -1, '交換品への確保'],
  ])('理由 %s の行（増減 %i）は「%s」と出し、注文の番号の欄には返品の番号を出す（uuid は出さない）', async (reason, delta, label) => {
    await renderLoaded({ movements: [{ ...PURCHASE, reason, delta, returnId: RETURN_ID, returnNumber: RETURN_NUMBER }] });

    const row = screen.getByTestId('stock-movement-row');
    expect(within(row).getByTestId('stock-movement-reason').textContent).toBe(label);
    expect(within(row).getByTestId('stock-movement-order').textContent).toBe(RETURN_NUMBER);
    expect(row).not.toHaveTextContent(RETURN_ID);
  });

  it('返品に結び付かない行（返品の番号が null）は、これまでどおり注文番号を出す', async () => {
    await renderLoaded({ movements: [{ ...PURCHASE, returnId: null, returnNumber: null }] });

    const row = screen.getByTestId('stock-movement-row');
    expect(within(row).getByTestId('stock-movement-order').textContent).toBe('ORD-A1B2C3D4');
  });
});

describe('ItemStockSection の読み込みの失敗（店主は英語が読めない）', () => {
  const LOAD_ERROR = /^在庫の取得に失敗しました。$/;
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    mockedFetch.mockReset();
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it('窓口が 500 を返したら、窓口の英語の文ではなく日本語の固定の文を出し、履歴の空の案内は出さない', async () => {
    mockedFetch.mockResolvedValue(json({ error: 'Failed to fetch variant stock states' }, 500));
    render(<ItemStockSection itemId="7" />);

    expect(await screen.findByRole('alert')).toHaveTextContent(LOAD_ERROR);
    expect(screen.queryByText('Failed to fetch variant stock states')).not.toBeInTheDocument();
    expect(screen.queryByText('まだ記録がありません。')).not.toBeInTheDocument();
  });

  it('通信が切れた時も、同じ日本語の固定の文を出し、履歴の空の案内は出さない', async () => {
    mockedFetch.mockRejectedValue(new Error('network down'));
    render(<ItemStockSection itemId="7" />);

    expect(await screen.findByRole('alert')).toHaveTextContent(LOAD_ERROR);
    expect(screen.queryByText('まだ記録がありません。')).not.toBeInTheDocument();
  });

  it('在庫を記録した直後の読み直しに失敗したら、同じ日本語の固定の文を出す（古い数のまま黙らない）', async () => {
    mockedFetch.mockResolvedValue(json({ variants: [VARIANT], movements: [PURCHASE, RESTOCK] }));
    render(<ItemStockSection itemId="7" />);
    await screen.findByRole('heading', { name: '履歴' });
    mockedFetch
      .mockResolvedValueOnce(json({ success: true }, 201))
      .mockResolvedValueOnce(json({ error: 'Failed to fetch stock history' }, 500));

    await userEvent.type(screen.getByTestId('variant-delta'), '3');
    await userEvent.click(screen.getByTestId('variant-submit'));

    expect(await screen.findByRole('alert')).toHaveTextContent(LOAD_ERROR);
    expect(screen.queryByText('Failed to fetch stock history')).not.toBeInTheDocument();
    // 記録の POST のあとに、読み直しの GET が1回
    expect(mockedFetch).toHaveBeenCalledTimes(3);
    expect(mockedFetch).toHaveBeenNthCalledWith(2, '/api/admin/items/7/variants', expect.objectContaining({ method: 'POST' }));
    expect(mockedFetch).toHaveBeenNthCalledWith(3, '/api/admin/items/7/variants');
  });
});

// 在庫の窓口は G-2 から admin.stock.read / admin.stock.manage を要る。権限が無い時は窓口の英語（Forbidden）ではなく、日本語の固定の文を出す
describe('ItemStockSection の権限が無い時（FREQ-540-AC-06）', () => {
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    mockedFetch.mockReset();
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it('FREQ-540-AC-06: 読み込みが 403 なら「在庫を見る権限がありません。」を role=alert で出し、Forbidden も取得失敗の文も出さない', async () => {
    mockedFetch.mockResolvedValue(json({ error: 'Forbidden', permission: 'admin.stock.read', role: 'admin' }, 403));
    render(<ItemStockSection itemId="7" />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/^在庫を見る権限がありません。$/);
    expect(screen.queryByText(/Forbidden/)).not.toBeInTheDocument();
    expect(screen.queryByText('在庫の取得に失敗しました。')).not.toBeInTheDocument();
    expect(screen.queryByText('まだ記録がありません。')).not.toBeInTheDocument();
  });

  it('FREQ-540-AC-06: 記録が 403 なら「在庫を変更する権限がありません。」を role=alert で出し、Forbidden も一般の失敗の文も出さない', async () => {
    mockedFetch.mockResolvedValue(json({ variants: [VARIANT], movements: [PURCHASE, RESTOCK] }));
    render(<ItemStockSection itemId="7" />);
    await screen.findByRole('heading', { name: '履歴' });
    mockedFetch.mockResolvedValueOnce(json({ error: 'Forbidden', permission: 'admin.stock.manage', role: 'admin' }, 403));

    await userEvent.type(screen.getByTestId('variant-delta'), '3');
    await userEvent.click(screen.getByTestId('variant-submit'));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/^在庫を変更する権限がありません。$/);
    expect(screen.queryByText(/Forbidden/)).not.toBeInTheDocument();
    expect(screen.queryByText('在庫の記録に失敗しました')).not.toBeInTheDocument();
    // 記録の POST だけ。権限が無いのに読み直さない
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it('DB の関数が権限で断った時（本文が日本語の 403）も、同じ固定の文を出す', async () => {
    mockedFetch.mockResolvedValue(json({ variants: [VARIANT], movements: [PURCHASE, RESTOCK] }));
    render(<ItemStockSection itemId="7" />);
    await screen.findByRole('heading', { name: '履歴' });
    mockedFetch.mockResolvedValueOnce(json({ code: 'GROUP_G_FORBIDDEN', error: '在庫を変更する権限がありません。' }, 403));

    await userEvent.type(screen.getByTestId('variant-delta'), '3');
    await userEvent.click(screen.getByTestId('variant-submit'));

    expect(await screen.findByRole('alert')).toHaveTextContent(/^在庫を変更する権限がありません。$/);
  });

  it('403 以外の失敗は、これまでの文のまま（読み込みは取得失敗、記録は窓口の日本語の文）', async () => {
    mockedFetch.mockResolvedValue(json({ error: 'x' }, 500));
    const { unmount } = render(<ItemStockSection itemId="7" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/^在庫の取得に失敗しました。$/);
    unmount();

    mockedFetch.mockReset();
    mockedFetch.mockResolvedValue(json({ variants: [VARIANT], movements: [PURCHASE, RESTOCK] }));
    render(<ItemStockSection itemId="7" />);
    await screen.findByRole('heading', { name: '履歴' });
    mockedFetch.mockResolvedValueOnce(json({ error: '在庫の記録に失敗しました' }, 500));
    await userEvent.type(screen.getByTestId('variant-delta'), '3');
    await userEvent.click(screen.getByTestId('variant-submit'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/^在庫の記録に失敗しました$/);
  });
});

describe('G-1 stock confirmation and allocation history', () => {
  beforeEach(() => mockedFetch.mockReset());
  const confirmation = (n: number) => json({ code: 'GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED',
    error: '割り当て済みの品を外す必要があります。数量を確認してください。', releasedQuantity: n }, 409);
  const posts = () => mockedFetch.mock.calls.filter(([, init]) => init?.method === 'POST')
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
  async function reduce() {
    await renderLoaded();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '理由' }), 'adjustment');
    await userEvent.type(screen.getByRole('spinbutton', { name: '増減' }), '-5');
    mockedFetch.mockResolvedValueOnce(confirmation(2));
    await userEvent.click(screen.getByRole('button', { name: '記録する' }));
    return await screen.findByRole('dialog', { name: '在庫を減らす' });
  }
  it('requires a reason, uses a new key after confirmation, and reconfirms a changed count', async () => {
    let dialog = await reduce();
    expect(posts()).toHaveLength(1);
    expect(posts()[0].requestKey).toMatch(/^[0-9a-f-]{36}$/i);
    expect(within(dialog).getByText('割り当て済みの品を2点外し、受注生産中に戻します。')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: '在庫を減らす' }));
    expect(screen.getByRole('alert')).toHaveTextContent('割り当てを外す理由を入力してください。');
    expect(posts()).toHaveLength(1);
    await userEvent.type(within(dialog).getByRole('textbox', { name: '割り当てを外す理由' }), '棚卸差異');
    mockedFetch.mockResolvedValueOnce(confirmation(3));
    await userEvent.click(within(dialog).getByRole('button', { name: '在庫を減らす' }));
    dialog = await screen.findByRole('dialog', { name: '在庫を減らす' });
    expect(within(dialog).getByText('割り当て済みの品を3点外し、受注生産中に戻します。')).toBeInTheDocument();
    expect(posts()[1]).toMatchObject({ expectedReleaseQuantity: 2, note: '棚卸差異' });
    expect(posts()[1].requestKey).not.toBe(posts()[0].requestKey);
    mockedFetch.mockResolvedValueOnce(json({ success: true }, 201));
    await userEvent.click(within(dialog).getByRole('button', { name: '在庫を減らす' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(posts()[2]).toMatchObject({ expectedReleaseQuantity: 3, note: '棚卸差異' });
    expect(posts()[2].requestKey).not.toBe(posts()[1].requestKey);
  });
  it('keeps an in-flight dialog open, blocks duplicates, and retries identical confirmed input with the same key', async () => {
    const dialog = await reduce();
    await userEvent.type(within(dialog).getByRole('textbox', { name: '割り当てを外す理由' }), '棚卸差異');
    let reject: (error: Error) => void = () => {};
    mockedFetch.mockImplementationOnce(() => new Promise<Response>((_resolve, rejectPromise) => { reject = rejectPromise; }));
    await userEvent.click(within(dialog).getByRole('button', { name: '在庫を減らす' }));
    await userEvent.keyboard('{Escape}');
    await userEvent.click(within(dialog).getByRole('button', { name: '戻る' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '在庫を減らす' })).toBeDisabled();
    expect(posts()).toHaveLength(2);
    await act(async () => reject(new Error('network')));
    mockedFetch.mockResolvedValueOnce(json({ success: true }, 201));
    await userEvent.click(within(dialog).getByRole('button', { name: '在庫を減らす' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(posts()[2]).toEqual(posts()[1]);
  });
  it('cancels confirmation without sending another request', async () => {
    const dialog = await reduce();
    await userEvent.click(within(dialog).getByRole('button', { name: '戻る' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(posts()).toHaveLength(1);
  });
  it('retries an uncertain initial send with the same key and body', async () => {
    await renderLoaded();
    await userEvent.type(screen.getByRole('spinbutton', { name: '増減' }), '3');
    mockedFetch.mockRejectedValueOnce(new Error('network'));
    await userEvent.click(screen.getByRole('button', { name: '記録する' }));
    await screen.findByRole('alert');
    mockedFetch.mockResolvedValueOnce(json({ success: true }, 201));
    await userEvent.click(screen.getByRole('button', { name: '記録する' }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1]).toEqual(posts()[0]);
  });
  it('retains an uncertain request for each variant while another variant is recorded', async () => {
    await renderLoaded({ variants: [VARIANT,{ ...VARIANT,id:12 }] });
    const first = within(screen.getByTestId('variant-row-11'));
    const second = within(screen.getByTestId('variant-row-12'));
    await userEvent.type(first.getByRole('spinbutton',{ name: '増減' }),'3');
    mockedFetch.mockRejectedValueOnce(new Error('network'));
    await userEvent.click(first.getByRole('button',{ name: '記録する' }));
    await screen.findByRole('alert');
    await userEvent.type(second.getByRole('spinbutton',{ name: '増減' }),'1');
    mockedFetch.mockResolvedValueOnce(json({ success:true },201));
    await userEvent.click(second.getByRole('button',{ name: '記録する' }));
    await waitFor(() => expect(first.getByRole('button',{ name: '記録する' })).toBeEnabled());
    mockedFetch.mockResolvedValueOnce(json({ success:true },201));
    await userEvent.click(first.getByRole('button',{ name: '記録する' }));
    await waitFor(() => expect(posts()).toHaveLength(3));
    expect(posts()[2]).toEqual(posts()[0]);
  });
  it('links movement events once and displays promote separately with no free-stock delta or balance', async () => {
    const base = { allocationId: 'allocation', orderId: PURCHASE.orderId, orderItemId: 'line', variantId: 11,
      quantity: 2, operationId: 'operation', counterpartAllocationId: null, reversesEventId: null, reason: null,
      actorId: null, createdAt: '2026-10-24T00:00:00Z' };
    await renderLoaded({ allocationEvents: [{ ...base, id: 'linked', type: 'allocate', stockMovementId: String(PURCHASE.id) },
      { ...base, id: 'promote', type: 'promote', stockMovementId: null }] });
    expect(screen.getAllByTestId('stock-movement-row')).toHaveLength(2);
    expect(screen.queryByTestId('allocation-event-linked')).not.toBeInTheDocument();
    const row = screen.getByTestId('allocation-event-promote');
    expect(row).toHaveTextContent('入金による割当への切替');
    expect(row).toHaveTextContent('割当 2点');
    expect(row).toHaveTextContent('ORD-A1B2C3D4');
    expect(row).toHaveTextContent('自動処理');
    expect(within(row).getByTestId('allocation-event-delta')).toHaveTextContent(/^—$/);
    expect(within(row).getByTestId('allocation-event-balance')).toHaveTextContent(/^—$/);
    expect(screen.queryByText('まだ記録がありません。')).not.toBeInTheDocument();
  });
  it.each([
    ['hold','支払い前の仮確保'], ['allocate','注文への割当'], ['release','割当の解放'],
    ['consume','発送による割当の消費'], ['restore','発送取消による割当の復元'], ['transfer','割当の入替'],
  ])('displays the exact allocation label for %s', async (type,label) => {
    await renderLoaded({ movements:[],allocationEvents:[{ id:'standalone',allocationId:'allocation',orderId:PURCHASE.orderId,
      orderItemId:'line',variantId:11,type,quantity:1,operationId:'operation',counterpartAllocationId:null,
      reversesEventId:null,stockMovementId:null,reason:null,actorId:null,createdAt:PURCHASE.createdAt }] });
    const row = screen.getByTestId('allocation-event-standalone');
    expect(row).toHaveTextContent(label);
    expect(row).toHaveTextContent('割当 1点');
    expect(screen.queryByText('まだ記録がありません。')).not.toBeInTheDocument();
  });
  it.each([
    ['fifo', '古い注文から順の自動割当'], ['checkout', '注文の受付'], ['stripe_checkout_expired', '決済画面の期限切れ'],
    ['stripe_voucher_expired', '支払い期限切れ'], ['admin_cancel', '管理者による取消'],
    ['admin_cancel_failed_order', '管理者による取消'], ['unknown_internal_reason', 'システム'], ['toString', 'システム'],
  ])('shows the allocation reason %s only through its Japanese label', async (reason, label) => {
    await renderLoaded({ movements:[],allocationEvents:[{ id:'standalone',allocationId:'allocation',orderId:PURCHASE.orderId,
      orderItemId:'line',variantId:11,type:'consume',quantity:1,operationId:'operation',counterpartAllocationId:null,
      reversesEventId:null,stockMovementId:null,reason,actorId:null,createdAt:PURCHASE.createdAt }] });
    const row = screen.getByTestId('allocation-event-standalone');
    expect(within(row).getByTestId('allocation-event-reason')).toHaveTextContent(new RegExp(`^${label}$`));
    expect(row).not.toHaveTextContent(reason);
  });
});
