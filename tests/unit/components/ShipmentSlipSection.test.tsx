import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ShipmentSlipSection from '@/components/ShipmentSlipSection';
import { toOrderNumber } from '@/lib/orders/order-number';
import { rememberSlipNotice } from '@/lib/orders/shipment-slips/shipment-slip-notice';
import type { ShipmentSlipDetail } from '@/lib/orders/shipment-slips/shipment-slip-types';
import { DELIVERY_STATUS_LABELS } from '@/lib/orders/tracking/delivery-messages';
import {
  confirmedDetail,
  draftDetail,
  ITEM_ID,
  ITEM_ID_2,
  ORDER_ID,
  ORDER_ID_2,
  packingRow,
  SLIP_ID,
} from '../lib/orders/shipment-slips/shipment-slip-fixtures';

/**
 * 発送票の頁（G-3 Task 4・5・6）: 下書きの編集・発送確認と確定・確定後の記録・確定済みの票の取消。
 * 窓口（clientFetch）だけを差し替える。外す・追加は選択の全部を送って丸ごと入れ替える。
 */
const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));

function respond(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECOND_LINE = {
  orderId: ORDER_ID_2, orderItemId: ITEM_ID_2, itemName: 'ニットベスト', color: '黒', size: 'L',
  quantity: 1, readyQuantity: 4, unitPrice: 9800, isExchange: false,
};
const CANDIDATE = packingRow({ orderId: ORDER_ID_2, orderItemId: ITEM_ID_2, itemName: 'ニットベスト', color: '黒', size: 'L', readyQuantity: 4, shippableQuantity: 4, bundleOk: true, selectedQuantity: null });

type Draft = { expectedVersion: number; lines: Array<{ orderItemId: string; quantity: number }>; requestKey: string };
type State = {
  canCorrectDate?: boolean;
  slip: () => ShipmentSlipDetail;
  slipResponse?: () => Response | Promise<Response>;
  packing?: () => Response;
  draft?: (body: Draft) => Response | Promise<Response>;
  confirm?: (body: Record<string, unknown>) => Response | Promise<Response>;
  cancel?: (body: { expectedVersion: number; requestKey: string }) => Response | Promise<Response>;
  tracking?: (body: Record<string, unknown>) => Response | Promise<Response>;
  delivered?: (body: Record<string, unknown>) => Response | Promise<Response>;
  discard?: (body: { expectedVersion: number; requestKey: string }) => Response | Promise<Response>;
};

/** 荷作り表の成功の答えに canManage が無ければ true を足す（候補の読みは canManage を使わないが、窓口の答えの形は守る） */
async function withCanManage(answer: Response): Promise<Response> {
  const body: unknown = await answer.json();
  if (answer.ok && body !== null && typeof body === 'object' && !('canManage' in body)) return respond(answer.status, { canManage: true, ...body });
  return respond(answer.status, body);
}

function serve(state: State) {
  mockClientFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      if (target.endsWith('/confirm')) return state.confirm ? state.confirm(body) : respond(500, {});
      if (target.endsWith('/cancel')) return state.cancel ? state.cancel(body) : respond(500, {});
      if (target.endsWith('/tracking')) return state.tracking ? state.tracking(body) : respond(500, {});
      if (target.endsWith('/delivered')) return state.delivered ? state.delivered(body) : respond(500, {});
      if (target.endsWith('/draft')) return state.draft ? state.draft(body) : respond(200, { id: SLIP_ID, number: 'SL-20261025-0001', version: 2, replayed: false });
      return state.discard ? state.discard(body) : respond(200, { id: SLIP_ID, number: 'SL-20261025-0001', version: 2, replayed: false });
    }
    if (target.startsWith('/api/admin/packing')) {
      return withCanManage(state.packing ? state.packing() : respond(200, { rows: [], total: 0, page: 1, limit: 100 }));
    }
    return state.slipResponse ? state.slipResponse() : respond(200, { slip: state.slip(), canCorrectDate: state.canCorrectDate ?? false });
  });
}

const posts = () => mockClientFetch.mock.calls
  .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
  .map(([url, init]) => ({ url: String(url), body: JSON.parse(String((init as RequestInit).body)) as Record<string, unknown> }));
const slipReads = () => mockClientFetch.mock.calls.filter(([url, init]) => String(url) === `/api/admin/shipment-slips/${SLIP_ID}` && !(init as RequestInit | undefined)?.method);
const packingReads = () => mockClientFetch.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith('/api/admin/packing'));

const twoLines = () => draftDetail({ lines: [draftDetail().lines[0], SECOND_LINE], issues: [] });

beforeEach(() => {
  mockClientFetch.mockReset();
  window.sessionStorage.clear();
});

test.each([true, false])('FREQ-540-AC-10: サーバーの訂正権限%sでボタンと店長の説明を切り替える', async (canCorrectDate) => {
  serve({ slip: () => confirmedDetail(), canCorrectDate });
  render(<ShipmentSlipSection slipId={SLIP_ID} />);
  await screen.findByRole('heading', { name: '出荷日の履歴' });
  if (canCorrectDate) {
    fireEvent.click(screen.getByRole('button', { name: '出荷日を訂正する' }));
    expect(screen.getByRole('dialog', { name: '出荷日を訂正する' })).toBeInTheDocument();
    expect(screen.queryByText('出荷日の訂正は店長だけができます。')).not.toBeInTheDocument();
  } else {
    expect(screen.queryByRole('button', { name: '出荷日を訂正する' })).not.toBeInTheDocument();
    expect(screen.getByText('出荷日の訂正は店長だけができます。')).toBeInTheDocument();
  }
});
test('FREQ-535-AC-03: 日付履歴は初回と訂正の別・前後日付・理由・日時を表示する', async () => {
  const initial = confirmedDetail().dateHistory[0];
  serve({ slip: () => confirmedDetail({ dateHistory: [initial, { ...initial, version: 3, kind: 'correction', previousDate: '2026-10-25', newDate: '2026-10-24', reason: '記録の訂正' }] }) });
  render(<ShipmentSlipSection slipId={SLIP_ID} />);
  await screen.findByRole('heading', { name: '出荷日の履歴' });
  expect(screen.getByText(/初回.*2026-10-25 → 2026-10-25/)).toBeInTheDocument();
  expect(screen.getByText(/訂正.*2026-10-25 → 2026-10-24.*記録の訂正/)).toBeInTheDocument();
});

// G-4 Task 8: 発送票の注文番号は、注文の詳細（/admin/orders/{id}）への Link。履歴の dialog を荷作り表から開く入口は撤去した
describe('発送票の頁: 注文番号は注文の詳細への Link', () => {
  test('FREQ-539-AC-05: 発送票の注文番号が詳細への Link になり、票の操作〔配達済み・取消など〕は変わらない', async () => {
    serve({ slip: () => confirmedDetail() });
    render(<ShipmentSlipSection slipId={SLIP_ID} />);
    await screen.findByRole('heading', { name: '出荷日の履歴' });

    // 同梱する品物の表の注文ID
    const [row] = screen.getAllByTestId('slip-line');
    expect(within(row).getByRole('link')).toHaveAttribute('href', `/admin/orders/${ORDER_ID}`);
    expect(within(row).getByRole('link')).toHaveTextContent(toOrderNumber(ORDER_ID));
    // 注文ごとの発送の行（文字の並びは今までと同じ）
    const orderLine = `注文 ${toOrderNumber(ORDER_ID)} 発送（1回目） ${DELIVERY_STATUS_LABELS.in_transit}`;
    const line = screen.getByText((_content, element) => element?.tagName === 'P' && element.textContent === orderLine);
    expect(within(line).getByRole('link')).toHaveAttribute('href', `/admin/orders/${ORDER_ID}`);
    // 票の操作は変わらない
    for (const name of ['伝票番号を直す', '配達済みにする', '発送を取り消す']) expect(screen.getByRole('button', { name })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '配達済みにする' }));
    expect(await screen.findByRole('dialog', { name: '配達済みにする' })).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });

  test('FREQ-539-AC-05: 下書きの票でも、同梱する品物・追加の候補・発送票の確認の注文番号が、その行の注文の詳細へ向く', async () => {
    serve({ slip: () => draftDetail({ issues: [] }), packing: () => respond(200, { rows: [CANDIDATE], total: 1, page: 1, limit: 100 }) });
    render(<ShipmentSlipSection slipId={SLIP_ID} />);
    await screen.findByRole('heading', { level: 1 });

    const [line] = screen.getAllByTestId('slip-line');
    expect(within(line).getByRole('link')).toHaveAttribute('href', `/admin/orders/${ORDER_ID}`);
    const [candidate] = await screen.findAllByTestId('slip-candidate-row');
    expect(within(candidate).getByRole('link')).toHaveAttribute('href', `/admin/orders/${ORDER_ID_2}`);

    fireEvent.click(screen.getByRole('button', { name: '発送票確認' }));
    const heading = await screen.findByRole('heading', { name: /注文 ORD-/ });
    expect(within(heading).getByRole('link')).toHaveAttribute('href', `/admin/orders/${ORDER_ID}`);
  });
});

