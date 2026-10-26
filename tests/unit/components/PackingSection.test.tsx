import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import PackingSection from '@/components/PackingSection';
import { formatYen } from '@/lib/orders/refund/refund-messages';
import { takeSlipNotice } from '@/lib/orders/shipment-slips/shipment-slip-notice';
import {
  ITEM_ID,
  ITEM_ID_2,
  ORDER_ID,
  ORDER_ID_2,
  packingRow,
  SLIP_ID,
  SLIP_ID_2,
  slipListRow,
} from '../lib/orders/shipment-slips/shipment-slip-fixtures';

/**
 * 荷作り表（G-3 / FREQ-531・FREQ-532）の画面。発送準備中の品物の表（選択欄・送る数・「発送」を含む）と、下の発送票の一覧。
 * 窓口（clientFetch）・票の頁への移動（next/navigation）だけを差し替える。
 * 注文IDは注文の詳細（/admin/orders/{id}）への Link（G-4 Task 8。履歴の dialog は撤去した）。
 */
const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));
const mockPush = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }));

const EMPTY = { rows: [], total: 0, page: 1, limit: 50 };

function respond(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

type Handlers = {
  packing?: (url: string) => Response | Promise<Response>;
  slips?: (stage: string) => Response | Promise<Response>;
  /** 下書きを作る窓口（POST /api/admin/shipment-slips）。本文は JSON を読んだ物 */
  create?: (body: { lines: Array<{ orderItemId: string; quantity: number }>; requestKey: string }) => Response | Promise<Response>;
};

/** 荷作り表の成功の答えに canManage が無ければ true を足す（権限のある人の答え。無い人の試験は canManage: false を自分で入れる） */
async function withCanManage(answer: Response | Promise<Response>): Promise<Response> {
  const response = await answer;
  const body: unknown = await response.json();
  if (response.ok && body !== null && typeof body === 'object' && !('canManage' in body)) return respond(response.status, { canManage: true, ...body });
  return respond(response.status, body);
}

/** 荷作り表と発送票の一覧・作成の窓口を、URL と method で振り分けて答える */
function serve({ packing, slips, create }: Handlers = {}) {
  mockClientFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (init?.method === 'POST') {
      return create ? create(JSON.parse(String(init.body))) : respond(201, { id: SLIP_ID, number: 'SL-20261025-0001', version: 1, replayed: false });
    }
    if (target.startsWith('/api/admin/packing')) {
      return withCanManage(packing ? packing(target) : respond(200, { ...EMPTY, rows: [packingRow()], total: 1 }));
    }
    const stage = new URL(target, 'https://example.test').searchParams.get('stage') ?? '';
    return slips ? slips(stage) : respond(200, { rows: [], total: 0, page: 1, limit: 20 });
  });
}

const packingCalls = () => mockClientFetch.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith('/api/admin/packing'));
const slipCalls = () => mockClientFetch.mock.calls
  .filter(([, init]) => (init as RequestInit | undefined)?.method !== 'POST')
  .map(([url]) => String(url)).filter((url) => url.startsWith('/api/admin/shipment-slips'));
/** 下書きを作る窓口への送信（本文の JSON を読んだ物） */
const createCalls = () => mockClientFetch.mock.calls
  .filter(([url, init]) => String(url) === '/api/admin/shipment-slips' && (init as RequestInit | undefined)?.method === 'POST')
  .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { lines: Array<{ orderItemId: string; quantity: number }>; requestKey: string });

function packingTable(): HTMLElement {
  return screen.getAllByRole('table')[0];
}

/** 見出しの節の中の表 */
function sectionTable(heading: string): HTMLElement {
  return within(screen.getByRole('heading', { level: 2, name: heading }).closest('section') as HTMLElement).getByRole('table');
}

