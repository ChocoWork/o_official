import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ShipmentSlipSection from '@/components/ShipmentSlipSection';
import { rememberSlipNotice } from '@/lib/orders/shipment-slips/shipment-slip-notice';
import type { ShipmentSlipDetail } from '@/lib/orders/shipment-slips/shipment-slip-types';
import {
  confirmedDetail,
  draftDetail,
  ITEM_ID,
  ITEM_ID_2,
  ORDER_ID_2,
  packingRow,
  SLIP_ID,
} from '../lib/orders/shipment-slips/shipment-slip-fixtures';

/**
 * 発送票の頁（G-3 Task 4）の下書き: 同梱する品物（この行を外す）・品物を追加・送り先・下書きを破棄。
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
  slip: () => ShipmentSlipDetail;
  slipResponse?: () => Response;
  packing?: () => Response;
  draft?: (body: Draft) => Response | Promise<Response>;
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
      if (target.endsWith('/draft')) return state.draft ? state.draft(body) : respond(200, { id: SLIP_ID, number: 'SL-20261025-0001', version: 2, replayed: false });
      return state.discard ? state.discard(body) : respond(200, { id: SLIP_ID, number: 'SL-20261025-0001', version: 2, replayed: false });
    }
    if (target.startsWith('/api/admin/packing')) {
      return withCanManage(state.packing ? state.packing() : respond(200, { rows: [], total: 0, page: 1, limit: 100 }));
    }
    return state.slipResponse ? state.slipResponse() : respond(200, { slip: state.slip() });
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

  test('FREQ-533-AC-01: この段階では「発送票確認」と荷物の情報の欄を出さない', async () => {
    serve({ slip: () => twoLines() });
    render(<ShipmentSlipSection slipId={SLIP_ID} />);
    await screen.findByRole('heading', { level: 1 });

    expect(screen.queryByRole('button', { name: '発送票確認' })).not.toBeInTheDocument();
    expect(screen.queryByText('荷物の情報')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('伝票番号')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('運送会社')).not.toBeInTheDocument();
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
      return respond(200, { slip: twoLines() });
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
