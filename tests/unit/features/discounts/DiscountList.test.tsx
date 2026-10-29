import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import DiscountList from '@/features/discounts/components/DiscountList';
import { failResponse, listBody, listRow, okResponse, unreadableResponse, wasDrained, expectNoActWarnings } from './discount-test-utils';

const mockFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockFetch(...args) }));

const COLUMNS = ['割引名', '種類', '効き方', '状態', '期間', '使った回数', '上限'];
const listUrls = (): string[] => mockFetch.mock.calls.map(([url]) => String(url));

beforeEach(() => {
  mockFetch.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  expectNoActWarnings();
  jest.restoreAllMocks();
});

function renderList(onOpen = jest.fn(), onCreate = jest.fn()) {
  render(<DiscountList onOpen={onOpen} onCreate={onCreate} />);
  return { onOpen, onCreate };
}

describe('割引の一覧', () => {
  test('FREQ-547-AC-01: 7列の表と状態・種類・効き方の3つの絞り込みを表示し、20行と頁送りを出す', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => listRow({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, name: `割引${i + 1}` }));
    mockFetch.mockResolvedValue(okResponse(listBody(rows, 45)));
    renderList();

    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(COLUMNS);
    expect(within(table).getAllByRole('row')).toHaveLength(21);
    expect(screen.getByTestId('discount-count')).toHaveTextContent('45件');
    expect(screen.getByText('1 / 3ページ')).toBeInTheDocument();
    for (const name of ['状態', '種類', '効き方']) expect(screen.getByRole('combobox', { name })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '名前・コードで探す' })).toBeInTheDocument();
    expect(within(screen.getByRole('combobox', { name: '状態' })).getAllByRole('option').map((o) => o.textContent)).toEqual(['すべて', '予定', '有効', '期限切れ', '止めた']);
    expect(within(table).getAllByText('有効')).toHaveLength(20);
    expect(listUrls()[0]).toBe('/api/admin/discounts');
  });

  test('FREQ-547-AC-01: 絞り込みと検索と頁送りは窓口の問合せになり、割引名から開ける', async () => {
    mockFetch.mockResolvedValue(okResponse(listBody([listRow()], 45)));
    const { onOpen } = renderList();
    await screen.findByRole('table');

    fireEvent.change(screen.getByRole('combobox', { name: '状態' }), { target: { value: 'stopped' } });
    await waitFor(() => expect(listUrls().at(-1)).toBe('/api/admin/discounts?status=stopped'));
    fireEvent.change(screen.getByRole('combobox', { name: '種類' }), { target: { value: 'set' } });
    fireEvent.change(screen.getByRole('combobox', { name: '効き方' }), { target: { value: 'automatic' } });
    fireEvent.change(screen.getByRole('textbox', { name: '名前・コードで探す' }), { target: { value: ' FRIEND ' } });
    fireEvent.click(screen.getByRole('button', { name: '探す' }));
    await waitFor(() => expect(listUrls().at(-1)).toBe('/api/admin/discounts?status=stopped&kind=set&method=automatic&query=FRIEND'));
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: '次の頁' }));
    await waitFor(() => expect(listUrls().at(-1)).toContain('page=2'));
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: '秋の10％引き' }));
    expect(onOpen).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
  });

  test('FREQ-547-AC-01: 期間は日本時間、無期限・上限なしを文で示す', async () => {
    mockFetch.mockResolvedValue(okResponse(listBody([listRow({ endsAt: null, usageLimit: null, status: 'scheduled' })])));
    renderList();
    const row = (await screen.findAllByRole('row'))[1];
    expect(within(row).getByText('2026-10-01 09:00 〜 無期限')).toBeInTheDocument();
    expect(within(row).getByText('上限なし')).toBeInTheDocument();
    expect(within(row).getByText('予定')).toBeInTheDocument();
  });

  test('FREQ-547-AC-01: 0件のとき空の文を出し、表は出さない', async () => {
    mockFetch.mockResolvedValueOnce(okResponse(listBody([])));
    renderList();
    expect(await screen.findByText('割引はありません。')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  test.each([[500], [429], [503], [401]])('FREQ-547-AC-01: %i の応答は取得失敗の文と読み直すを出し、本文を読み切る', async (status) => {
    const response = failResponse(status);
    mockFetch.mockResolvedValueOnce(response).mockResolvedValue(okResponse(listBody([listRow()])));
    renderList();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(wasDrained(response)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '読み直す' }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('FREQ-547-AC-01: 500の取得失敗は「割引を読み込めませんでした。」', async () => {
    mockFetch.mockResolvedValue(failResponse(500));
    renderList();
    expect(await screen.findByText('割引を読み込めませんでした。')).toBeInTheDocument();
  });

  test('FREQ-547-AC-01: 403は権限の文だけを出し、絞り込みも読み直すも出さず、本文を閉じる', async () => {
    const response = unreadableResponse(403);
    mockFetch.mockResolvedValue(response);
    renderList();
    expect(await screen.findByText('割引を見る権限がありません。')).toBeInTheDocument();
    expect(response.body.cancel).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '読み直す' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: '状態' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '割引を作る' })).not.toBeInTheDocument();
  });

  test('FREQ-547-AC-01: 計算の要対応は、read権限の一覧に文と件数を出す', async () => {
    mockFetch.mockResolvedValue(okResponse(listBody([listRow({ searchAttention: { openedAt: '2026-10-20T00:00:00Z', count: 3 } })], 1, false)));
    renderList();
    expect(await screen.findByText(/割引の計算を確認してください。（3件）/)).toBeInTheDocument();
  });

  test('FREQ-543-AC-03: 「割引を作る」は応答のmanage権限があるときだけ出る', async () => {
    mockFetch.mockResolvedValueOnce(okResponse(listBody([listRow()], 1, false)));
    renderList();
    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: '割引を作る' })).not.toBeInTheDocument();
  });

  test('FREQ-543-AC-03: manage権限があれば「割引を作る」で作成へ進む', async () => {
    mockFetch.mockResolvedValue(okResponse(listBody([listRow()], 1, true)));
    const { onCreate } = renderList();
    fireEvent.click(await screen.findByRole('button', { name: '割引を作る' }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  test('FREQ-547-AC-01: 続けて絞り込むと、遅れて届いた古い答えは表を上書きしない', async () => {
    let releaseFirst: (value: unknown) => void = () => {};
    mockFetch
      .mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve; }))
      .mockResolvedValue(okResponse(listBody([listRow({ name: '新しい答え' })])));
    renderList();
    fireEvent.change(screen.getByRole('combobox', { name: '状態' }), { target: { value: 'active' } });
    expect(await screen.findByText('新しい答え')).toBeInTheDocument();
    releaseFirst(okResponse(listBody([listRow({ name: '古い答え' })])));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText('古い答え')).not.toBeInTheDocument();
    expect(screen.getByText('新しい答え')).toBeInTheDocument();
  });
});