describe('発送票の頁: 下書きの表示', () => {
  test('FREQ-531-AC-03: 見出し「発送票 ${番号}」・状態「下書き」・同梱する品物・送り先を出し、票と追加の候補を読む', async () => {
    serve({ slip: () => twoLines(), packing: () => respond(200, { rows: [CANDIDATE], total: 1, page: 1, limit: 100 }) });
    render(<ShipmentSlipSection slipId={SLIP_ID} />);

    expect(screen.getByRole('status')).toHaveTextContent('読み込み中');
    expect(await screen.findByRole('heading', { level: 1, name: '発送票 SL-20261025-0001' })).toBeInTheDocument();
    expect(screen.getByTestId('slip-stage')).toHaveTextContent('下書き');
    expect(screen.queryByText('期限切れ')).not.toBeInTheDocument();
    expect(mockClientFetch).toHaveBeenCalledWith(`/api/admin/shipment-slips/${SLIP_ID}`, { cache: 'no-store' });
    await waitFor(() => expect(packingReads()).toEqual([`/api/admin/packing?slipId=${SLIP_ID}&limit=100&page=1`]));
    expect(screen.getByRole('link', { name: '荷作り表に戻る' })).toHaveAttribute('href', '/admin/packing');

    const [lines] = screen.getAllByRole('table');
    expect(within(lines).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      '注文ID', '顧客名', '商品名', '色', 'サイズ', '送る数', '今の準備中の数', '操作',
    ]);
    const rows = screen.getAllByTestId('slip-line');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getAllByRole('cell').map((cell) => cell.textContent)).toEqual([
      'ORD-11111111', '山田 花子', 'シルクブラウス', '白', 'M', '2', '3', 'この行を外す',
    ]);
    expect(within(rows[1]).getAllByRole('cell').map((cell) => cell.textContent)).toEqual([
      'ORD-11111111', '山田 花子', 'ニットベスト', '黒', 'L', '1', '4', 'この行を外す',
    ]);
    expect(screen.getByRole('heading', { level: 2, name: '同梱する品物' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: '品物を追加' })).toBeInTheDocument();
    const shipTo = screen.getByTestId('slip-ship-to');
    expect(screen.getByRole('heading', { level: 2, name: '送り先' })).toBeInTheDocument();
    expect(Array.from(shipTo.querySelectorAll('p')).map((line) => line.textContent)).toEqual(['山田 花子', '150-0001', '東京都渋谷区神南1-1-1', '03-0000-0000']);
    expect(screen.getByRole('button', { name: '下書きを破棄' })).toBeEnabled();
  });

  test('FREQ-535-AC-02: 荷物の情報はJSTの今日・未定・番号なし・通知オンで始まる', async () => {
    serve({ slip: () => twoLines() });
    render(<ShipmentSlipSection slipId={SLIP_ID} />);
    await screen.findByRole('heading', { level: 1 });
    expect(screen.getByLabelText('運送会社')).toHaveValue('');
    expect(screen.getByLabelText('伝票番号')).toHaveValue('');
    expect(screen.getByLabelText('出荷日')).toHaveValue(new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date()));
    expect(screen.getByLabelText('お客様に発送のメールを送る')).toBeChecked();
    expect(screen.getByRole('button', { name: '発送票確認' })).toBeEnabled();
  });

  test('FREQ-531-AC-02: 建物があれば送り先に出し、期限切れの下書きには「期限切れ」を付ける', async () => {
    serve({ slip: () => draftDetail({ expired: true, shipTo: { ...draftDetail().shipTo, building: 'ビル3F' } }) });
    render(<ShipmentSlipSection slipId={SLIP_ID} />);
    await screen.findByRole('heading', { level: 1 });

    expect(screen.getByTestId('slip-stage')).toHaveTextContent('下書き期限切れ');
    expect(within(screen.getByTestId('slip-ship-to')).getByText('ビル3F')).toBeInTheDocument();
  });

  test('FREQ-531-AC-02: issues は文にして出す。票全体の問題は表の上、行の問題はその行の下（同じ文は1回）', async () => {
    serve({
      slip: () => draftDetail({
        expired: true,
        lines: [draftDetail().lines[0], SECOND_LINE],
        issues: [
          { code: 'expired', orderItemId: null },
          { code: 'customer_mismatch', orderItemId: null },
          { code: 'quantity_exceeds_ready', orderItemId: ITEM_ID },
          { code: 'address_incomplete', orderItemId: ITEM_ID },
          { code: 'payment_review', orderItemId: ITEM_ID_2 },
          { code: 'variant_missing', orderItemId: ITEM_ID_2 },
          { code: 'paid_at_missing', orderItemId: ITEM_ID_2 },
          { code: 'exchange_fee_waiting', orderItemId: ITEM_ID_2 },
          { code: 'order_not_shippable', orderItemId: ITEM_ID_2 },
        ],
      }),
    });
    render(<ShipmentSlipSection slipId={SLIP_ID} />);
    await screen.findByRole('heading', { level: 1 });

    const slipLevel = screen.getByTestId('slip-issues');
    expect(Array.from(slipLevel.querySelectorAll('p')).map((line) => line.textContent)).toEqual([
      '下書きの期限が切れました。品物を選び直してください。',
      '同じお客様の注文だけを同梱できます。会員は同じ会員、ゲストは同じメールアドレスの注文に限ります。',
    ]);
    const notes = screen.getAllByTestId('slip-line-note');
    expect(notes).toHaveLength(2);
    expect(Array.from(notes[0].querySelectorAll('p')).map((line) => line.textContent)).toEqual([
      '発送準備中の数を超えています。荷作り表を読み直してください。',
      '配送先の情報が足りない注文は発送できません。',
    ]);
    expect(Array.from(notes[1].querySelectorAll('p')).map((line) => line.textContent)).toEqual([
      '支払額の確認が済むまで発送できません。',
      '色・サイズが確定していないため選べません',
      '入金日時が記録されていないため選べません',
      '交換手数料のお支払いを待っているため発送できません。',
      '入金が確認できていない注文は発送できません。',
    ]);
    // 文は、その品物の行のすぐ下に出る
    const rows = screen.getAllByTestId('slip-line');
    expect(rows[0].nextElementSibling).toBe(notes[0]);
    expect(rows[1].nextElementSibling).toBe(notes[1]);
  });

  test('FREQ-531-AC-02: 問題が無ければ文の欄を足さない', async () => {
    serve({ slip: () => twoLines() });
    render(<ShipmentSlipSection slipId={SLIP_ID} />);
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByTestId('slip-issues')).not.toBeInTheDocument();
    expect(screen.queryAllByTestId('slip-line-note')).toHaveLength(0);
  });

  test('FREQ-531-AC-03: 荷作り表から移ってきた直後は「下書きを保存しました。」を1回だけ出す', async () => {
    rememberSlipNotice(SLIP_ID);
    serve({ slip: () => twoLines() });
    const { unmount } = render(<ShipmentSlipSection slipId={SLIP_ID} />);
    expect(await screen.findByText('下書きを保存しました。')).toBeInTheDocument();
    unmount();
    render(<ShipmentSlipSection slipId={SLIP_ID} />);
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText('下書きを保存しました。')).not.toBeInTheDocument();
  });

  test('FREQ-531-AC-03: 他の票の通知の印は消さず、この票には出さない', async () => {
    rememberSlipNotice('99999999-9999-4999-8999-999999999999');
    serve({ slip: () => twoLines() });
    render(<ShipmentSlipSection slipId={SLIP_ID} />);
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText('下書きを保存しました。')).not.toBeInTheDocument();
    expect(window.sessionStorage.length).toBe(1);
  });
});

