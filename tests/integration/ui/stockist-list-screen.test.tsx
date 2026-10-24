import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor, within } from '@testing-library/react';
import type { PublicStockist } from '@/features/stockist/types';

const pushMock = jest.fn();
let currentQuery = '';
const mockStockists: { current: PublicStockist[] } = { current: [] };
const mockGetPublicStockists = jest.fn(async () => mockStockists.current);

// ページ・格子・絞り込み・共通 UI（引き出し・ボタン・チェックボックス）は本物を通し、公開の店の取り出しだけを固定の並びで返す偽物にする
jest.mock('@/features/stockist/services/public', () => ({
  getPublicStockists: () => mockGetPublicStockists(),
}));

jest.mock('next/link', () => {
  return ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  );
});

jest.mock('next/navigation', () => ({
  usePathname: () => '/stockist',
  useRouter: () => ({ push: (...args: unknown[]) => pushMock(...args) }),
  useSearchParams: () => {
    const params = new URLSearchParams(currentQuery);
    return {
      get: (key: string) => params.get(key),
      toString: () => params.toString(),
    };
  },
}));

const stockistPageModule = require('@/app/stockist/page');
const StockistPage = stockistPageModule.default;

function makeShop(id: number, address: string, overrides: Partial<PublicStockist> = {}): PublicStockist {
  return {
    id,
    name: `Shop ${id}`,
    address,
    phone: `03-0000-000${id}`,
    time: '11:00-19:00',
    holiday: '水曜',
    ...overrides,
  };
}

const SHOPS = [
  makeShop(1, '東京都渋谷区神宮前 1-1-1'),
  makeShop(2, '大阪府大阪市北区 2-2-2'),
  makeShop(3, '北海道札幌市中央区 3-3-3'),
  makeShop(4, '東京都港区南青山 4-4-4'),
  makeShop(5, '福岡県福岡市博多区 5-5-5'),
];

async function renderStockistPage(pref?: string) {
  currentQuery = pref ? new URLSearchParams({ pref }).toString() : '';
  const element = await StockistPage({ searchParams: Promise.resolve(pref ? { pref } : {}) });
  return render(element);
}

function filterPanel() {
  return within(screen.getByRole('complementary'));
}

function cardNames(): string[] {
  return screen.queryAllByRole('heading', { level: 3 }).map((heading) => heading.textContent ?? '');
}

function checkedLabels(): string[] {
  return filterPanel()
    .queryAllByRole('checkbox')
    .filter((box) => (box as HTMLInputElement).checked)
    .map((box) => box.parentElement?.textContent ?? '');
}

