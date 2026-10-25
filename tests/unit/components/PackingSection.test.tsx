import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import PackingSection from '@/components/PackingSection';
import { formatYen } from '@/lib/orders/refund/refund-messages';
import {
  ITEM_ID_2,
  ORDER_ID,
  ORDER_ID_2,
  packingRow,
  SLIP_ID,
  SLIP_ID_2,
  slipListRow,
} from '../lib/orders/shipment-slips/shipment-slip-fixtures';

/**
 * 荷作り表（G-3 / FREQ-531）の画面。この段階は読むだけで、品物を選ぶ欄と「発送」は出さない（次の段階で足す）。
 * 窓口（clientFetch）と注文の履歴のダイアログだけを差し替える。
 */
const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));
const mockHistoryDialog = jest.fn();
jest.mock('@/components/OrderHistoryDialog', () => ({
  __esModule: true,
  default: (props: unknown) => {
    mockHistoryDialog(props);
    return null;
  },
}));

const EMPTY = { rows: [], total: 0, page: 1, limit: 50 };

function respond(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

type Handlers = {
  packing?: (url: string) => Response | Promise<Response>;
  slips?: (stage: string) => Response | Promise<Response>;
};

/** 荷作り表と発送票の一覧の窓口を、URL で振り分けて答える */
function serve({ packing, slips }: Handlers = {}) {
  mockClientFetch.mockImplementation(async (url: string) => {
    const target = String(url);
    if (target.startsWith('/api/admin/packing')) {
      return packing ? packing(target) : respond(200, { ...EMPTY, rows: [packingRow()], total: 1 });
    }
    const stage = new URL(target, 'https://example.test').searchParams.get('stage') ?? '';
    return slips ? slips(stage) : respond(200, { rows: [], total: 0, page: 1, limit: 20 });
  });
}

const packingCalls = () => mockClientFetch.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith('/api/admin/packing'));
const slipCalls = () => mockClientFetch.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith('/api/admin/shipment-slips'));

function packingTable(): HTMLElement {
  return screen.getAllByRole('table')[0];
}

/** 見出しの節の中の表 */
function sectionTable(heading: string): HTMLElement {
  return within(screen.getByRole('heading', { level: 2, name: heading }).closest('section') as HTMLElement).getByRole('table');
}

beforeEach(() => {
  mockClientFetch.mockReset();
  mockHistoryDialog.mockReset();
});