describe('発送票の頁: 行を外す・品物を追加', () => {
  test('FREQ-531-AC-03: 「この行を外す」は、残る行の全部を expectedVersion・requestKey と一緒に POST …/draft へ送り、成功で通知して読み直す', async () => {
    let slip = twoLines();
    serve({
      slip: () => slip,
      draft: () => {
        slip = draftDetail({ version: 2, lines: [slip.lines[1]], issues: [] });
        return respond(200, { id: SLIP_ID, number: 'SL-20261025-0001', version: 2, replayed: false });
      },
    });
    render(<ShipmentSlipSection slipId={SLIP_ID} />);
    await screen.findByRole('heading', { level: 1 });

    fireEvent.click(within(screen.getAllByTestId('slip-line')[0]).getByRole('button', { name: 'この行を外す' }));

    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].url).toBe(`/api/admin/shipment-slips/${SLIP_ID}/draft`);
    expect(posts()[0].body).toEqual({ expectedVersion: 1, lines: [{ orderItemId: ITEM_ID_2, quantity: 1 }], requestKey: expect.stringMatching(UUID) });
    expect(await screen.findByText('下書きを保存しました。')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByTestId('slip-line')).toHaveLength(1));
    expect(within(screen.getAllByTestId('slip-line')[0]).getByText('ニットベスト')).toBeInTheDocument();
    expect(slipReads()).toHaveLength(2);
  });

  test('FREQ-531-AC-03: 追加の候補は、同梱できる行（bundleOk）で、まだ選んでいない、選べる行だけ。他は出さない', async () => {
    serve({
      slip: () => draftDetail({ issues: [] }),
      packing: () => respond(200, {
        rows: [
          packingRow({ selectedQuantity: 2, bundleOk: true }),
          CANDIDATE,
          packingRow({ orderItemId: '22222222-2222-4222-8222-222222222233', itemName: '別のお客様の品', bundleOk: false }),
          packingRow({ orderItemId: '22222222-2222-4222-8222-222222222234', itemName: '確認待ちの品', blockedReasons: ['payment_review'], shippableQuantity: 0 }),
        ],
        total: 4, page: 1, limit: 100,
      }),
    });
    render(<ShipmentSlipSection slipId={SLIP_ID} />);
    await screen.findByRole('heading', { level: 1 });

    const candidates = await screen.findAllByTestId('slip-candidate-row');
    expect(candidates).toHaveLength(1);
    expect(within(candidates[0]).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['', 'ORD-11111111', 'ニットベスト', '黒', 'L', '4']);
    expect(screen.getByRole('button', { name: '追加' })).toBeDisabled();
  });

  test('FREQ-531-AC-03: 候補を選んで「追加」を押すと、今の行に選んだ行（送る数は準備中の数）を足して POST …/draft へ送る', async () => {
    let slip = draftDetail({ issues: [] });
    serve({
      slip: () => slip,
      packing: () => respond(200, { rows: [CANDIDATE], total: 1, page: 1, limit: 100 }),
      draft: () => {
        slip = draftDetail({ version: 2, lines: [slip.lines[0], { ...SECOND_LINE, quantity: 4 }], issues: [] });
        return respond(200, { id: SLIP_ID, number: 'SL-20261025-0001', version: 2, replayed: false });
      },
    });
    render(<ShipmentSlipSection slipId={SLIP_ID} />);
    await screen.findByRole('heading', { level: 1 });

    fireEvent.click(await screen.findByRole('checkbox', { name: 'ニットベスト 黒 L を選ぶ' }));
    expect(screen.getByRole('button', { name: '追加' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '追加' }));

    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toEqual({
      expectedVersion: 1,
      lines: [{ orderItemId: ITEM_ID, quantity: 2 }, { orderItemId: ITEM_ID_2, quantity: 4 }],
      requestKey: expect.stringMatching(UUID),
    });
    expect(await screen.findByText('下書きを保存しました。')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByTestId('slip-line')).toHaveLength(2));
    // 版が進んだので候補を読み直す
    await waitFor(() => expect(packingReads()).toHaveLength(2));
  });

  test('FREQ-531-AC-03: 送っている間は外す・追加・破棄を止め、二重に押しても窓口は1回', async () => {
    let release: () => void = () => {};
    serve({
      slip: () => twoLines(),
      packing: () => respond(200, { rows: [CANDIDATE], total: 1, page: 1, limit: 100 }),
      draft: () => new Promise<Response>((resolve) => {
        release = () => resolve(respond(200, { id: SLIP_ID, number: 'SL-20261025-0001', version: 2, replayed: false }));
      }),
    });
    render(<ShipmentSlipSection slipId={SLIP_ID} />);
    await screen.findByRole('heading', { level: 1 });

    const [remove] = screen.getAllByRole('button', { name: 'この行を外す' });
    fireEvent.click(remove);
    fireEvent.click(remove);
    await waitFor(() => expect(posts()).toHaveLength(1));
    for (const button of screen.getAllByRole('button', { name: 'この行を外す' })) expect(button).toBeDisabled();
    expect(screen.getByRole('button', { name: '下書きを破棄' })).toBeDisabled();
    release();
    expect(await screen.findByText('下書きを保存しました。')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'この行を外す' })[0]).toBeEnabled());
    expect(posts()).toHaveLength(1);
  });

  test('FREQ-531-AC-03: 版が違って断られた（409）時は表の文を出し、選んだ候補はそのまま保ち、票を読み直す。次に送る版は新しい版', async () => {
    let slip = draftDetail({ issues: [] });
    let calls = 0;
    serve({
      slip: () => slip,
      packing: () => respond(200, { rows: [CANDIDATE], total: 1, page: 1, limit: 100 }),
      draft: () => {
        calls += 1;
        if (calls === 1) {
          // 別の人が先に保存して、票の版が進んだ
          slip = draftDetail({ version: 2, issues: [] });
          return respond(409, { code: 'GROUP_G_SLIP_VERSION_CONFLICT', error: '発送票が更新されました。内容を確認して、もう一度送ってください。' });
        }
        return respond(200, { id: SLIP_ID, number: 'SL-20261025-0001', version: 3, replayed: false });
      },
    });
    render(<ShipmentSlipSection slipId={SLIP_ID} />);
    await screen.findByRole('heading', { level: 1 });

    fireEvent.click(await screen.findByRole('checkbox', { name: 'ニットベスト 黒 L を選ぶ' }));
    fireEvent.click(screen.getByRole('button', { name: '追加' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('発送票が更新されました。内容を確認して、もう一度送ってください。');
    await waitFor(() => expect(slipReads()).toHaveLength(2));
    // 候補の選択は保たれ、そのまま押し直せる
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'ニットベスト 黒 L を選ぶ' })).toBeChecked());
    await waitFor(() => expect(screen.getByRole('button', { name: '追加' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '追加' }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[0].body.expectedVersion).toBe(1);
    expect(posts()[1].body.expectedVersion).toBe(2);
    expect(posts()[1].body.requestKey).not.toBe(posts()[0].body.requestKey);
    expect(posts()[1].body.lines).toEqual(posts()[0].body.lines);
  });

  test('FREQ-531-AC-03: 同じ内容の再押下は同じ requestKey（処理の前の断り 429 の後）。内容を変えたら新しい requestKey', async () => {
    let calls = 0;
    serve({
      slip: () => twoLines(),
      draft: () => {
        calls += 1;
        return calls === 1 ? respond(429, { error: 'Too many requests' }) : respond(200, { id: SLIP_ID, number: 'SL-20261025-0001', version: 2, replayed: false });
      },
    });
    render(<ShipmentSlipSection slipId={SLIP_ID} />);
    await screen.findByRole('heading', { level: 1 });

    const first = () => screen.getAllByRole('button', { name: 'この行を外す' })[0];
    fireEvent.click(first());
    expect(await screen.findByRole('alert')).toHaveTextContent('操作が続いたため受け付けませんでした。しばらく待ってから、もう一度お試しください。');
    await waitFor(() => expect(first()).toBeEnabled());
    fireEvent.click(first());
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1].body).toEqual(posts()[0].body);
  });

  test('FREQ-533-AC-03: 結果が分からない（500）時は、入力を止めて「もう一度確かめる」を出し、同じ requestKey と同じ本文で送り直す。「戻る」は読み直す', async () => {
    let calls = 0;
    serve({
      slip: () => twoLines(),
      draft: () => {
        calls += 1;
        return calls === 1 ? respond(500, { error: '発送の記録に失敗しました' }) : respond(200, { id: SLIP_ID, number: 'SL-20261025-0001', version: 2, replayed: true });
      },
    });
    render(<ShipmentSlipSection slipId={SLIP_ID} />);
    await screen.findByRole('heading', { level: 1 });

    fireEvent.click(screen.getAllByRole('button', { name: 'この行を外す' })[0]);
    expect(await screen.findByText('結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。')).toBeInTheDocument();
    for (const button of screen.getAllByRole('button', { name: 'この行を外す' })) expect(button).toBeDisabled();
    expect(screen.getByRole('button', { name: '下書きを破棄' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'もう一度確かめる' }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1].body).toEqual(posts()[0].body);
    expect(await screen.findByText('下書きを保存しました。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'もう一度確かめる' })).not.toBeInTheDocument();
  });

  test('FREQ-533-AC-03: 結果が分からないまま「戻る」を押すと、票を読み直して入力を戻す', async () => {
    serve({ slip: () => twoLines(), draft: () => respond(500, {}) });
    render(<ShipmentSlipSection slipId={SLIP_ID} />);
    await screen.findByRole('heading', { level: 1 });

    fireEvent.click(screen.getAllByRole('button', { name: 'この行を外す' })[0]);
    await screen.findByRole('button', { name: 'もう一度確かめる' });
    fireEvent.click(screen.getByRole('button', { name: '戻る' }));
    await waitFor(() => expect(slipReads()).toHaveLength(2));
    expect(screen.queryByRole('button', { name: 'もう一度確かめる' })).not.toBeInTheDocument();
    for (const button of screen.getAllByRole('button', { name: 'この行を外す' })) expect(button).toBeEnabled();
  });

  test('FREQ-532-AC-01: 同梱できない・数が足りないなどで断られた（409）時は、DB の表の文を出す（生の文は出さない）', async () => {
    serve({
      slip: () => twoLines(),
      draft: () => respond(409, { code: 'GROUP_G_SLIP_CUSTOMER_MISMATCH', error: 'PRIVATE-MARKER' }),
    });
    render(<ShipmentSlipSection slipId={SLIP_ID} />);
    await screen.findByRole('heading', { level: 1 });

    fireEvent.click(screen.getAllByRole('button', { name: 'この行を外す' })[0]);
    expect(await screen.findByRole('alert')).toHaveTextContent('同じお客様の注文だけを同梱できます。会員は同じ会員、ゲストは同じメールアドレスの注文に限ります。');
    expect(document.body).not.toHaveTextContent('PRIVATE-MARKER');
  });

  test('FREQ-531-AC-03: 最後の1行を外そうとすると、窓口へは送らず「品物を選んでください。」を出す。行は残り、別の行を外す・破棄は続けてできる', async () => {
    serve({ slip: () => draftDetail({ issues: [] }) });
    render(<ShipmentSlipSection slipId={SLIP_ID} />);
    await screen.findByRole('heading', { level: 1 });

    fireEvent.click(screen.getByRole('button', { name: 'この行を外す' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('品物を選んでください。');
    expect(screen.getAllByText('品物を選んでください。')).toHaveLength(1);
    expect(posts()).toHaveLength(0);
    expect(screen.getAllByTestId('slip-line')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'この行を外す' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '下書きを破棄' })).toBeEnabled();
  });

  test('FREQ-531-AC-03: 最後の1行を外せない文は、次に何かを送ると消える', async () => {
    serve({ slip: () => draftDetail({ issues: [] }), packing: () => respond(200, { rows: [CANDIDATE], total: 1, page: 1, limit: 100 }) });
    render(<ShipmentSlipSection slipId={SLIP_ID} />);
    await screen.findByRole('heading', { level: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'この行を外す' }));
    expect(await screen.findByText('品物を選んでください。')).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('checkbox', { name: 'ニットベスト 黒 L を選ぶ' }));
    fireEvent.click(screen.getByRole('button', { name: '追加' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(screen.queryByText('品物を選んでください。')).not.toBeInTheDocument();
  });

  test('FREQ-531-AC-03: DB が「品物を選んでください。」（GROUP_G_SLIP_EMPTY）で断った時も、その文を出す（他の画面や直接の呼び出しで空にされた場合）', async () => {
    serve({
      slip: () => twoLines(),
      draft: () => respond(400, { code: 'GROUP_G_SLIP_EMPTY', error: '品物を選んでください。' }),
    });
    render(<ShipmentSlipSection slipId={SLIP_ID} />);
    await screen.findByRole('heading', { level: 1 });

    fireEvent.click(screen.getAllByRole('button', { name: 'この行を外す' })[0]);
    expect(await screen.findByRole('alert')).toHaveTextContent('品物を選んでください。');
    expect(posts()).toHaveLength(1);
  });

  test('FREQ-540-AC-10: 外す・追加の返事が CSRF の失敗の 403 の時は、再読み込みを促す文を出す（権限が無い文にはしない）', async () => {
    serve({ slip: () => twoLines(), draft: () => respond(403, { error: 'Forbidden', reason: 'CSRF validation failed' }) });
    render(<ShipmentSlipSection slipId={SLIP_ID} />);
    await screen.findByRole('heading', { level: 1 });

    fireEvent.click(screen.getAllByRole('button', { name: 'この行を外す' })[0]);
    expect(await screen.findByRole('alert')).toHaveTextContent('セキュリティ確認に失敗しました。ページを再読み込みして、もう一度送ってください。');
    expect(document.body).not.toHaveTextContent('発送を扱う権限がありません。');
  });

  test('FREQ-531-AC-03: 候補が無ければ「追加できる品物はありません。」。候補が読めなければ失敗の文', async () => {
    serve({ slip: () => twoLines() });
    const { unmount } = render(<ShipmentSlipSection slipId={SLIP_ID} />);
    expect(await screen.findByText('追加できる品物はありません。')).toBeInTheDocument();
    unmount();

    serve({ slip: () => twoLines(), packing: () => respond(500, { error: 'x' }) });
    render(<ShipmentSlipSection slipId={SLIP_ID} />);
    expect(await screen.findByText('荷作り表を読み込めませんでした。')).toBeInTheDocument();
  });

  test('FREQ-531-AC-03: 候補は頁を送って全部読む（100件ずつ）', async () => {
    mockClientFetch.mockImplementation(async (url: string) => {
      const target = String(url);
      if (target.startsWith('/api/admin/packing')) {
        const page = Number(new URL(target, 'https://example.test').searchParams.get('page'));
        const rows = page === 1
          ? Array.from({ length: 100 }, (_, index) => packingRow({ orderItemId: `44444444-4444-4444-8444-4444444444${String(index).padStart(2, '0')}`, itemName: `候補${index}`, selectedQuantity: 1 }))
          : [CANDIDATE];
        return respond(200, { rows, total: 101, page, limit: 100, canManage: true });
      }
      return respond(200, { slip: twoLines(), canCorrectDate: false });
    });
    render(<ShipmentSlipSection slipId={SLIP_ID} />);
    await screen.findByRole('heading', { level: 1 });

    expect(await screen.findByRole('checkbox', { name: 'ニットベスト 黒 L を選ぶ' })).toBeInTheDocument();
    expect(packingReads()).toEqual([`/api/admin/packing?slipId=${SLIP_ID}&limit=100&page=1`, `/api/admin/packing?slipId=${SLIP_ID}&limit=100&page=2`]);
  });
});

describe('発送票の頁: 下書きを破棄', () => {
  test('FREQ-531-AC-03: 「下書きを破棄」は確かめのダイアログ（「この下書きを破棄しますか。」「破棄する」「戻る」）を開く。「戻る」では何も送らない', async () => {
    serve({ slip: () => twoLines() });
    render(<ShipmentSlipSection slipId={SLIP_ID} />);
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '下書きを破棄' }));
    const dialog = screen.getByRole('dialog', { name: 'この下書きを破棄しますか。' });
    expect(within(dialog).getByRole('heading', { name: 'この下書きを破棄しますか。' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '破棄する' })).toBeEnabled();
    fireEvent.click(within(dialog).getByRole('button', { name: '戻る' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });

  test('FREQ-531-AC-03: 「破棄する」で POST …/discard へ expectedVersion・requestKey を送り、成功で票を読み直して「破棄済み」にする（編集の操作は消える）', async () => {
    let slip: ShipmentSlipDetail = twoLines();
    serve({
      slip: () => slip,
      discard: () => {
        slip = { ...twoLines(), stage: 'discarded', version: 2, expiresAt: null };
        return respond(200, { id: SLIP_ID, number: 'SL-20261025-0001', version: 2, replayed: false });
      },
    });
    render(<ShipmentSlipSection slipId={SLIP_ID} />);
    await screen.findByRole('heading', { level: 1 });

    fireEvent.click(screen.getByRole('button', { name: '下書きを破棄' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '破棄する' }));

    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].url).toBe(`/api/admin/shipment-slips/${SLIP_ID}/discard`);
    expect(posts()[0].body).toEqual({ expectedVersion: 1, requestKey: expect.stringMatching(UUID) });
    await waitFor(() => expect(screen.getByTestId('slip-stage')).toHaveTextContent('破棄済み'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'この行を外す' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '下書きを破棄' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2, name: '品物を追加' })).not.toBeInTheDocument();
  });

  test('FREQ-531-AC-03: 破棄が断られた（409）時はダイアログを閉じて文を出し、票を読み直す', async () => {
    serve({ slip: () => twoLines(), discard: () => respond(409, { code: 'GROUP_G_SLIP_VERSION_CONFLICT', error: 'x' }) });
    render(<ShipmentSlipSection slipId={SLIP_ID} />);
    await screen.findByRole('heading', { level: 1 });

    fireEvent.click(screen.getByRole('button', { name: '下書きを破棄' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '破棄する' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('発送票が更新されました。内容を確認して、もう一度送ってください。');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(slipReads()).toHaveLength(2));
  });

  test('FREQ-533-AC-03: 破棄の結果が分からない時はダイアログを閉じ、「もう一度確かめる」で同じ requestKey のまま確かめ直す', async () => {
    let calls = 0;
    serve({
      slip: () => twoLines(),
      discard: () => {
        calls += 1;
        return calls === 1 ? respond(503, {}) : respond(200, { id: SLIP_ID, number: 'SL-20261025-0001', version: 2, replayed: true });
      },
    });
    render(<ShipmentSlipSection slipId={SLIP_ID} />);
    await screen.findByRole('heading', { level: 1 });

    fireEvent.click(screen.getByRole('button', { name: '下書きを破棄' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '破棄する' }));
    fireEvent.click(await screen.findByRole('button', { name: 'もう一度確かめる' }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1].body).toEqual(posts()[0].body);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(slipReads()).toHaveLength(2));
  });
});