beforeEach(() => {
  mockClientFetch.mockReset();
  mockPush.mockReset();
  window.sessionStorage.clear();
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

  test('FREQ-531-AC-01: 列は左から 選択欄（見出しは視覚的に隠す「選択」）・注文ID・注文日・顧客名・メールアドレス・商品名・色・サイズ・数量・単価', async () => {
    serve();
    render(<PackingSection />);
    await screen.findAllByTestId('packing-row');

    const headings = within(packingTable()).getAllByRole('columnheader').map((cell) => cell.textContent);
    expect(headings).toEqual(['選択', '注文ID', '注文日', '顧客名', 'メールアドレス', '商品名', '色', 'サイズ', '数量', '単価']);
    expect(within(within(packingTable()).getAllByRole('columnheader')[0]).getByText('選択')).toHaveClass('sr-only');
  });

  test('FREQ-531-AC-01: 1行は 選択欄・注文番号・注文日（日本時間）・顧客名・メール・商品名・色・サイズ・準備中の数・単価 を左の列から順に出す', async () => {
    serve({ packing: () => respond(200, { rows: [packingRow({ orderCreatedAt: '2026-10-19T16:00:00+00:00' })], total: 1, page: 1, limit: 50 }) });
    render(<PackingSection />);

    const row = (await screen.findAllByTestId('packing-row'))[0];
    const cells = within(row).getAllByRole('cell').map((cell) => cell.textContent);
    expect(cells).toEqual(['', 'ORD-11111111', '2026/10/20', '山田 花子', 'hanako@example.com', 'シルクブラウス', '白', 'M', '3', formatYen(12800)]);
    expect(within(row).getByRole('checkbox', { name: 'シルクブラウス 白 M を選ぶ' })).not.toBeChecked();
  });

  test('FREQ-531-AC-01: 名前・メール・色・サイズが無い行は — を出す', async () => {
    serve({ packing: () => respond(200, { rows: [packingRow({ customerName: null, customerEmail: null, color: null, size: null })], total: 1, page: 1, limit: 50 }) });
    render(<PackingSection />);

    const row = (await screen.findAllByTestId('packing-row'))[0];
    const cells = within(row).getAllByRole('cell').map((cell) => cell.textContent);
    expect(cells.slice(3, 5)).toEqual(['—', '—']);
    expect(cells.slice(6, 8)).toEqual(['—', '—']);
    expect(within(row).getByRole('checkbox', { name: 'シルクブラウス を選ぶ' })).toBeInTheDocument();
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
    expect(rows.map((row) => within(row).getAllByRole('cell')[5].textContent)).toEqual(['先の品', '後の品']);
  });

  test('FREQ-539-AC-05: 荷作り表の注文IDは /admin/orders/{id} への Link で、履歴の dialog を開かない', async () => {
    serve();
    render(<PackingSection />);

    const link = await screen.findByRole('link', { name: 'ORD-11111111' });
    expect(link).toHaveTextContent('ORD-11111111');
    expect(link).toHaveAttribute('href', `/admin/orders/${ORDER_ID}`);
    // 旧い履歴を開くボタンは無く、押しても dialog は開かない
    expect(screen.queryByRole('button', { name: 'ORD-11111111 の履歴を開く' })).not.toBeInTheDocument();
    link.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(link);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });

  test('FREQ-539-AC-05: 注文IDのリンクは行ごとに、その行の注文の詳細へ向く', async () => {
    serve({
      packing: () => respond(200, {
        rows: [packingRow({ orderId: ORDER_ID }), packingRow({ orderId: ORDER_ID_2, orderItemId: ITEM_ID_2 })],
        total: 2, page: 1, limit: 50,
      }),
    });
    render(<PackingSection />);

    const rows = await screen.findAllByTestId('packing-row');
    const hrefs = rows.map((row) => within(row).getAllByRole('link')[0].getAttribute('href'));
    expect(hrefs).toEqual([`/admin/orders/${ORDER_ID}`, `/admin/orders/${ORDER_ID_2}`]);
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
    expect(within(within(exchange).getAllByRole('cell')[5]).getByText('交換の品')).toBeInTheDocument();
    expect(within(normal).queryByText('交換の品')).not.toBeInTheDocument();
  });

  test('FREQ-531-AC-03: 選ぶ前は送る数の入力を出さず、「発送」は無効。権限の文は出さない', async () => {
    serve({ packing: () => respond(200, { rows: [packingRow(), packingRow({ orderItemId: ITEM_ID_2, blockedReasons: ['variant_missing'], shippableQuantity: 0 })], total: 2, page: 1, limit: 50 }) });
    render(<PackingSection />);
    await screen.findAllByTestId('packing-row');

    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '発送' })).toBeDisabled();
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

describe('荷作り表: 品物を選んで発送票の下書きを作る', () => {
  const KEY_A = 'a'.repeat(32);
  const ROW_A = packingRow({ bundleKey: KEY_A });
  const ROW_B = packingRow({ orderId: ORDER_ID_2, orderItemId: ITEM_ID_2, itemName: 'ニットベスト', color: '黒', size: 'L', readyQuantity: 5, shippableQuantity: 5, bundleKey: KEY_A });
  const ROW_C = packingRow({ orderId: '11111111-1111-4111-8111-111111111113', orderItemId: '22222222-2222-4222-8222-222222222223', itemName: '別のお客様の品', color: '青', size: 'S', bundleKey: 'c'.repeat(32) });
  const ROW_D = packingRow({ orderId: '11111111-1111-4111-8111-111111111114', orderItemId: '22222222-2222-4222-8222-222222222224', itemName: '鍵の無い品', color: '赤', size: 'F', bundleKey: null });
  const HINT = '同じお客様・同じ配送先の注文だけ同梱できます';
  const rows = (...list: ReturnType<typeof packingRow>[]) => () => respond(200, { rows: list, total: list.length, page: 1, limit: 50 });
  const box = (name: string) => screen.getByRole('checkbox', { name });
  const quantityInput = (name: string) => screen.getByRole('spinbutton', { name });
  const ship = () => screen.getByRole('button', { name: '発送' });
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  test('FREQ-531-AC-03: 1行目を選ぶと、bundleKey が違う行・NULL の行の選択欄が無効になり「同じお客様・同じ配送先の注文だけ同梱できます」を行の下に出す。全部外すと戻る', async () => {
    serve({ packing: rows(ROW_A, ROW_B, ROW_C, ROW_D) });
    render(<PackingSection />);
    await screen.findAllByTestId('packing-row');
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
    for (const name of ['シルクブラウス 白 M を選ぶ', 'ニットベスト 黒 L を選ぶ', '別のお客様の品 青 S を選ぶ', '鍵の無い品 赤 F を選ぶ']) expect(box(name)).toBeEnabled();

    fireEvent.click(box('シルクブラウス 白 M を選ぶ'));
    expect(box('シルクブラウス 白 M を選ぶ')).toBeChecked();
    expect(box('ニットベスト 黒 L を選ぶ')).toBeEnabled();
    expect(box('別のお客様の品 青 S を選ぶ')).toBeDisabled();
    expect(box('鍵の無い品 赤 F を選ぶ')).toBeDisabled();
    expect(screen.getAllByText(HINT)).toHaveLength(2);
    // 選んだ行の下ではなく、同梱できない行の下に出る
    const notes = screen.getAllByTestId('packing-row-note');
    expect(notes).toHaveLength(2);
    expect(notes[0].previousElementSibling).toBe(screen.getAllByTestId('packing-row')[2]);

    fireEvent.click(box('ニットベスト 黒 L を選ぶ'));
    fireEvent.click(box('シルクブラウス 白 M を選ぶ'));
    // 1行目を外しても、残った行（B）が基準になる
    expect(box('別のお客様の品 青 S を選ぶ')).toBeDisabled();
    fireEvent.click(box('ニットベスト 黒 L を選ぶ'));
    for (const name of ['シルクブラウス 白 M を選ぶ', 'ニットベスト 黒 L を選ぶ', '別のお客様の品 青 S を選ぶ', '鍵の無い品 赤 F を選ぶ']) expect(box(name)).toBeEnabled();
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  });

  test('FREQ-531-AC-02: 阻害理由のある行は選べない（理由は行の下に出す）', async () => {
    serve({ packing: rows(ROW_A, packingRow({ orderItemId: ITEM_ID_2, blockedReasons: ['payment_review'], shippableQuantity: 0, itemName: '確認待ちの品', color: null, size: null })) });
    render(<PackingSection />);
    await screen.findAllByTestId('packing-row');

    expect(box('確認待ちの品 を選ぶ')).toBeDisabled();
    expect(screen.getByText('支払額の確認が済むまで選べません')).toBeInTheDocument();
    expect(box('シルクブラウス 白 M を選ぶ')).toBeEnabled();
  });

  test('FREQ-531-AC-03: 選んだ行に「今回送る数」の入力が出る。初期値は準備中の数で、1〜準備中の数の整数のあいだだけ「発送」を押せる', async () => {
    serve({ packing: rows(ROW_A, ROW_B) });
    render(<PackingSection />);
    await screen.findAllByTestId('packing-row');
    expect(ship()).toBeDisabled();

    fireEvent.click(box('シルクブラウス 白 M を選ぶ'));
    const input = quantityInput('シルクブラウス 白 M の送る数');
    expect(input).toHaveValue(3);
    expect(input).toHaveAttribute('min', '1');
    expect(input).toHaveAttribute('max', '3');
    expect(screen.getByText('今回送る数')).toBeInTheDocument();
    expect(screen.queryByRole('spinbutton', { name: 'ニットベスト 黒 L の送る数' })).not.toBeInTheDocument();
    expect(ship()).toBeEnabled();

    for (const [value, enabled] of [['0', false], ['4', false], ['', false], ['1.5', false], ['2', true], ['3', true]] as const) {
      fireEvent.change(input, { target: { value } });
      expect({ value, enabled: !ship().hasAttribute('disabled') }).toEqual({ value, enabled });
    }
    fireEvent.click(box('シルクブラウス 白 M を選ぶ'));
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(ship()).toBeDisabled();
  });

  test('FREQ-533-AC-01: 「発送」で下書きを作る窓口を1回だけ呼び（二重押下でも1回）、選んだ行・送る数・requestKey を送り、成功で票の頁へ移る。通知は票の頁へ引き継ぐ', async () => {
    let release: () => void = () => {};
    serve({
      packing: rows(ROW_A, ROW_B),
      create: () => new Promise<Response>((resolve) => {
        release = () => resolve(respond(201, { id: SLIP_ID, number: 'SL-20261025-0001', version: 1, replayed: false }));
      }),
    });
    render(<PackingSection />);
    await screen.findAllByTestId('packing-row');
    fireEvent.click(box('シルクブラウス 白 M を選ぶ'));
    fireEvent.click(box('ニットベスト 黒 L を選ぶ'));
    fireEvent.change(quantityInput('シルクブラウス 白 M の送る数'), { target: { value: '2' } });

    fireEvent.click(ship());
    fireEvent.click(ship());
    expect(await screen.findByText('保存しています…')).toBeInTheDocument();
    expect(createCalls()).toHaveLength(1);
    expect(createCalls()[0].lines).toEqual([{ orderItemId: ITEM_ID, quantity: 2 }, { orderItemId: ITEM_ID_2, quantity: 5 }]);
    expect(createCalls()[0].requestKey).toMatch(UUID);
    expect(Object.keys(createCalls()[0]).sort()).toEqual(['lines', 'requestKey']);
    // 送っている間は選択欄も入力も止める
    expect(box('シルクブラウス 白 M を選ぶ')).toBeDisabled();
    expect(quantityInput('シルクブラウス 白 M の送る数')).toBeDisabled();
    expect(mockPush).not.toHaveBeenCalled();

    release();
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(`/admin/shipment-slips/${SLIP_ID}`));
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(takeSlipNotice(SLIP_ID)).toBe(true);
    expect(takeSlipNotice(SLIP_ID)).toBe(false);
  });

  test('FREQ-533-AC-03: 結果が分からない（500・通信切れ）時は、入力を止めて「結果を確かめられませんでした…」と「もう一度確かめる」を出し、同じ requestKey と同じ本文で送り直す', async () => {
    let calls = 0;
    serve({
      packing: rows(ROW_A),
      create: () => {
        calls += 1;
        if (calls === 1) return respond(500, { error: '発送の記録に失敗しました' });
        if (calls === 2) throw new Error('network');
        return respond(200, { id: SLIP_ID, number: 'SL-20261025-0001', version: 1, replayed: true });
      },
    });
    render(<PackingSection />);
    await screen.findAllByTestId('packing-row');
    fireEvent.click(box('シルクブラウス 白 M を選ぶ'));
    fireEvent.click(ship());

    expect(await screen.findByText('結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。')).toBeInTheDocument();
    expect(box('シルクブラウス 白 M を選ぶ')).toBeDisabled();
    expect(quantityInput('シルクブラウス 白 M の送る数')).toBeDisabled();
    expect(ship()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'もう一度確かめる' }));
    await waitFor(() => expect(createCalls()).toHaveLength(2));
    // 通信が切れてもう一度結果不明: まだ同じ画面
    expect(await screen.findByRole('button', { name: 'もう一度確かめる' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'もう一度確かめる' }));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(`/admin/shipment-slips/${SLIP_ID}`));
    expect(createCalls()).toHaveLength(3);
    expect(createCalls()[1]).toEqual(createCalls()[0]);
    expect(createCalls()[2]).toEqual(createCalls()[0]);
  });

  test('FREQ-531-AC-03: 窓口が断った時（409）は表の文を出し、選択は保つ。次の送信は新しい requestKey', async () => {
    serve({
      packing: rows(ROW_A),
      create: () => respond(409, { code: 'GROUP_G_SLIP_QUANTITY_EXCEEDS_READY', error: '発送準備中の数を超えています。荷作り表を読み直してください。' }),
    });
    render(<PackingSection />);
    await screen.findAllByTestId('packing-row');
    fireEvent.click(box('シルクブラウス 白 M を選ぶ'));
    fireEvent.click(ship());

    expect(await screen.findByRole('alert')).toHaveTextContent('発送準備中の数を超えています。荷作り表を読み直してください。');
    expect(box('シルクブラウス 白 M を選ぶ')).toBeChecked();
    expect(ship()).toBeEnabled();
    expect(mockPush).not.toHaveBeenCalled();
    fireEvent.click(ship());
    await waitFor(() => expect(createCalls()).toHaveLength(2));
    expect(createCalls()[1].requestKey).not.toBe(createCalls()[0].requestKey);
    expect(createCalls()[1].lines).toEqual(createCalls()[0].lines);
  });

  test('FREQ-531-AC-03: 回数の制限（429）やログイン切れ（401）は文を出す。同じ内容の再押下は同じ requestKey', async () => {
    serve({ packing: rows(ROW_A), create: () => respond(429, { error: 'Too many requests' }) });
    render(<PackingSection />);
    await screen.findAllByTestId('packing-row');
    fireEvent.click(box('シルクブラウス 白 M を選ぶ'));
    fireEvent.click(ship());
    expect(await screen.findByRole('alert')).toHaveTextContent('操作が続いたため受け付けませんでした。しばらく待ってから、もう一度お試しください。');
    fireEvent.click(ship());
    await waitFor(() => expect(createCalls()).toHaveLength(2));
    expect(createCalls()[1]).toEqual(createCalls()[0]);
    await waitFor(() => expect(ship()).toBeEnabled());
    expect(await screen.findByRole('alert')).toHaveTextContent('操作が続いたため受け付けませんでした。');

    mockClientFetch.mockReset();
    serve({ packing: rows(ROW_A), create: () => respond(401, { error: 'Unauthorized' }) });
    fireEvent.click(ship());
    expect(await screen.findByRole('alert')).toHaveTextContent('ログインし直してください。');
  });

  test('FREQ-540-AC-10: 操作の権限だけ無い人（「発送」の返事が 403）は、表は見えたまま選択欄と「発送」が消え、「発送票を作る権限がありません。」を1回出す', async () => {
    serve({
      packing: rows(ROW_A, ROW_B),
      create: () => respond(403, { code: 'GROUP_G_FORBIDDEN', error: '発送を扱う権限がありません。' }),
    });
    render(<PackingSection />);
    await screen.findAllByTestId('packing-row');
    fireEvent.click(box('シルクブラウス 白 M を選ぶ'));
    fireEvent.click(ship());

    expect(await screen.findByText('発送票を作る権限がありません。')).toBeInTheDocument();
    expect(screen.getAllByText('発送票を作る権限がありません。')).toHaveLength(1);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '発送' })).not.toBeInTheDocument();
    expect(screen.getAllByTestId('packing-row')).toHaveLength(2);
    const headings = within(packingTable()).getAllByRole('columnheader').map((cell) => cell.textContent);
    expect(headings).toEqual(['注文ID', '注文日', '顧客名', 'メールアドレス', '商品名', '色', 'サイズ', '数量', '単価']);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('FREQ-540-AC-10: 荷作り表の答えの canManage が false の人は、最初の描画から選択欄・送る数・「発送」が無く、「発送票を作る権限がありません。」が1回出る（窓口は呼ばない）', async () => {
    serve({ packing: () => respond(200, { rows: [ROW_A, ROW_B], total: 2, page: 1, limit: 50, canManage: false }) });
    render(<PackingSection />);
    await screen.findAllByTestId('packing-row');

    // 操作の部品は一度も描画されない（表が出た最初の描画で既に無い）
    expect(screen.getAllByText('発送票を作る権限がありません。')).toHaveLength(1);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '発送' })).not.toBeInTheDocument();
    expect(screen.getAllByTestId('packing-row')).toHaveLength(2);
    expect(within(packingTable()).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(
      ['注文ID', '注文日', '顧客名', 'メールアドレス', '商品名', '色', 'サイズ', '数量', '単価'],
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(createCalls()).toHaveLength(0);
    // 読む権限はあるので、下の発送票の一覧は読む
    expect(slipCalls().length).toBeGreaterThan(0);
  });

  test('FREQ-540-AC-10: canManage が true の人は選択欄と「発送」があり、権限の文は出ない', async () => {
    serve({ packing: () => respond(200, { rows: [ROW_A], total: 1, page: 1, limit: 50, canManage: true }) });
    render(<PackingSection />);
    await screen.findAllByTestId('packing-row');
    expect(box('シルクブラウス 白 M を選ぶ')).toBeEnabled();
    expect(ship()).toBeDisabled();
    expect(screen.queryByText('発送票を作る権限がありません。')).not.toBeInTheDocument();
  });

  test('FREQ-540-AC-10: 「発送」の返事が権限の不足の 403（permission つき）でも、表は見えたまま操作が消え、権限の文を1回出す', async () => {
    serve({
      packing: rows(ROW_A),
      create: () => respond(403, { error: 'Forbidden', permission: 'admin.shipping.manage', role: 'supporter' }),
    });
    render(<PackingSection />);
    await screen.findAllByTestId('packing-row');
    fireEvent.click(box('シルクブラウス 白 M を選ぶ'));
    fireEvent.click(ship());
    expect(await screen.findByText('発送票を作る権限がありません。')).toBeInTheDocument();
    expect(screen.getAllByText('発送票を作る権限がありません。')).toHaveLength(1);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '発送' })).not.toBeInTheDocument();
  });

  test.each([
    ['CSRF の確かめの失敗', { error: 'Forbidden', reason: 'CSRF validation failed' }, 'セキュリティ確認に失敗しました。ページを再読み込みして、もう一度送ってください。'],
    ['MFA が要る', { error: 'Forbidden', reason: 'MFA required', permission: 'admin.shipping.manage', role: 'admin' }, '2要素認証が必要です'],
    ['理由の分からない 403', { error: 'Forbidden' }, '発送を扱う権限がありません。'],
  ])('FREQ-540-AC-10: 「発送」の返事が 403（%s）でも権限が無いことにはしない。文を出し、選択欄と「発送」は残る', async (_name, body, message) => {
    serve({ packing: rows(ROW_A), create: () => respond(403, body) });
    render(<PackingSection />);
    await screen.findAllByTestId('packing-row');
    fireEvent.click(box('シルクブラウス 白 M を選ぶ'));
    fireEvent.click(ship());

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.queryByText('発送票を作る権限がありません。')).not.toBeInTheDocument();
    expect(box('シルクブラウス 白 M を選ぶ')).toBeChecked();
    expect(ship()).toBeEnabled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  test('FREQ-531-AC-03: 選んだ行は頁を変えても残り、同梱の基準も保たれる', async () => {
    serve({
      packing: (url) => (url.includes('page=2') ? respond(200, { rows: [ROW_B, ROW_C], total: 120, page: 2, limit: 50 }) : respond(200, { rows: [ROW_A], total: 120, page: 1, limit: 50 })),
    });
    render(<PackingSection />);
    await screen.findAllByTestId('packing-row');
    fireEvent.click(box('シルクブラウス 白 M を選ぶ'));
    fireEvent.click(screen.getByRole('button', { name: '次の頁' }));
    await screen.findByText('51〜52 / 120');
    expect(box('ニットベスト 黒 L を選ぶ')).toBeEnabled();
    expect(box('別のお客様の品 青 S を選ぶ')).toBeDisabled();
    expect(ship()).toBeEnabled();
    fireEvent.click(ship());
    await waitFor(() => expect(createCalls()).toHaveLength(1));
    expect(createCalls()[0].lines).toEqual([{ orderItemId: ROW_A.orderItemId, quantity: 3 }]);
  });
});