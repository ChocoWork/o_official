/**
 * 一覧 `/stockist` の地方・都道府県の選択（STATE-STOCKIST-002）を確かめる結合テスト。
 * 状態は URL の `pref` が決める。実物の格子の部品を描き、URL の読み取り・箱の操作・`pref` の書き戻し・
 * 出す店の絞り込み・開け閉めの引き継ぎを、画面から見える形で比べる。
 */
import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen, within } from '@testing-library/react';
import { PublicStockistGrid } from '@/features/stockist/components/PublicStockistGrid';
import type { PublicStockist } from '@/features/stockist/types';

const pushMock = jest.fn();
let currentSearch = '';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

jest.mock('next/navigation', () => ({
  usePathname: () => '/stockist',
  useRouter: () => ({ push: (...args: unknown[]) => pushMock(...args) }),
  useSearchParams: () => new URLSearchParams(currentSearch),
}));

function shop(id: number, name: string, address: string): PublicStockist {
  return { id, name, address, phone: '03-1234-5678', time: '11:00-19:00', holiday: '水曜' };
}

// 北海道・関東（東京都・神奈川県）・近畿（大阪府・京都府）に1店ずつ。住所の先頭が県名でない店が1つ
const STOCKISTS: PublicStockist[] = [
  shop(1, 'Sapporo Shop', '北海道札幌市中央区1-1'),
  shop(2, 'Shibuya Shop', '東京都渋谷区1-1'),
  shop(3, 'Yokohama Shop', '神奈川県横浜市中区1-1'),
  shop(4, 'Osaka Shop', '大阪府大阪市北区1-1'),
  shop(5, 'Kyoto Shop', '京都府京都市中京区1-1'),
  shop(6, 'Paris Shop', 'パリ市1区'),
];

function queryOf(pref: string, extra = ''): string {
  const params = new URLSearchParams(extra);
  params.set('pref', pref);
  return params.toString();
}

function urlOf(pref: string, extra = ''): string {
  return `/stockist?${queryOf(pref, extra)}`;
}

function renderCatalog(search = '') {
  currentSearch = search;
  return render(<PublicStockistGrid variant="catalog" stockists={STOCKISTS} />);
}

function panel() {
  return within(screen.getByRole('complementary'));
}

function checkbox(name: string): HTMLInputElement {
  return panel().getByRole('checkbox', { name }) as HTMLInputElement;
}

function checkboxLabels(): string[] {
  return panel()
    .getAllByRole('checkbox')
    .map((box) => box.parentElement?.textContent ?? '');
}

function checkedNames(): string[] {
  return panel()
    .getAllByRole('checkbox')
    .filter((box) => (box as HTMLInputElement).checked)
    .map((box) => box.parentElement?.textContent ?? '');
}

function shownShops(): string[] {
  return screen.queryAllByRole('heading', { level: 3 }).map((node) => node.textContent ?? '');
}

async function click(element: HTMLElement) {
  await userEvent.setup().click(element);
}