describe('発送票の頁: 下書き以外・読み込みの失敗', () => {
  test('FREQ-533-AC-01: 発送済みの票は状態「発送済み」で、品物の表と送り先だけ。外す・追加・破棄は出さず、候補も読まない', async () => {
    serve({ slip: () => confirmedDetail({ lines: [draftDetail().lines[0]] }) });
    render(<ShipmentSlipSection slipId={SLIP_ID} />);
    await screen.findByRole('heading', { level: 1, name: '発送票 SL-20261025-0001' });

    expect(screen.getByTestId('slip-stage')).toHaveTextContent('発送済み');
    expect(within(screen.getAllByRole('table')[0]).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      '注文ID', '顧客名', '商品名', '色', 'サイズ', '送る数', '今の準備中の数',
    ]);
    expect(screen.queryByRole('button', { name: 'この行を外す' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '下書きを破棄' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2, name: '品物を追加' })).not.toBeInTheDocument();
    expect(screen.queryAllByTestId('slip-line-note')).toHaveLength(0);
    expect(packingReads()).toEqual([]);
  });

  test.each([
    [404, { code: 'GROUP_G_SLIP_NOT_FOUND', error: '発送票が見つかりません。' }, '発送票が見つかりません。'],
    [403, { error: 'Forbidden', permission: 'admin.shipping.read', role: 'supporter' }, '発送票を見る権限がありません。'],
    [401, { error: 'Unauthorized' }, 'ログインし直してください。'],
    [403, { error: 'Forbidden', reason: 'MFA required' }, '2要素認証が必要です'],
    [500, { error: '発送の記録に失敗しました' }, '発送票を読み込めませんでした。'],
  ])('FREQ-531-AC-04: 読み込みの失敗 %s は文を出し、荷作り表へ戻るリンクだけを出す', async (status, body, message) => {
    serve({ slip: () => twoLines(), slipResponse: () => respond(status, body) });
    render(<ShipmentSlipSection slipId={SLIP_ID} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('link', { name: '荷作り表に戻る' })).toHaveAttribute('href', '/admin/packing');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(packingReads()).toEqual([]);
  });

  test('FREQ-531-AC-04: 応答が崩れていても通信が切れても、中身を出さず「発送票を読み込めませんでした。」', async () => {
    serve({ slip: () => twoLines(), slipResponse: () => respond(200, { slip: { id: 'PRIVATE-MARKER' } }) });
    const { unmount } = render(<ShipmentSlipSection slipId={SLIP_ID} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('発送票を読み込めませんでした。');
    expect(document.body).not.toHaveTextContent('PRIVATE-MARKER');
    unmount();

    mockClientFetch.mockRejectedValue(new Error('PRIVATE-MARKER'));
    render(<ShipmentSlipSection slipId={SLIP_ID} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('発送票を読み込めませんでした。');
    expect(document.body).not.toHaveTextContent('PRIVATE-MARKER');
  });

  test('FREQ-531-AC-01: 表は見出しを保ったスクロール領域に入れ、頁全体を横にはみ出させない（クラスの確認。390/768/1280 の実測は E2E）', async () => {
    serve({ slip: () => twoLines(), packing: () => respond(200, { rows: [CANDIDATE], total: 1, page: 1, limit: 100 }) });
    const { container } = render(<ShipmentSlipSection slipId={SLIP_ID} />);
    await screen.findByRole('heading', { level: 1 });
    await screen.findAllByTestId('slip-candidate-row');

    expect(container.firstElementChild?.className).toMatch(/min-w-0/);
    expect(container.firstElementChild?.className).toMatch(/max-w-full/);
    const regions = Array.from(container.querySelectorAll('div[role="region"]'));
    expect(regions).toHaveLength(2);
    for (const region of regions) {
      expect(region).toHaveAttribute('tabindex', '0');
      expect(region.className).toMatch(/overflow-auto/);
      expect(region.className).toMatch(/max-w-full/);
      expect(region.querySelector('table')).not.toBeNull();
      expect(region).toHaveAccessibleName();
    }
    for (const cell of container.querySelectorAll('th')) expect(cell.className).toMatch(/sticky/);
  });
});

describe('発送確定', () => {
  const open = async () => {
    render(<ShipmentSlipSection slipId={SLIP_ID} />);
    await screen.findByRole('button', { name: '発送票確認' });
    fireEvent.click(screen.getByRole('button', { name: '発送票確認' }));
    await screen.findByRole('heading', { name: '発送票の確認' });
  };
  test('FREQ-533-AC-01: 確認は注文ごとの商品・送り先・荷物の情報を表示し、戻るで入力を保つ', async () => {
    serve({ slip: () => twoLines() });
    await open();
    expect(screen.getAllByRole('heading', { name: /注文 ORD-/ })).toHaveLength(2);
    expect(screen.getByText('ニットベスト 黒 L ×1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '発送確定' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '戻る' }));
    expect(screen.getByLabelText('お客様に発送のメールを送る')).toBeChecked();
  });
  test('FREQ-533-AC-03: 二重押下は通信1回、結果不明の再確認は同じ本文・requestKeyで、成功後に確定済みへ読む', async () => {
    let finish: (r: Response) => void = () => {};
    let current = twoLines(); let attempts = 0;
    serve({ slip: () => current, confirm: () => {
      attempts += 1;
      if (attempts === 1) return new Promise<Response>((resolve) => { finish = resolve; });
      current = confirmedDetail();
      return respond(200, { id: SLIP_ID, number: current.number, version: 2, shipmentDate: '2026-10-25', fulfillments: [{ orderId: current.lines[0].orderId, fulfillmentId: current.orders[0].fulfillmentId, number: 1, completesOrder: true }], replayed: true });
    } });
    await open();
    const submit = screen.getByRole('button', { name: '発送確定' });
    fireEvent.click(submit); fireEvent.click(submit);
    expect(posts()).toHaveLength(1);
    finish(respond(500, {}));
    fireEvent.click(await screen.findByRole('button', { name: 'もう一度確かめる' }));
    await screen.findByText('発送を確定しました。');
    expect(posts()).toHaveLength(2);
    expect(posts()[0].body.requestKey).toMatch(UUID);
    expect(posts()[1]).toEqual(posts()[0]);
    await waitFor(() => expect(screen.getByTestId('slip-stage')).toHaveTextContent('発送済み'));
  });
  test('FREQ-533-AC-03: 版競合後も入力を保ち、変更した内容の次の確認は新しいrequestKey', async () => {
    let current = twoLines();
    serve({ slip: () => current, confirm: () => {
      current = twoLines(); current.version = 2;
      return respond(409, { code: 'GROUP_G_SLIP_VERSION_CONFLICT' });
    } });
    render(<ShipmentSlipSection slipId={SLIP_ID} />);
    await screen.findByLabelText('伝票番号');
    fireEvent.change(screen.getByLabelText('伝票番号'), { target: { value: 'abc-123' } });
    fireEvent.change(screen.getByLabelText('運送会社'), { target: { value: 'yamato' } });
    fireEvent.change(screen.getByLabelText('出荷日'), { target: { value: '2026-10-24' } });
    fireEvent.click(screen.getByLabelText('お客様に発送のメールを送る'));
    fireEvent.click(screen.getByRole('button', { name: '発送票確認' }));
    fireEvent.click(screen.getByRole('button', { name: '発送確定' }));
    await screen.findByText('発送票が更新されました。内容を確認して、もう一度送ってください。');
    await waitFor(() => expect(slipReads()).toHaveLength(2));
    expect(screen.queryByRole('heading', { name: '発送票の確認' })).not.toBeInTheDocument();
    expect(screen.getAllByTestId('slip-line')).toHaveLength(2);
    expect(screen.getByLabelText('伝票番号')).toHaveValue('abc-123');
    expect(screen.getByLabelText('運送会社')).toHaveValue('yamato');
    expect(screen.getByLabelText('出荷日')).toHaveValue('2026-10-24');
    expect(screen.getByLabelText('お客様に発送のメールを送る')).not.toBeChecked();
    fireEvent.change(screen.getByLabelText('伝票番号'), { target: { value: 'abc-456' } });
    fireEvent.click(screen.getByRole('button', { name: '発送票確認' }));
    fireEvent.click(screen.getByRole('button', { name: '発送確定' }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1].body).toMatchObject({ expectedVersion: 2, trackingNumber: 'abc-456', carrier: 'yamato', shipmentDate: '2026-10-24', notifyCustomer: false });
    expect(posts()[1].body.requestKey).not.toBe(posts()[0].body.requestKey);
  });
  test.each([
    ['GROUP_G_SLIP_QUANTITY_EXCEEDS_READY', 'quantity_exceeds_ready', '発送準備中の数を超えています。荷作り表を読み直してください。'],
    ['GROUP_G_SLIP_PAYMENT_REVIEW_REQUIRED', 'payment_review', '支払額の確認が済むまで発送できません。'],
    ['GROUP_G_SLIP_DRAFT_EXPIRED', 'expired', '下書きの期限が切れました。品物を選び直してください。'],
  ] as const)('FREQ-533-AC-01: 再検証で%sなら確認を閉じ、読み直した表と問題を出して再確定を止める', async (code, issue, message) => {
    let current = twoLines();
    serve({ slip: () => current, confirm: () => {
      current = draftDetail({ issues: [{ code: issue, orderItemId: issue === 'expired' ? null : ITEM_ID }], expired: issue === 'expired' });
      return respond(409, { code });
    } });
    await open();
    fireEvent.click(screen.getByRole('button', { name: '発送確定' }));
    await waitFor(() => expect(slipReads()).toHaveLength(2));
    expect(await screen.findByRole('table')).toBeInTheDocument();
    const issues = issue === 'expired' ? screen.getByTestId('slip-issues') : screen.getByTestId('slip-line-note');
    expect(issues).toHaveTextContent(message);
    expect(screen.queryByRole('heading', { name: '発送票の確認' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '発送確定' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '発送票確認' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '発送票確認' }));
    expect(posts()).toHaveLength(1);
  });
  test('FREQ-533-AC-03: NOT_DRAFTなら確認を閉じ、読み直した発送済みの表を出す', async () => {
    let current = twoLines();
    serve({ slip: () => current, confirm: () => {
      current = confirmedDetail();
      return respond(409, { code: 'GROUP_G_SLIP_NOT_DRAFT' });
    } });
    await open();
    fireEvent.click(screen.getByRole('button', { name: '発送確定' }));
    await waitFor(() => expect(screen.getByTestId('slip-stage')).toHaveTextContent('発送済み'));
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '発送確定' })).not.toBeInTheDocument();
  });
  test('FREQ-533-AC-01: 確定拒否後の再読込が終わるまでは古い票で確認へ戻れない', async () => {
    let reads = 0;
    let finishRead: (response: Response) => void = () => {};
    serve({
      slip: () => twoLines(),
      slipResponse: () => ++reads === 1 ? respond(200, { slip: twoLines(), canCorrectDate: false }) : new Promise<Response>((resolve) => { finishRead = resolve; }),
      confirm: () => respond(409, { code: 'GROUP_G_SLIP_QUANTITY_EXCEEDS_READY' }),
    });
    await open();
    fireEvent.click(screen.getByRole('button', { name: '発送確定' }));
    await waitFor(() => expect(slipReads()).toHaveLength(2));
    expect(screen.getByRole('status')).toHaveTextContent('読み込み中');
    expect(screen.queryByRole('button', { name: '発送票確認' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '発送確定' })).not.toBeInTheDocument();
    finishRead(respond(200, { slip: draftDetail(), canCorrectDate: false }));
    expect(await screen.findByTestId('slip-line-note')).toHaveTextContent('発送準備中の数を超えています。荷作り表を読み直してください。');
    expect(screen.getByRole('button', { name: '発送票確認' })).toBeDisabled();
  });
  test('FREQ-535-AC-02: 発送した時刻・出荷日の履歴・荷物の履歴は日本時間で日付をまたいで表示する', async () => {
    const detail = confirmedDetail();
    serve({ slip: () => confirmedDetail({
      confirmedAt: '2026-10-25T16:20:00Z',
      dateHistory: [{ ...detail.dateHistory[0], createdAt: '2026-10-25T17:30:00Z' }],
      versions: [{ ...detail.versions[0], createdAt: '2026-10-25T18:40:00Z' }],
    }) });
    render(<ShipmentSlipSection slipId={SLIP_ID} />);
    const record = await screen.findByRole('region', { name: '発送の記録' });
    expect(within(record).getByText('発送した時刻: 2026/10/26 01:20')).toBeInTheDocument();
    expect(within(record).getByRole('heading', { name: '出荷日の履歴' }).nextElementSibling).toHaveTextContent('2026/10/26 02:30');
    expect(within(record).getByRole('heading', { name: '荷物の履歴' }).nextElementSibling).toHaveTextContent('2026/10/26 03:40');
    expect(record).not.toHaveTextContent(/2026-10-25T/);
  });
  test('FREQ-533-AC-01: issuesがある下書きは確認不可', async () => {
    serve({ slip: () => draftDetail({ issues: [{ code: 'quantity_exceeds_ready', orderItemId: ITEM_ID }] }) });
    render(<ShipmentSlipSection slipId={SLIP_ID} />);
    expect(await screen.findByRole('button', { name: '発送票確認' })).toBeDisabled();
  });
  test('FREQ-540-AC-10: 確定の403は固定の文を出す', async () => {
    serve({ slip: () => twoLines(), confirm: () => respond(403, { code: 'GROUP_G_FORBIDDEN' }) });
    await open(); fireEvent.click(screen.getByRole('button', { name: '発送確定' }));
    expect(await screen.findByText('発送を扱う権限がありません。')).toBeInTheDocument();
  });
});