describe('荷作り表: 発送準備中の品物の表', () => {
  test('FREQ-531-AC-01: 見出しと説明を出し、窓口を既定の50件・1頁目で1回読む。読み込み中は status を出す', async () => {
    serve();
    render(<PackingSection />);

    expect(screen.getByRole('heading', { level: 1, name: '荷作り表' })).toBeInTheDocument();
    expect(screen.getByText('発送準備中の品物だけを表示します。品物を選んで「発送」を押すと、発送票の下書きを作ります。')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('読み込み中');
    await screen.findAllByTestId('packing-row');
    expect(packingCalls()).toEqual(['/api/admin/packing?limit=50&page=1']);
    expect(mockClientFetch).toHaveBeenCalledWith('/api/admin/packing?limit=50&page=1', { cache: 'no-store' });
    expect(screen.getByRole('link', { name: '管理画面に戻る' })).toHaveAttribute('href', '/admin?tab=PACKING');
  });

  test('FREQ-531-AC-01: 列は左から 注文ID・注文日・顧客名・メールアドレス・商品名・色・サイズ・数量・単価 の9つ。選択の列は出さない', async () => {
    serve();
    render(<PackingSection />);
    await screen.findAllByTestId('packing-row');

    const headings = within(packingTable()).getAllByRole('columnheader').map((cell) => cell.textContent);
    expect(headings).toEqual(['注文ID', '注文日', '顧客名', 'メールアドレス', '商品名', '色', 'サイズ', '数量', '単価']);
  });

  test('FREQ-531-AC-01: 1行は 注文番号・注文日（日本時間）・顧客名・メール・商品名・色・サイズ・準備中の数・単価 を左の列から順に出す', async () => {
    serve({ packing: () => respond(200, { rows: [packingRow({ orderCreatedAt: '2026-10-19T16:00:00+00:00' })], total: 1, page: 1, limit: 50 }) });
    render(<PackingSection />);

    const row = (await screen.findAllByTestId('packing-row'))[0];
    const cells = within(row).getAllByRole('cell').map((cell) => cell.textContent);
    expect(cells).toEqual(['ORD-11111111', '2026/10/20', '山田 花子', 'hanako@example.com', 'シルクブラウス', '白', 'M', '3', formatYen(12800)]);
  });

  test('FREQ-531-AC-01: 名前・メール・色・サイズが無い行は — を出す', async () => {
    serve({ packing: () => respond(200, { rows: [packingRow({ customerName: null, customerEmail: null, color: null, size: null })], total: 1, page: 1, limit: 50 }) });
    render(<PackingSection />);

    const row = (await screen.findAllByTestId('packing-row'))[0];
    const cells = within(row).getAllByRole('cell').map((cell) => cell.textContent);
    expect(cells.slice(2, 4)).toEqual(['—', '—']);
    expect(cells.slice(5, 7)).toEqual(['—', '—']);
  });

  test('FREQ-531-AC-01: 窓口が返した順（古い注文から）のまま並べる', async () => {
    serve({
      packing: () => respond(200, {
        rows: [packingRow({ orderId: ORDER_ID, itemName: '先の品' }), packingRow({ orderId: ORDER_ID_2, orderItemId: ITEM_ID_2, itemName: '後の品' })],
        total: 2, page: 1, limit: 50,
      }),
    });
    render(<PackingSection />);

    const rows = await screen.findAllByTestId('packing-row');
    expect(rows.map((row) => within(row).getAllByRole('cell')[4].textContent)).toEqual(['先の品', '後の品']);
  });

  test('FREQ-531-AC-01: 注文IDは注文番号のボタンで、押すと注文の履歴のダイアログを orderId つきで開く。閉じると orderId は null', async () => {
    serve();
    render(<PackingSection />);

    const button = await screen.findByRole('button', { name: 'ORD-11111111 の履歴を開く' });
    expect(button).toHaveTextContent('ORD-11111111');
    expect(mockHistoryDialog.mock.lastCall?.[0]).toMatchObject({ orderId: null });
    fireEvent.click(button);
    expect(mockHistoryDialog.mock.lastCall?.[0]).toMatchObject({ orderId: ORDER_ID });
    act(() => (mockHistoryDialog.mock.lastCall?.[0] as { onClose: () => void }).onClose());
    await waitFor(() => expect(mockHistoryDialog.mock.lastCall?.[0]).toMatchObject({ orderId: null }));
  });

  test('FREQ-531-AC-01: 交換の品の行は、商品名の横に「交換の品」の印を出す。ほかの行には出さない', async () => {
    serve({
      packing: () => respond(200, {
        rows: [packingRow({ isExchange: true }), packingRow({ orderId: ORDER_ID_2, orderItemId: ITEM_ID_2 })],
        total: 2, page: 1, limit: 50,
      }),
    });
    render(<PackingSection />);

    const [exchange, normal] = await screen.findAllByTestId('packing-row');
    expect(within(within(exchange).getAllByRole('cell')[4]).getByText('交換の品')).toBeInTheDocument();
    expect(within(normal).queryByText('交換の品')).not.toBeInTheDocument();
  });

  test('FREQ-531-AC-01: この段階は読むだけ。選択欄・送る数の入力・「発送」のボタンを出さない', async () => {
    serve({ packing: () => respond(200, { rows: [packingRow(), packingRow({ orderItemId: ITEM_ID_2, blockedReasons: ['variant_missing'], shippableQuantity: 0 })], total: 2, page: 1, limit: 50 }) });
    render(<PackingSection />);
    await screen.findAllByTestId('packing-row');

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '発送' })).not.toBeInTheDocument();
    expect(screen.queryByText('発送票を作る権限がありません。')).not.toBeInTheDocument();
  });
});