describe('SCR-STOCKIST-001 stockist list screen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    currentQuery = '';
    mockStockists.current = SHOPS;
  });

  it('SCR-STOCKIST-001 title・description・OG の画像は店に左右されない固定の値を返し、取り出しを呼ばない', async () => {
    const metadata = await stockistPageModule.generateMetadata();

    expect(metadata.title).toBe('STOCKIST | Le Fil des Heures');
    expect(metadata.description).toBe(
      'Le Fil des Heures の取扱店舗一覧です。店舗名・住所・営業時間・定休日をご確認いただけます。',
    );
    expect(metadata.openGraph).toEqual({
      title: 'STOCKIST | Le Fil des Heures',
      description: metadata.description,
      images: ['/mainphoto.png'],
    });
    expect(metadata.alternates).toBeUndefined();
    expect(mockGetPublicStockists).not.toHaveBeenCalled();
  });

  it('SCR-STOCKIST-001 公開の店を1回で全部取り、h1 も頁の見出しも置かずに取り出した並びのまま格子にする', async () => {
    await renderStockistPage();

    expect(mockGetPublicStockists).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument();
    expect(cardNames()).toEqual(['Shop 1', 'Shop 2', 'Shop 3', 'Shop 4', 'Shop 5']);
  });

  it('SCR-STOCKIST-001 言葉の検索・並び替え・ページ送りは置かず、件数が多くても全件を一度に出す', async () => {
    mockStockists.current = Array.from({ length: 30 }, (_, index) => makeShop(index + 1, '東京都渋谷区 1-1-1'));

    await renderStockistPage();

    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(30);
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /more|次|sort|並び/i })).not.toBeInTheDocument();
  });

  it('SCR-STOCKIST-001 格子は1列・sm で2列・xl で3列・2xl で4列にし、幅の上限は持たない', async () => {
    await renderStockistPage();

    const grid = screen.getAllByRole('heading', { level: 3 })[0].closest('article')?.parentElement;
    expect(grid).toHaveClass('stockist-grid-catalog', 'grid', 'grid-cols-1', 'sm:grid-cols-2', 'xl:grid-cols-3', '2xl:grid-cols-4');
    expect(grid?.className).not.toMatch(/max-w/);
  });

  it('SCR-STOCKIST-001 lg 以上はヘッダーの真下に留まる左の列に、「エリア（地方・都道府県）で絞り込む」の群と ALL を出す', async () => {
    await renderStockistPage();

    const sidebar = screen.getByRole('complementary');
    expect(sidebar).toHaveClass('hidden', 'lg:flex', 'sticky', 'w-58.25', 'xl:w-[288px]');
    expect(sidebar).toHaveStyle({ top: 'var(--site-header-height)' });
    expect(filterPanel().getByRole('group', { name: 'エリア（地方・都道府県）で絞り込む' })).toBeInTheDocument();
    expect(checkedLabels()).toEqual(['ALL']);
  });

  it('SCR-STOCKIST-001 絞り込みには店のある地方だけを並べ、店の無い地方や県は出さない', async () => {
    await renderStockistPage();

    for (const region of ['北海道', '関東', '近畿', '九州・沖縄']) {
      expect(filterPanel().getByRole('checkbox', { name: region })).toBeInTheDocument();
    }
    for (const region of ['東北', '中部', '中国', '四国']) {
      expect(filterPanel().queryByRole('checkbox', { name: region })).not.toBeInTheDocument();
    }
    expect(filterPanel().queryByRole('checkbox', { name: '東京' })).not.toBeInTheDocument();
  });

  it('SCR-STOCKIST-001 地方の矢印で県を開閉し、県の名前は「県・都・府」を落とした短い名前で、北海道は親子に分けない', async () => {
    const user = userEvent.setup();
    await renderStockistPage();

    const expand = filterPanel().getByRole('button', { name: '関東の都道府県を展開' });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    expect(filterPanel().queryByRole('checkbox', { name: '東京' })).not.toBeInTheDocument();

    await user.click(expand);

    expect(filterPanel().getByRole('button', { name: '関東の都道府県を折りたたむ' })).toHaveAttribute('aria-expanded', 'true');
    expect(filterPanel().getByRole('checkbox', { name: '東京' })).toBeInTheDocument();
    expect(filterPanel().queryByRole('checkbox', { name: '神奈川' })).not.toBeInTheDocument();

    await user.click(filterPanel().getByRole('button', { name: '関東の都道府県を折りたたむ' }));
    expect(filterPanel().queryByRole('checkbox', { name: '東京' })).not.toBeInTheDocument();

    expect(filterPanel().queryByRole('button', { name: /北海道の都道府県/ })).not.toBeInTheDocument();
  });

  it('SCR-STOCKIST-001 lg 未満はヘッダーの真下に付く FILTER のバーと、同じ高さの見えない置き台を出す', async () => {
    await renderStockistPage();

    const floating = document.querySelector<HTMLElement>('[data-filter-bar="floating"]');
    const placeholder = document.querySelector<HTMLElement>('[data-filter-bar="placeholder"]');
    expect(floating).toBeInTheDocument();
    expect(placeholder).toHaveAttribute('aria-hidden', 'true');
    expect(placeholder).toHaveClass('invisible', 'pointer-events-none');
    expect(floating?.closest('.fixed')).toHaveStyle({ top: 'var(--site-header-height)' });
    expect(within(placeholder as HTMLElement).getByRole('button', { hidden: true })).toHaveAttribute('tabindex', '-1');
  });

  it('SCR-STOCKIST-001 FILTER のボタンで左の引き出しを開いて開閉を読み上げに伝え、閉じるボタンで閉じる', async () => {
    const user = userEvent.setup();
    await renderStockistPage();

    const filterButton = document.querySelector<HTMLElement>('[data-filter-button="floating"]') as HTMLElement;
    expect(filterButton).toHaveAttribute('aria-expanded', 'false');
    expect(filterButton).toHaveAttribute('aria-haspopup', 'dialog');
    expect(document.querySelector('[data-ui-drawer]')).not.toBeInTheDocument();

    await user.click(filterButton);

    const drawer = await waitFor(() => {
      const node = document.querySelector<HTMLElement>('[data-ui-drawer]');
      if (!node) throw new Error('drawer not open');
      return node;
    });
    expect(drawer).toHaveAttribute('data-ui-drawer-side', 'left');
    expect(filterButton).toHaveAttribute('aria-expanded', 'true');
    expect(within(drawer).getByRole('group', { name: 'エリア（地方・都道府県）で絞り込む' })).toBeInTheDocument();
    expect(within(drawer).getByRole('checkbox', { name: '関東' })).toBeInTheDocument();

    await user.click(within(drawer).getByRole('button', { name: 'Close filter drawer' }));

    await waitFor(() => {
      expect(document.querySelector('[data-ui-drawer]')).not.toBeInTheDocument();
    });
  });

  it('SCR-STOCKIST-001 引き出しの中で選んでも引き出しは閉じない', async () => {
    const user = userEvent.setup();
    await renderStockistPage();

    await user.click(document.querySelector<HTMLElement>('[data-filter-button="floating"]') as HTMLElement);
    const drawer = await waitFor(() => {
      const node = document.querySelector<HTMLElement>('[data-ui-drawer]');
      if (!node) throw new Error('drawer not open');
      return node;
    });

    await user.click(within(drawer).getByRole('checkbox', { name: '北海道' }));

    expect(pushMock).toHaveBeenCalledWith('/stockist?pref=%E5%8C%97%E6%B5%B7%E9%81%93', { scroll: false });
    expect(document.querySelector('[data-ui-drawer]')).toBeInTheDocument();
  });

  it('SCR-STOCKIST-001 URL の pref にある県だけに最初の描画から絞り、その県のある地方を開いて県を選択済みにする', async () => {
    await renderStockistPage('東京都');

    expect(cardNames()).toEqual(['Shop 1', 'Shop 4']);
    expect(checkedLabels()).toEqual(['関東', '東京']);
    expect(filterPanel().getByRole('button', { name: '関東の都道府県を折りたたむ' })).toBeInTheDocument();
    expect(filterPanel().getByRole('checkbox', { name: 'ALL' })).not.toBeChecked();
  });

  it('SCR-STOCKIST-001 pref は前後の空白を無視してカンマで複数選べ、47都道府県に無い値は捨てる', async () => {
    await renderStockistPage('東京都, 大阪府 ,存在しない県,<script>');

    expect(cardNames()).toEqual(['Shop 1', 'Shop 2', 'Shop 4']);
  });

  it('SCR-STOCKIST-001 pref が全部 47都道府県に無い値なら ALL と同じに全件を出す', async () => {
    await renderStockistPage('存在しない県');

    expect(cardNames()).toHaveLength(5);
    expect(checkedLabels()).toEqual(['ALL']);
  });

  it('SCR-STOCKIST-001 県の選択は住所の先頭の県名と突き合わせ、県名が先頭に無い住所は選択中には出さない', async () => {
    mockStockists.current = [...SHOPS, makeShop(6, '渋谷区 東京都 6-6-6'), makeShop(7, '  東京都品川区 7-7-7')];

    await renderStockistPage('東京都');

    expect(cardNames()).toEqual(['Shop 1', 'Shop 4', 'Shop 7']);
  });

  it('SCR-STOCKIST-001 県を選ぶと定義順に並べた pref を付けて同じ道へ移し、選んだ県を外すと pref を消す', async () => {
    const user = userEvent.setup();
    await renderStockistPage('大阪府');

    await user.click(filterPanel().getByRole('button', { name: '関東の都道府県を展開' }));
    await user.click(filterPanel().getByRole('checkbox', { name: '東京' }));
    expect(pushMock).toHaveBeenLastCalledWith(`/stockist?pref=${encodeURIComponent('東京都,大阪府')}`, { scroll: false });

    await user.click(filterPanel().getByRole('checkbox', { name: '大阪' }));
    expect(pushMock).toHaveBeenLastCalledWith('/stockist', { scroll: false });
  });

  it('SCR-STOCKIST-001 北海道のような単一の地方は1つのチェックで選び、地方のチェックは中の県を全部選ぶ', async () => {
    const user = userEvent.setup();
    await renderStockistPage();

    await user.click(filterPanel().getByRole('checkbox', { name: '北海道' }));
    expect(pushMock).toHaveBeenLastCalledWith(`/stockist?pref=${encodeURIComponent('北海道')}`, { scroll: false });

    await user.click(filterPanel().getByRole('checkbox', { name: '関東' }));
    expect(pushMock).toHaveBeenLastCalledWith(`/stockist?pref=${encodeURIComponent('東京都')}`, { scroll: false });
  });

  it('SCR-STOCKIST-001 全部の県が選ばれた地方のチェックを押すと、その地方の県だけを外す', async () => {
    const user = userEvent.setup();
    await renderStockistPage('東京都,大阪府');

    expect(filterPanel().getByRole('checkbox', { name: '関東' })).toBeChecked();
    await user.click(filterPanel().getByRole('checkbox', { name: '関東' }));

    expect(pushMock).toHaveBeenLastCalledWith(`/stockist?pref=${encodeURIComponent('大阪府')}`, { scroll: false });
  });

  it('SCR-STOCKIST-001 ALL は選んだ県を全部外す', async () => {
    const user = userEvent.setup();
    await renderStockistPage('東京都');

    await user.click(filterPanel().getByRole('checkbox', { name: 'ALL' }));

    expect(pushMock).toHaveBeenLastCalledWith('/stockist', { scroll: false });
  });

  it('SCR-STOCKIST-001 pref 以外の query は選び直しても残す', async () => {
    const user = userEvent.setup();
    currentQuery = 'utm=campaign';
    const element = await StockistPage({ searchParams: Promise.resolve({ utm: 'campaign' }) });
    render(element);

    await user.click(filterPanel().getByRole('checkbox', { name: '北海道' }));

    expect(pushMock).toHaveBeenLastCalledWith(`/stockist?utm=campaign&pref=${encodeURIComponent('北海道')}`, { scroll: false });
  });

  it('SCR-STOCKIST-001 公開の店が0件の時は「該当する取扱店舗がございません。」と「すべて見る」を出す', async () => {
    mockStockists.current = [];

    await renderStockistPage();

    expect(screen.getByText('該当する取扱店舗がございません。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'すべて見る' })).toBeInTheDocument();
    expect(screen.queryAllByRole('heading', { level: 3 })).toHaveLength(0);
    expect(filterPanel().getAllByRole('checkbox')).toHaveLength(1);
  });

  it('SCR-STOCKIST-001 絞った結果が0件の時は、選んだ県を全部外す「すべて見る」で行き止まりにしない', async () => {
    const user = userEvent.setup();
    await renderStockistPage('沖縄県');

    expect(screen.getByText('該当する取扱店舗がございません。')).toBeInTheDocument();
    expect(screen.queryAllByRole('heading', { level: 3 })).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'すべて見る' }));

    expect(pushMock).toHaveBeenLastCalledWith('/stockist', { scroll: false });
  });

  it('SCR-STOCKIST-001 店舗名・住所は文字として出し、管理で書かれた HTML を解釈しない', async () => {
    mockStockists.current = [
      makeShop(1, '東京都<img src=x onerror=alert(1)>', { name: '<b>Bold shop</b>' }),
    ];

    await renderStockistPage();

    expect(screen.getByRole('heading', { level: 3, name: '<b>Bold shop</b>' })).toBeInTheDocument();
    expect(screen.getByText('東京都<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(document.querySelector('b')).not.toBeInTheDocument();
    expect(document.querySelector('img[src="x"]')).not.toBeInTheDocument();
  });
});