describe('発送の取消', () => {
  const cancelled = (version = 3) => ({ id: SLIP_ID, version, restoredQuantity: 4, replayed: false });
  const openDialog = async () => {
    render(<ShipmentSlipSection slipId={SLIP_ID} />);
    fireEvent.click(await screen.findByRole('button', { name: '発送を取り消す' }));
    return screen.findByRole('dialog', { name: '発送を取り消す' });
  };

  test('FREQ-534-AC-03: 「発送を取り消す」は確定済みの票だけに出す（下書き・取消済みには出さない）', async () => {
    serve({ slip: () => draftDetail() });
    const { unmount } = render(<ShipmentSlipSection slipId={SLIP_ID} />);
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('button', { name: '発送を取り消す' })).not.toBeInTheDocument();
    unmount();

    serve({ slip: () => confirmedDetail({ stage: 'cancelled', cancelledAt: '2026-10-25T05:00:00+00:00', cancelBlockers: [] }) });
    render(<ShipmentSlipSection slipId={SLIP_ID} />);
    await waitFor(() => expect(screen.getByTestId('slip-stage')).toHaveTextContent('取消済み'));
    expect(screen.queryByRole('button', { name: '発送を取り消す' })).not.toBeInTheDocument();
  });

  test('FREQ-534-AC-03: 確定済みの票に「発送を取り消す」を出し、押すとダイアログ（説明・「取り消す」「戻る」）を開く。cancelBlockers は注文番号つきで先に出す。「戻る」では何も送らない', async () => {
    serve({ slip: () => confirmedDetail() });
    const dialog = await openDialog();
    expect(within(dialog).getByText('票に含まれるすべての注文の発送を取り消し、品物を発送準備中に戻します。')).toBeInTheDocument();
    expect(within(dialog).getByText(`注文 ${toOrderNumber(ORDER_ID)} は返品の対象です`)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '取り消す' })).toBeEnabled();
    fireEvent.click(within(dialog).getByRole('button', { name: '戻る' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });

  test('FREQ-533-AC-04: 「取り消す」で POST …/cancel へ expectedVersion・requestKey を送り、成功で「発送を取り消しました。」を出してダイアログを閉じ、票を読み直して「取消済み」にする', async () => {
    let current = confirmedDetail({ cancelBlockers: [] });
    serve({ slip: () => current, cancel: () => {
      current = confirmedDetail({ stage: 'cancelled', version: 3, cancelledAt: '2026-10-25T05:00:00+00:00', cancelBlockers: [] });
      return respond(200, cancelled());
    } });
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: '取り消す' }));

    expect(await screen.findByText('発送を取り消しました。')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(posts()).toHaveLength(1);
    expect(posts()[0].url).toBe(`/api/admin/shipment-slips/${SLIP_ID}/cancel`);
    expect(posts()[0].body).toEqual({ expectedVersion: 2, requestKey: expect.stringMatching(UUID) });
    await waitFor(() => expect(slipReads()).toHaveLength(2));
    await waitFor(() => expect(screen.getByTestId('slip-stage')).toHaveTextContent('取消済み'));
    expect(screen.queryByRole('button', { name: '発送を取り消す' })).not.toBeInTheDocument();
  });

  test('FREQ-534-AC-03: DB が断った（返品あり）時は表の本文をダイアログの中に出して開いたままにし、票を読み直して理由を注文番号つきで足す。票の段階は変わらない', async () => {
    let current = confirmedDetail({ cancelBlockers: [] });
    serve({ slip: () => current, cancel: () => {
      current = confirmedDetail({ cancelBlockers: [{ orderId: ORDER_ID, reason: 'has_return' }] });
      return respond(409, { code: 'GROUP_G_SLIP_HAS_RETURN', error: '返品の対象になっている注文があるため、発送を取り消せません。' });
    } });
    const dialog = await openDialog();
    expect(within(dialog).queryByTestId('slip-cancel-blockers')).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: '取り消す' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('返品の対象になっている注文があるため、発送を取り消せません。');
    await waitFor(() => expect(slipReads()).toHaveLength(2));
    expect(await within(dialog).findByText(`注文 ${toOrderNumber(ORDER_ID)} は返品の対象です`)).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: '発送を取り消す' })).toBeInTheDocument();
    expect(screen.getByTestId('slip-stage')).toHaveTextContent('発送済み');
    expect(screen.queryByText('発送を取り消しました。')).not.toBeInTheDocument();
  });

  test('FREQ-534-AC-03: 別の人が先に取り消していて「取り消す」が断られ（GROUP_G_SLIP_CANCELLED）、読み直した票がすでに取消済みなら、ダイアログを閉じて「取消済み」の表示だけにする', async () => {
    let current = confirmedDetail({ cancelBlockers: [] });
    serve({ slip: () => current, cancel: () => {
      current = confirmedDetail({ stage: 'cancelled', version: 3, cancelledAt: '2026-10-25T05:00:00+00:00', cancelBlockers: [] });
      return respond(409, { code: 'GROUP_G_SLIP_CANCELLED', error: 'この発送票は取り消されています。' });
    } });
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: '取り消す' }));

    await waitFor(() => expect(slipReads()).toHaveLength(2));
    await waitFor(() => expect(screen.getByTestId('slip-stage')).toHaveTextContent('取消済み'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '発送を取り消す' })).not.toBeInTheDocument();
    expect(posts()).toHaveLength(1);
    expect(screen.queryByText('発送を取り消しました。')).not.toBeInTheDocument();
  });

  test('FREQ-533-AC-04: 取消の版競合（409）の後は読み直した新しい版・新しい requestKey で送り、二重押下は通信1回', async () => {
    let current = confirmedDetail({ cancelBlockers: [] });
    let attempts = 0;
    serve({ slip: () => current, cancel: () => {
      attempts += 1;
      if (attempts === 1) {
        current = confirmedDetail({ version: 4, cancelBlockers: [] });
        return respond(409, { code: 'GROUP_G_SLIP_VERSION_CONFLICT' });
      }
      return respond(200, cancelled(5));
    } });
    const dialog = await openDialog();
    const button = within(dialog).getByRole('button', { name: '取り消す' });
    fireEvent.click(button); fireEvent.click(button);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('発送票が更新されました。内容を確認して、もう一度送ってください。');
    expect(posts()).toHaveLength(1);
    await waitFor(() => expect(slipReads()).toHaveLength(2));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取り消す' }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1].body.expectedVersion).toBe(4);
    expect(posts()[1].body.requestKey).not.toBe(posts()[0].body.requestKey);
    expect(await screen.findByText('発送を取り消しました。')).toBeInTheDocument();
  });

  test('FREQ-533-AC-04: 結果が分からない時は「もう一度確かめる」で同じ本文・requestKeyを送り直し、成功で票を読み直す', async () => {
    let current = confirmedDetail({ cancelBlockers: [] });
    let attempts = 0;
    serve({ slip: () => current, cancel: () => {
      attempts += 1;
      if (attempts === 1) return respond(500, {});
      current = confirmedDetail({ stage: 'cancelled', version: 3, cancelledAt: '2026-10-25T05:00:00+00:00', cancelBlockers: [] });
      return respond(200, { ...cancelled(), replayed: true });
    } });
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: '取り消す' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'もう一度確かめる' }));
    expect(await screen.findByText('発送を取り消しました。')).toBeInTheDocument();
    expect(posts()).toHaveLength(2);
    expect(posts()[1]).toEqual(posts()[0]);
    await waitFor(() => expect(screen.getByTestId('slip-stage')).toHaveTextContent('取消済み'));
  });
});