describe('荷作り表: 選べない理由と別の下書き', () => {
  test('FREQ-531-AC-02: 選べない行は、阻害理由の文を行の下に出す（理由ごとに1行）。選べる行には出さない', async () => {
    serve({
      packing: () => respond(200, {
        rows: [
          packingRow({ blockedReasons: ['payment_review', 'exchange_fee_waiting', 'variant_missing', 'address_incomplete', 'paid_at_missing'], shippableQuantity: 0 }),
          packingRow({ orderId: ORDER_ID_2, orderItemId: ITEM_ID_2 }),
        ],
        total: 2, page: 1, limit: 50,
      }),
    });
    render(<PackingSection />);

    const notes = await screen.findAllByTestId('packing-row-note');
    expect(notes).toHaveLength(1);
    expect(Array.from(notes[0].querySelectorAll('p')).map((line) => line.textContent)).toEqual([
      '支払額の確認が済むまで選べません',
      '交換手数料のお支払いを待っているため選べません',
      '色・サイズが確定していないため選べません',
      '配送先の情報が足りないため選べません',
      '入金日時が記録されていないため選べません',
    ]);
    // 文は、その品物の行のすぐ下に出る
    const [blocked] = screen.getAllByTestId('packing-row');
    expect(blocked.nextElementSibling).toBe(notes[0]);
  });

  test('FREQ-531-AC-03: 別の下書きにも選ばれている行は「別の発送票（番号）にも選ばれています」を出す', async () => {
    serve({
      packing: () => respond(200, { rows: [packingRow({ otherSlipNumbers: ['SL-20261025-0002', 'SL-20261025-0003'] })], total: 1, page: 1, limit: 50 }),
    });
    render(<PackingSection />);

    expect(await screen.findByText('別の発送票（SL-20261025-0002、SL-20261025-0003）にも選ばれています')).toBeInTheDocument();
  });

  test('FREQ-531-AC-02: 理由も別の下書きも無い行は、下の行を足さない', async () => {
    serve();
    render(<PackingSection />);
    await screen.findAllByTestId('packing-row');
    expect(screen.queryAllByTestId('packing-row-note')).toHaveLength(0);
  });
});

describe('荷作り表: 空・失敗・権限', () => {
  test('FREQ-531-AC-01: 発送準備中の品物が無ければ「発送準備中の品物はありません。」を出し、荷作り表の表は出さない', async () => {
    serve({ packing: () => respond(200, { ...EMPTY }) });
    render(<PackingSection />);

    expect(await screen.findByText('発送準備中の品物はありません。')).toBeInTheDocument();
    expect(screen.queryByTestId('packing-row')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '次の頁' })).not.toBeInTheDocument();
  });

  test('FREQ-531-AC-04: 権限が無い（403）人には「荷作り表を見る権限がありません。」だけを出し、発送票の一覧は読まない', async () => {
    serve({ packing: () => respond(403, { error: 'Forbidden', permission: 'admin.shipping.read', role: 'supporter' }) });
    render(<PackingSection />);

    expect(await screen.findByRole('alert')).toHaveTextContent('荷作り表を見る権限がありません。');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText('発送票の下書き')).not.toBeInTheDocument();
    expect(slipCalls()).toEqual([]);
  });

  test('FREQ-531-AC-04: ログインが切れた（401）時は、ログインし直すよう伝える。MFA が無い時は専用の文', async () => {
    serve({ packing: () => respond(401, { error: 'Unauthorized' }) });
    const { unmount } = render(<PackingSection />);
    expect(await screen.findByRole('alert')).toHaveTextContent('ログインし直してください。');
    expect(slipCalls()).toEqual([]);
    unmount();

    serve({ packing: () => respond(403, { error: 'Forbidden', reason: 'MFA required' }) });
    render(<PackingSection />);
    expect(await screen.findByRole('alert')).toHaveTextContent('2要素認証が必要です');
  });

  test.each([
    ['500', () => respond(500, { error: '発送の記録に失敗しました' })],
    ['形が崩れた応答', () => respond(200, { rows: [{ orderId: 'x' }], total: 1, page: 1, limit: 50 })],
    ['全件があるのに空の頁', () => respond(200, { rows: [], total: 5, page: 9, limit: 50 })],
    ['本文が JSON でない', () => ({ ok: true, status: 200, json: async () => { throw new Error('PRIVATE-MARKER'); } }) as unknown as Response],
  ])('FREQ-531-AC-04: 読み込みが失敗する（%s）と「荷作り表を読み込めませんでした。」。中身は出さない', async (_name, packing) => {
    serve({ packing });
    render(<PackingSection />);

    expect(await screen.findByText('荷作り表を読み込めませんでした。')).toBeInTheDocument();
    expect(screen.queryByTestId('packing-row')).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('PRIVATE-MARKER');
    // 一時的な失敗では、下の発送票の一覧は出す
    expect(await screen.findByText('発送票の下書き')).toBeInTheDocument();
  });

  test('FREQ-531-AC-04: 通信が切れても「荷作り表を読み込めませんでした。」', async () => {
    serve({ packing: () => { throw new Error('PRIVATE-MARKER'); } });
    render(<PackingSection />);

    expect(await screen.findByText('荷作り表を読み込めませんでした。')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('PRIVATE-MARKER');
  });
});