describe('STATE-STOCKIST-002 stockist region selection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    currentSearch = '';
  });

  it('STATE-STOCKIST-002 URL に pref が無い時は ALL だけを選び、全部の店を出す', () => {
    renderCatalog();

    expect(checkedNames()).toEqual(['ALL']);
    expect(shownShops()).toEqual([
      'Sapporo Shop',
      'Shibuya Shop',
      'Yokohama Shop',
      'Osaka Shop',
      'Kyoto Shop',
      'Paris Shop',
    ]);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('STATE-STOCKIST-002 pref はカンマで分け、前後の空白を除き、47都道府県の正式な名前だけを残す', () => {
    renderCatalog(queryOf('東京都, 大阪府,bogus,東京,,'));

    expect(shownShops()).toEqual(['Shibuya Shop', 'Osaka Shop']);
    expect(checkbox('ALL').checked).toBe(false);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('STATE-STOCKIST-002 pref に許可の名前が1つも無い時は ALL にして全部の店を出す', () => {
    renderCatalog(queryOf('bogus,東京, <script>'));

    expect(checkedNames()).toEqual(['ALL']);
    expect(shownShops()).toHaveLength(6);
  });

  it('STATE-STOCKIST-002 ALL から県を足すと pref に県名を書いて履歴を足す（位置は動かさない）', async () => {
    renderCatalog();

    await click(screen.getByRole('button', { name: '関東の都道府県を展開' }));
    await click(checkbox('東京'));

    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenLastCalledWith(urlOf('東京都'), { scroll: false });
  });

  it('STATE-STOCKIST-002 pref の書き換えでほかの URL の値を残す', async () => {
    renderCatalog('foo=1');

    await click(checkbox('北海道'));

    expect(pushMock).toHaveBeenLastCalledWith(urlOf('北海道', 'foo=1'), { scroll: false });
  });

  it('STATE-STOCKIST-002 県を足した後の pref は、選んだ順でなく地方の定義の順に並べ直す', async () => {
    renderCatalog(queryOf('大阪府'));

    await click(screen.getByRole('button', { name: '関東の都道府県を展開' }));
    await click(checkbox('東京'));

    expect(pushMock).toHaveBeenLastCalledWith(urlOf('東京都,大阪府'), { scroll: false });
  });

  it('STATE-STOCKIST-002 選んだ県を外して残りがあれば、残りだけを pref に書く', async () => {
    renderCatalog(queryOf('東京都,大阪府'));

    await click(checkbox('東京'));

    expect(pushMock).toHaveBeenLastCalledWith(urlOf('大阪府'), { scroll: false });
  });

  it('STATE-STOCKIST-002 最後の県を外すと pref を消し、ほかの URL の値だけを残す', async () => {
    renderCatalog(queryOf('東京都', 'foo=1'));

    await click(checkbox('東京'));

    expect(pushMock).toHaveBeenLastCalledWith('/stockist?foo=1', { scroll: false });
  });

  it('STATE-STOCKIST-002 最後の県を外してほかの値が無ければ pref を消した道だけにする', async () => {
    renderCatalog(queryOf('北海道'));

    await click(checkbox('北海道'));

    expect(pushMock).toHaveBeenLastCalledWith('/stockist', { scroll: false });
  });

  it('STATE-STOCKIST-002 ALL を押すと選んだ県を全部外す', async () => {
    renderCatalog(queryOf('東京都,大阪府'));

    await click(checkbox('ALL'));

    expect(pushMock).toHaveBeenLastCalledWith('/stockist', { scroll: false });
  });

  it('STATE-STOCKIST-002 ALL の印は選択が0の時だけ付く', () => {
    const view = renderCatalog();
    expect(checkbox('ALL').checked).toBe(true);
    view.unmount();

    renderCatalog(queryOf('大阪府'));
    expect(checkbox('ALL').checked).toBe(false);
  });

  it('STATE-STOCKIST-002 地方の箱は、配下の店のある県が全部選ばれていなければ全部足す', async () => {
    renderCatalog();

    await click(checkbox('関東'));

    // 店のある県（東京都・神奈川県）だけを足し、店の無い埼玉県などは足さない
    expect(pushMock).toHaveBeenLastCalledWith(urlOf('東京都,神奈川県'), { scroll: false });
  });

  it('STATE-STOCKIST-002 地方の箱は、県が一部だけ選ばれている時も全部足す', async () => {
    renderCatalog(queryOf('東京都'));
    expect(checkbox('関東').checked).toBe(false);

    await click(checkbox('関東'));

    expect(pushMock).toHaveBeenLastCalledWith(urlOf('東京都,神奈川県'), { scroll: false });
  });

  it('STATE-STOCKIST-002 地方の箱は、配下の県が全部選ばれていれば全部外し、印も全部の時だけ付く', async () => {
    renderCatalog(queryOf('東京都,神奈川県,大阪府'));
    expect(checkbox('関東').checked).toBe(true);
    expect(checkbox('近畿').checked).toBe(false);

    await click(checkbox('関東'));

    expect(pushMock).toHaveBeenLastCalledWith(urlOf('大阪府'), { scroll: false });
  });

  it('STATE-STOCKIST-002 北海道は親子に分けず1つの箱で、開け閉めのボタンを持たず、県の箱と同じ動きをする', async () => {
    renderCatalog();

    expect(screen.queryByRole('button', { name: /北海道の都道府県を/ })).not.toBeInTheDocument();
    expect(checkbox('北海道').checked).toBe(false);

    await click(checkbox('北海道'));
    expect(pushMock).toHaveBeenLastCalledWith(urlOf('北海道'), { scroll: false });
  });

  it('STATE-STOCKIST-002 北海道の箱の印は、北海道が選ばれている時だけ付く', () => {
    renderCatalog(queryOf('北海道'));

    expect(checkbox('北海道').checked).toBe(true);
    expect(checkedNames()).toEqual(['北海道']);
  });

  it('STATE-STOCKIST-002 開け閉めのボタンは地方の下の県を出し入れし、開いているかを読み上げに伝える', async () => {
    renderCatalog();
    const open = screen.getByRole('button', { name: '関東の都道府県を展開' });
    expect(open).toHaveAttribute('aria-expanded', 'false');
    expect(panel().queryByRole('checkbox', { name: '東京' })).not.toBeInTheDocument();

    await click(open);

    const close = screen.getByRole('button', { name: '関東の都道府県を折りたたむ' });
    expect(close).toHaveAttribute('aria-expanded', 'true');
    expect(checkbox('東京').checked).toBe(false);
    expect(checkbox('神奈川').checked).toBe(false);
    expect(panel().queryByRole('checkbox', { name: '埼玉' })).not.toBeInTheDocument();
    // 開け閉めは画面の中だけの状態で、URL には書かない
    expect(pushMock).not.toHaveBeenCalled();

    await click(close);
    expect(screen.getByRole('button', { name: '関東の都道府県を展開' })).toHaveAttribute('aria-expanded', 'false');
    expect(panel().queryByRole('checkbox', { name: '東京' })).not.toBeInTheDocument();
  });

  it('STATE-STOCKIST-002 最初に描く時は、選ばれた県を含む地方だけを開く', () => {
    renderCatalog(queryOf('大阪府'));

    expect(screen.getByRole('button', { name: '近畿の都道府県を折りたたむ' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '関東の都道府県を展開' })).toBeInTheDocument();
    expect(checkbox('大阪').checked).toBe(true);
    expect(checkbox('京都').checked).toBe(false);
  });

  it('STATE-STOCKIST-002 URL が変わると選択と出す店を合わせ直し、開け閉めは引き継ぐ', () => {
    const view = renderCatalog(queryOf('東京都'));
    expect(screen.getByRole('button', { name: '関東の都道府県を折りたたむ' })).toBeInTheDocument();
    expect(shownShops()).toEqual(['Shibuya Shop']);

    currentSearch = queryOf('大阪府');
    view.rerender(<PublicStockistGrid variant="catalog" stockists={STOCKISTS} />);

    expect(shownShops()).toEqual(['Osaka Shop']);
    // 関東は開いたまま、近畿は新しく選ばれても開かない
    expect(screen.getByRole('button', { name: '関東の都道府県を折りたたむ' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '近畿の都道府県を展開' })).toBeInTheDocument();
    expect(checkbox('東京').checked).toBe(false);

    currentSearch = '';
    view.rerender(<PublicStockistGrid variant="catalog" stockists={STOCKISTS} />);
    expect(checkedNames()).toEqual(['ALL']);
    expect(shownShops()).toHaveLength(6);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('STATE-STOCKIST-002 選択がある間は、住所の先頭の県が選んだ県に入る店だけを出し、県名で始まらない住所の店は出さない', () => {
    renderCatalog(queryOf('東京都,京都府'));

    expect(shownShops()).toEqual(['Shibuya Shop', 'Kyoto Shop']);
    expect(shownShops()).not.toContain('Paris Shop');
  });

  it('STATE-STOCKIST-002 県の選択肢は店のある地方とその地方で店のある県だけで、県は短い名で出す', async () => {
    renderCatalog();

    expect(checkboxLabels()).toEqual(['ALL', '北海道', '関東', '近畿']);
    expect(panel().queryByRole('checkbox', { name: '東北' })).not.toBeInTheDocument();

    await click(screen.getByRole('button', { name: '関東の都道府県を展開' }));
    await click(screen.getByRole('button', { name: '近畿の都道府県を展開' }));

    expect(checkboxLabels()).toEqual(['ALL', '北海道', '関東', '東京', '神奈川', '近畿', '京都', '大阪']);
  });

  it('STATE-STOCKIST-002 絞り込み全体を「エリア（地方・都道府県）で絞り込む」の群として読み上げに伝える', () => {
    renderCatalog();

    expect(screen.getByRole('group', { name: 'エリア（地方・都道府県）で絞り込む' })).toBeInTheDocument();
  });

  it('STATE-STOCKIST-002 選んだ県に店が無い時は該当なしの文を出し、すべて見るで選択を全部外す', async () => {
    renderCatalog(queryOf('愛知県'));

    expect(shownShops()).toEqual([]);
    expect(screen.getByText('該当する取扱店舗がございません。')).toBeInTheDocument();

    await click(screen.getByRole('button', { name: 'すべて見る' }));

    expect(pushMock).toHaveBeenLastCalledWith('/stockist', { scroll: false });
  });

  it('STATE-STOCKIST-002 スマホの FILTER ボタンは引き出しを開け閉めし、開け閉めは URL に残さない', async () => {
    renderCatalog();
    const filter = screen.getByRole('button', { name: 'FILTER' });
    expect(filter).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await click(filter);

    const dialog = screen.getByRole('dialog');
    expect(screen.getByRole('button', { name: 'FILTER' })).toHaveAttribute('aria-expanded', 'true');
    expect(within(dialog).getByRole('group', { name: 'エリア（地方・都道府県）で絞り込む' })).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: 'ALL' })).toBeChecked();

    await click(within(dialog).getByRole('button', { name: 'Close filter drawer' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'FILTER' })).toHaveAttribute('aria-expanded', 'false');
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('STATE-STOCKIST-002 引き出しの中の地方の箱も同じ pref を書き換える', async () => {
    renderCatalog();
    await click(screen.getByRole('button', { name: 'FILTER' }));

    await click(within(screen.getByRole('dialog')).getByRole('checkbox', { name: '近畿' }));

    expect(pushMock).toHaveBeenLastCalledWith(urlOf('京都府,大阪府'), { scroll: false });
  });

  it('STATE-STOCKIST-002 ホームの形は選択の箱を持たず、URL の pref でも店を絞らない', () => {
    currentSearch = queryOf('東京都');
    render(<PublicStockistGrid variant="home" stockists={STOCKISTS} />);

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'FILTER' })).not.toBeInTheDocument();
    expect(shownShops()).toHaveLength(6);
    expect(pushMock).not.toHaveBeenCalled();
  });
});