describe('伝票番号の入力・訂正と手動の配達済み（G-3 Task 7）', () => {
  const trackingUpdated = (version = 3) => ({ id: SLIP_ID, version, trackingVersion: 2, replayed: false });
  const deliveredResult = (version = 3) => ({ id: SLIP_ID, version, deliveredAt: '2026-10-25T03:00:00.000Z', replayed: false });
  const open = async (buttonName: string, dialogName: string) => {
    render(<ShipmentSlipSection slipId={SLIP_ID} />);
    fireEvent.click(await screen.findByRole('button', { name: buttonName }));
    return screen.findByRole('dialog', { name: dialogName });
  };

  test('FREQ-534-AC-01: 確定済みの票に「伝票番号を直す」「配達済みにする」を出す（番号が無い票は「伝票番号を入れる」）。下書き・取消済みには出さない', async () => {
    serve({ slip: () => confirmedDetail() });
    const { unmount } = render(<ShipmentSlipSection slipId={SLIP_ID} />);
    expect(await screen.findByRole('button', { name: '伝票番号を直す' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '配達済みにする' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '伝票番号を入れる' })).not.toBeInTheDocument();
    unmount();

    serve({ slip: () => confirmedDetail({ carrier: null, trackingNumber: null }) });
    const second = render(<ShipmentSlipSection slipId={SLIP_ID} />);
    expect(await screen.findByRole('button', { name: '伝票番号を入れる' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '伝票番号を直す' })).not.toBeInTheDocument();
    second.unmount();

    for (const detail of [draftDetail(), confirmedDetail({ stage: 'cancelled', cancelledAt: '2026-10-25T05:00:00+00:00', cancelBlockers: [] })]) {
      serve({ slip: () => detail });
      const view = render(<ShipmentSlipSection slipId={SLIP_ID} />);
      await screen.findByRole('heading', { level: 1 });
      for (const name of ['伝票番号を直す', '伝票番号を入れる', '配達済みにする']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
      view.unmount();
    }
  });

  test('FREQ-534-AC-02: 有効な発送のどれかがすでに配達済みの票には「配達済みにする」を出さない（伝票番号を直す・発送を取り消すは出す）。取消済みの発送の配達済みは数えない', async () => {
    const base = confirmedDetail().orders[0];
    const delivered = { ...base, deliveryStatus: 'delivered' as const, deliveredAt: '2026-10-25T03:00:00+00:00' };
    serve({ slip: () => confirmedDetail({ orders: [delivered] }) });
    const first = render(<ShipmentSlipSection slipId={SLIP_ID} />);
    expect(await screen.findByRole('button', { name: '伝票番号を直す' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '発送を取り消す' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '配達済みにする' })).not.toBeInTheDocument();
    first.unmount();

    // 2つの発送のうち一方だけ配達済みでも出さない
    serve({ slip: () => confirmedDetail({ orders: [base, { ...delivered, orderId: ORDER_ID_2, fulfillmentId: '88888888-8888-4888-8888-888888888888' }] }) });
    const second = render(<ShipmentSlipSection slipId={SLIP_ID} />);
    await screen.findByRole('button', { name: '伝票番号を直す' });
    expect(screen.queryByRole('button', { name: '配達済みにする' })).not.toBeInTheDocument();
    second.unmount();

    // 取り消された発送が配達済みでも、有効な発送が未配達なら出す
    serve({ slip: () => confirmedDetail({ orders: [base, { ...delivered, orderId: ORDER_ID_2, fulfillmentId: '88888888-8888-4888-8888-888888888888', cancelledAt: '2026-10-25T05:00:00+00:00' }] }) });
    render(<ShipmentSlipSection slipId={SLIP_ID} />);
    expect(await screen.findByRole('button', { name: '配達済みにする' })).toBeInTheDocument();
  });

  test('FREQ-534-AC-01: 「伝票番号を直す」は今の運送会社と番号を入れたダイアログを開き、「戻る」では何も送らない', async () => {
    serve({ slip: () => confirmedDetail() });
    const dialog = await open('伝票番号を直す', '伝票番号を直す');
    expect(within(dialog).getByText('票に含まれるすべての注文に反映します。')).toBeInTheDocument();
    expect((within(dialog).getByLabelText('伝票番号') as HTMLInputElement).value).toBe('1234-5678');
    expect((within(dialog).getByLabelText('運送会社') as HTMLSelectElement).value).toBe('yamato');
    fireEvent.click(within(dialog).getByRole('button', { name: '戻る' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });

  test('FREQ-534-AC-01: 番号が無い票の「伝票番号を入れる」で運送会社と番号を送ると、成功で「伝票番号を更新しました。」を出してダイアログを閉じ、票を読み直して番号を表示する', async () => {
    let current = confirmedDetail({ carrier: null, trackingNumber: null });
    serve({ slip: () => current, tracking: () => {
      current = confirmedDetail({ version: 3, carrier: 'sagawa', trackingNumber: 'NEW-456', trackingVersion: 2 });
      return respond(200, trackingUpdated());
    } });
    const dialog = await open('伝票番号を入れる', '伝票番号を入れる');
    fireEvent.change(within(dialog).getByLabelText('運送会社'), { target: { value: 'sagawa' } });
    fireEvent.change(within(dialog).getByLabelText('伝票番号'), { target: { value: 'NEW-456' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '入れる' }));

    expect(await screen.findByText('伝票番号を更新しました。')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(posts()).toHaveLength(1);
    expect(posts()[0].url).toBe(`/api/admin/shipment-slips/${SLIP_ID}/tracking`);
    expect(posts()[0].body).toEqual({ expectedVersion: 2, carrier: 'sagawa', trackingNumber: 'NEW-456', notifyCustomer: true, requestKey: expect.stringMatching(UUID) });
    await waitFor(() => expect(slipReads()).toHaveLength(2));
    expect(await screen.findByRole('button', { name: '伝票番号を直す' })).toBeInTheDocument();
    expect(screen.getByText('佐川急便 NEW-456')).toBeInTheDocument();
  });

  test('FREQ-534-AC-01: 伝票番号が断られた（変わっていない）時は表の本文をダイアログの中に出して開いたままにし、票を読み直す。入力は保つ', async () => {
    serve({ slip: () => confirmedDetail(), tracking: () => respond(409, { code: 'GROUP_G_SLIP_TRACKING_UNCHANGED' }) });
    const dialog = await open('伝票番号を直す', '伝票番号を直す');
    fireEvent.click(within(dialog).getByRole('button', { name: '直す' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('運送会社も伝票番号も変わっていません。');
    await waitFor(() => expect(slipReads()).toHaveLength(2));
    expect(screen.getByRole('dialog', { name: '伝票番号を直す' })).toBeInTheDocument();
    expect((within(screen.getByRole('dialog')).getByLabelText('伝票番号') as HTMLInputElement).value).toBe('1234-5678');
    expect(screen.queryByText('伝票番号を更新しました。')).not.toBeInTheDocument();
  });

  test('FREQ-534-AC-01: 版競合（409）の後は読み直した新しい版・新しい requestKey で送り、二重押下は通信1回', async () => {
    let current = confirmedDetail();
    let attempts = 0;
    serve({ slip: () => current, tracking: () => {
      attempts += 1;
      if (attempts === 1) {
        current = confirmedDetail({ version: 4 });
        return respond(409, { code: 'GROUP_G_SLIP_VERSION_CONFLICT' });
      }
      return respond(200, trackingUpdated(5));
    } });
    const dialog = await open('伝票番号を直す', '伝票番号を直す');
    fireEvent.change(within(dialog).getByLabelText('伝票番号'), { target: { value: 'KEEP-1' } });
    const button = within(dialog).getByRole('button', { name: '直す' });
    fireEvent.click(button); fireEvent.click(button);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('発送票が更新されました。内容を確認して、もう一度送ってください。');
    expect(posts()).toHaveLength(1);
    await waitFor(() => expect(slipReads()).toHaveLength(2));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '直す' }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1].body).toMatchObject({ expectedVersion: 4, trackingNumber: 'KEEP-1' });
    expect(posts()[1].body.requestKey).not.toBe(posts()[0].body.requestKey);
    expect(await screen.findByText('伝票番号を更新しました。')).toBeInTheDocument();
  });

  test('FREQ-534-AC-01: 結果が分からない時は「もう一度確かめる」で同じ本文・requestKeyを送り直し、成功で票を読み直す', async () => {
    let attempts = 0;
    serve({ slip: () => confirmedDetail(), tracking: () => {
      attempts += 1;
      return attempts === 1 ? respond(500, {}) : respond(200, { ...trackingUpdated(), replayed: true });
    } });
    const dialog = await open('伝票番号を直す', '伝票番号を直す');
    fireEvent.change(within(dialog).getByLabelText('伝票番号'), { target: { value: 'NEW-9' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '直す' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'もう一度確かめる' }));
    expect(await screen.findByText('伝票番号を更新しました。')).toBeInTheDocument();
    expect(posts()).toHaveLength(2);
    expect(posts()[1]).toEqual(posts()[0]);
    await waitFor(() => expect(slipReads()).toHaveLength(2));
  });

  test('FREQ-534-AC-02: 「配達済みにする」はダイアログ（説明・届いた日・「配達済みにする」「戻る」）を開き、「戻る」では何も送らない', async () => {
    serve({ slip: () => confirmedDetail() });
    const dialog = await open('配達済みにする', '配達済みにする');
    expect(within(dialog).getByText('票に含まれるすべての注文を配達済みにします。')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('届いた日')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '配達済みにする' })).toBeEnabled();
    fireEvent.click(within(dialog).getByRole('button', { name: '戻る' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });

  test('FREQ-534-AC-02: 「配達済みにする」で POST …/delivered へ expectedVersion・deliveredOn・notifyCustomer・requestKey を送り、成功で「配達済みにしました。」を出してダイアログを閉じ、票を読み直す', async () => {
    let current = confirmedDetail();
    serve({ slip: () => current, delivered: () => {
      current = confirmedDetail({ version: 3, orders: [{ ...confirmedDetail().orders[0], deliveryStatus: 'delivered', deliveredAt: '2026-10-25T03:00:00+00:00' }] });
      return respond(200, deliveredResult());
    } });
    const dialog = await open('配達済みにする', '配達済みにする');
    fireEvent.click(within(dialog).getByRole('button', { name: '配達済みにする' }));

    expect(await screen.findByText('配達済みにしました。')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(posts()).toHaveLength(1);
    expect(posts()[0].url).toBe(`/api/admin/shipment-slips/${SLIP_ID}/delivered`);
    expect(posts()[0].body).toEqual({
      expectedVersion: 2, deliveredOn: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date()), notifyCustomer: true, requestKey: expect.stringMatching(UUID),
    });
    await waitFor(() => expect(slipReads()).toHaveLength(2));
    // 注文番号は詳細への Link になったので、文字は p 全体の textContent で突き合わせる
    const deliveredLine = `注文 ${toOrderNumber(ORDER_ID)} 発送（1回目） ${DELIVERY_STATUS_LABELS.delivered}`;
    expect(await screen.findByText((_content, element) => element?.tagName === 'P' && element.textContent === deliveredLine)).toBeInTheDocument();
  });

  test('FREQ-534-AC-02: すでに配達済みで断られた時は表の本文をダイアログの中に出して開いたままにし、票を読み直す', async () => {
    serve({ slip: () => confirmedDetail(), delivered: () => respond(409, { code: 'GROUP_G_SLIP_ALREADY_DELIVERED' }) });
    const dialog = await open('配達済みにする', '配達済みにする');
    fireEvent.click(within(dialog).getByRole('button', { name: '配達済みにする' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('この発送票はすでに配達済みです。');
    await waitFor(() => expect(slipReads()).toHaveLength(2));
    expect(screen.getByRole('dialog', { name: '配達済みにする' })).toBeInTheDocument();
    expect(screen.queryByText('配達済みにしました。')).not.toBeInTheDocument();
  });

  test('FREQ-534-AC-01: 別の人が先に取り消していて、読み直した票が取消済みなら、ダイアログを閉じて「取消済み」の表示だけにする', async () => {
    let current = confirmedDetail();
    serve({ slip: () => current, tracking: () => {
      current = confirmedDetail({ stage: 'cancelled', version: 3, cancelledAt: '2026-10-25T05:00:00+00:00', cancelBlockers: [] });
      return respond(409, { code: 'GROUP_G_SLIP_CANCELLED' });
    } });
    const dialog = await open('伝票番号を直す', '伝票番号を直す');
    fireEvent.click(within(dialog).getByRole('button', { name: '直す' }));
    await waitFor(() => expect(slipReads()).toHaveLength(2));
    await waitFor(() => expect(screen.getByTestId('slip-stage')).toHaveTextContent('取消済み'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '伝票番号を直す' })).not.toBeInTheDocument();
  });
});