describe('荷作り表: 頁送り', () => {
  const page = (rows: number, total: number) => respond(200, {
    rows: Array.from({ length: rows }, (_, index) => packingRow({ orderItemId: `22222222-2222-4222-8222-2222222222${String(10 + index)}`, itemName: `品${index}` })),
    total, page: 1, limit: 50,
  });

  test('FREQ-531-AC-01: 全件が1頁に収まる時は前の頁・次の頁を無効にし、件数を出す', async () => {
    serve({ packing: () => page(2, 2) });
    render(<PackingSection />);

    await screen.findAllByTestId('packing-row');
    expect(screen.getByText('1〜2 / 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '前の頁' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '次の頁' })).toBeDisabled();
  });

  test('FREQ-531-AC-01: 次の頁・前の頁で窓口を頁つきで読み直し、最後の頁では次の頁を無効にする', async () => {
    serve({ packing: () => page(2, 120) });
    render(<PackingSection />);

    await screen.findAllByTestId('packing-row');
    expect(screen.getByText('1〜2 / 120')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '次の頁' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: '次の頁' }));
    await waitFor(() => expect(packingCalls()).toEqual(['/api/admin/packing?limit=50&page=1', '/api/admin/packing?limit=50&page=2']));
    expect(await screen.findByText('51〜52 / 120')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '前の頁' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: '次の頁' }));
    expect(await screen.findByText('101〜102 / 120')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '次の頁' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '前の頁' }));
    expect(await screen.findByText('51〜52 / 120')).toBeInTheDocument();
    expect(packingCalls().at(-1)).toBe('/api/admin/packing?limit=50&page=2');
  });

  test('FREQ-531-AC-01: 2頁目以降が範囲外で空になったら（他の人の発送で全件が減った時）、1頁目へ戻って読み直し、「品物はありません」で行き止まりにしない', async () => {
    serve({
      packing: (url) => (url.includes('page=2')
        ? respond(200, { rows: [], total: 0, page: 2, limit: 50 })
        : page(2, 120)),
    });
    render(<PackingSection />);

    await screen.findAllByTestId('packing-row');
    fireEvent.click(screen.getByRole('button', { name: '次の頁' }));
    await waitFor(() => expect(packingCalls()).toEqual([
      '/api/admin/packing?limit=50&page=1', '/api/admin/packing?limit=50&page=2', '/api/admin/packing?limit=50&page=1',
    ]));
    expect(await screen.findByText('1〜2 / 120')).toBeInTheDocument();
    expect(screen.queryByText('発送準備中の品物はありません。')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '前の頁' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '次の頁' })).toBeEnabled();
  });

  test('FREQ-531-AC-01: 2頁目以降の読み込みが失敗しても「前の頁」を出し、押すと1つ前の頁を読み直す。1頁目の失敗には出さない', async () => {
    serve({
      packing: (url) => (url.includes('page=2') ? respond(500, { error: '発送の記録に失敗しました' }) : page(2, 120)),
    });
    render(<PackingSection />);

    await screen.findAllByTestId('packing-row');
    fireEvent.click(screen.getByRole('button', { name: '次の頁' }));
    expect(await screen.findByText('荷作り表を読み込めませんでした。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '前の頁' }));
    expect(await screen.findByText('1〜2 / 120')).toBeInTheDocument();
    expect(packingCalls().at(-1)).toBe('/api/admin/packing?limit=50&page=1');
  });

  test('FREQ-531-AC-01: 1頁目の失敗には「前の頁」を出さない', async () => {
    serve({ packing: () => respond(500, { error: '発送の記録に失敗しました' }) });
    render(<PackingSection />);

    expect(await screen.findByText('荷作り表を読み込めませんでした。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '前の頁' })).not.toBeInTheDocument();
  });
  test('FREQ-531-AC-01: 頁を変えても下の発送票の一覧は読み直さない', async () => {
    serve({ packing: () => page(2, 120) });
    render(<PackingSection />);

    await screen.findAllByTestId('packing-row');
    await waitFor(() => expect(slipCalls()).toHaveLength(3));
    fireEvent.click(screen.getByRole('button', { name: '次の頁' }));
    expect(await screen.findByText('51〜52 / 120')).toBeInTheDocument();
    expect(slipCalls()).toHaveLength(3);
  });
});

describe('荷作り表の下の発送票の一覧', () => {
  const list = (rows: unknown[]) => respond(200, { rows, total: rows.length, page: 1, limit: 20 });

  test('FREQ-531-AC-01: 荷作り表を読んでから、下書き・確定済み・取消済みを段階ごとに最新20件までで読む', async () => {
    serve();
    render(<PackingSection />);
    await screen.findAllByTestId('packing-row');

    await waitFor(() => expect(slipCalls().sort()).toEqual([
      '/api/admin/shipment-slips?stage=cancelled&limit=20&page=1',
      '/api/admin/shipment-slips?stage=confirmed&limit=20&page=1',
      '/api/admin/shipment-slips?stage=draft&limit=20&page=1',
    ]));
    expect(screen.getByRole('heading', { level: 2, name: '発送票の下書き' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: '確定済みの発送票' })).toBeInTheDocument();
  });

  test('FREQ-531-AC-01: 下書きは 票番号・更新日時（日本時間）・注文数・数量・開く を出し、期限切れの下書きには「期限切れ」を付ける', async () => {
    serve({
      slips: (stage) => (stage === 'draft'
        ? list([
          slipListRow({ id: SLIP_ID, number: 'SL-20261025-0002', stage: 'draft', shipmentDate: null, shippingCarrier: null, trackingNumber: null, orderCount: 1, itemQuantity: 2, updatedAt: '2026-10-25T16:30:00+00:00' }),
          slipListRow({ id: SLIP_ID_2, number: 'SL-20261025-0001', stage: 'draft', shipmentDate: null, shippingCarrier: null, trackingNumber: null, expired: true, orderCount: 2, itemQuantity: 7, updatedAt: '2026-10-18T01:00:00+00:00' }),
        ])
        : list([])),
    });
    render(<PackingSection />);

    const rows = await screen.findAllByTestId('packing-draft-row');
    expect(rows).toHaveLength(2);
    const first = within(rows[0]).getAllByRole('cell').map((cell) => cell.textContent);
    expect(first[0]).toBe('SL-20261025-0002');
    expect(first[1]).toMatch(/2026\/10\/26.*1:30/);
    expect(first.slice(2, 4)).toEqual(['1', '2']);
    expect(within(rows[0]).queryByText('期限切れ')).not.toBeInTheDocument();
    expect(within(rows[1]).getAllByRole('cell')[0]).toHaveTextContent('SL-20261025-0001期限切れ');
    const link = within(rows[0]).getByRole('link', { name: '発送票 SL-20261025-0002 を開く' });
    expect(link).toHaveTextContent('開く');
    expect(link).toHaveAttribute('href', `/admin/shipment-slips/${SLIP_ID}`);
    expect(within(rows[1]).getByRole('link', { name: '発送票 SL-20261025-0001 を開く' })).toHaveAttribute('href', `/admin/shipment-slips/${SLIP_ID_2}`);
    const headings = within(sectionTable('発送票の下書き')).getAllByRole('columnheader').map((cell) => cell.textContent);
    expect(headings).toEqual(['票番号', '更新日時', '注文数', '数量', '操作']);
  });

  test('FREQ-531-AC-01: 確定済みは 票番号・出荷日・運送会社と伝票番号（無ければ「伝票番号なし」）・注文数・開く。取消済みは「取消済み」を付け、更新の新しい順に並べる', async () => {
    serve({
      slips: (stage) => {
        if (stage === 'confirmed') {
          return list([
            slipListRow({ id: SLIP_ID, number: 'SL-20261025-0001', updatedAt: '2026-10-25T03:00:00+00:00' }),
            slipListRow({ id: SLIP_ID_2, number: 'SL-20261025-0002', shippingCarrier: null, trackingNumber: null, shipmentDate: '2026-10-24', orderCount: 1, updatedAt: '2026-10-24T03:00:00+00:00' }),
          ]);
        }
        if (stage === 'cancelled') {
          return list([slipListRow({ id: '33333333-3333-4333-8333-333333333333', number: 'SL-20261025-0003', stage: 'cancelled', shippingCarrier: 'sagawa', trackingNumber: 'ABC-1', updatedAt: '2026-10-25T09:00:00+00:00' })]);
        }
        return list([]);
      },
    });
    render(<PackingSection />);

    const rows = await screen.findAllByTestId('packing-confirmed-row');
    expect(rows.map((row) => within(row).getAllByRole('cell')[0].textContent)).toEqual([
      'SL-20261025-0003取消済み', 'SL-20261025-0001', 'SL-20261025-0002',
    ]);
    expect(within(rows[0]).getAllByRole('cell').slice(1, 4).map((cell) => cell.textContent)).toEqual(['2026/10/25', '佐川急便 ABC-1', '2']);
    expect(within(rows[1]).getAllByRole('cell').slice(1, 4).map((cell) => cell.textContent)).toEqual(['2026/10/25', 'ヤマト運輸 1234-5678', '2']);
    expect(within(rows[2]).getAllByRole('cell').slice(1, 4).map((cell) => cell.textContent)).toEqual(['2026/10/24', '伝票番号なし', '1']);
    expect(within(rows[2]).getByRole('link', { name: '発送票 SL-20261025-0002 を開く' })).toHaveAttribute('href', `/admin/shipment-slips/${SLIP_ID_2}`);
    const headings = within(sectionTable('確定済みの発送票')).getAllByRole('columnheader').map((cell) => cell.textContent);
    expect(headings).toEqual(['票番号', '出荷日', '運送会社・伝票番号', '注文数', '操作']);
  });

  test('FREQ-531-AC-01: 確定済みと取消済みを合わせて最新20件までにする', async () => {
    const many = (stage: 'confirmed' | 'cancelled', base: number) => list(Array.from({ length: 15 }, (_, index) => slipListRow({
      id: `55555555-5555-4555-8555-5555555555${String(base + index).padStart(2, '0')}`,
      number: `SL-20261025-${String(base + index).padStart(4, '0')}`,
      stage,
      updatedAt: `2026-10-25T${String((base + index) % 24).padStart(2, '0')}:00:00+00:00`,
    })));
    serve({ slips: (stage) => (stage === 'confirmed' ? many('confirmed', 10) : stage === 'cancelled' ? many('cancelled', 40) : list([])) });
    render(<PackingSection />);

    const rows = await screen.findAllByTestId('packing-confirmed-row');
    expect(rows).toHaveLength(20);
  });

  test('FREQ-531-AC-01: 一覧が空なら、それぞれ「該当する発送票はありません。」', async () => {
    serve();
    render(<PackingSection />);
    await screen.findAllByTestId('packing-row');
    await waitFor(() => expect(screen.getAllByText('該当する発送票はありません。')).toHaveLength(2));
  });

  test('FREQ-531-AC-04: 一覧が読めなくても荷作り表は出し、その節に失敗の文を出す。権限の文は節ごと', async () => {
    serve({
      slips: (stage) => (stage === 'draft'
        ? respond(500, { error: '発送の記録に失敗しました' })
        : respond(403, { error: 'Forbidden', permission: 'admin.shipping.read', role: 'supporter' })),
    });
    render(<PackingSection />);

    expect(await screen.findAllByTestId('packing-row')).toHaveLength(1);
    const drafts = (await screen.findByRole('heading', { name: '発送票の下書き' })).closest('section') as HTMLElement;
    const confirmed = screen.getByRole('heading', { name: '確定済みの発送票' }).closest('section') as HTMLElement;
    expect(await within(drafts).findByRole('alert')).toHaveTextContent('発送票の一覧を読み込めませんでした。');
    expect(await within(confirmed).findByRole('alert')).toHaveTextContent('発送票を見る権限がありません。');
  });
});

describe('荷作り表: 画面の幅', () => {
  test('FREQ-531-AC-01: 表は見出しを保ったスクロール領域に入れ、頁全体を横にはみ出させない（クラスの確認。390/768/1280 の実測は E2E）', async () => {
    serve({ slips: (stage) => respond(200, { rows: stage === 'draft' ? [slipListRow({ stage: 'draft' })] : [], total: stage === 'draft' ? 1 : 0, page: 1, limit: 20 }) });
    const { container } = render(<PackingSection />);
    await screen.findAllByTestId('packing-row');
    await screen.findAllByTestId('packing-draft-row');

    expect(container.firstElementChild?.className).toMatch(/min-w-0/);
    expect(container.firstElementChild?.className).toMatch(/max-w-full/);
    // スクロール領域（tabindex を持つ div）。表を持つ領域ごとに、荷作り表と下書きの2つ
    const regions = Array.from(container.querySelectorAll('div[role="region"]'));
    expect(regions).toHaveLength(2);
    for (const region of regions) {
      expect(region).toHaveAttribute('tabindex', '0');
      expect(region.className).toMatch(/overflow-auto/);
      expect(region.className).toMatch(/max-w-full/);
      expect(region.querySelector('table')).not.toBeNull();
      expect(region).toHaveAccessibleName();
    }
    for (const cell of within(packingTable()).getAllByRole('columnheader')) {
      expect(cell.className).toMatch(/sticky/);
    }
  });
});
