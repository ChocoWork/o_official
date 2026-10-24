/**
 * 地方と都道府県の対応 `STOCKIST_REGIONS`（DATA-STOCKIST-003）を確かめる結合テスト。
 * 定義そのものの形（8つの地方・47都道府県）と、住所の先頭から県を決める関数、
 * 一覧の絞り込みの部品が同じ定義を選択肢と URL の許可の一覧に使っていることを、実物の部品を描いて比べる。
 */
import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen, within } from '@testing-library/react';
import { PublicStockistGrid } from '@/features/stockist/components/PublicStockistGrid';
import {
  getPrefectureFromAddress,
  getPrefectureShortLabel,
  STOCKIST_REGIONS,
} from '@/features/stockist/region';
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

// 地方の定義の順に書いた47都道府県の正式な名前
const EXPECTED_PREFECTURES = [
  '北海道',
  '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県',
  '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県',
  '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県',
  '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
];

const ALL_PREFECTURES: string[] = STOCKIST_REGIONS.flatMap((entry) => [...entry.prefectures]);

function shopIn(prefecture: string, id: number): PublicStockist {
  return {
    id,
    name: `Shop ${prefecture}`,
    address: `${prefecture}テスト市1-1`,
    phone: '03-1234-5678',
    time: '11:00-19:00',
    holiday: '水曜',
  };
}

const SHOPS_IN_EVERY_PREFECTURE = ALL_PREFECTURES.map((prefecture, index) => shopIn(prefecture, index + 1));

function queryOf(pref: string): string {
  return new URLSearchParams({ pref }).toString();
}

function renderCatalog(stockists: PublicStockist[], search = '') {
  currentSearch = search;
  return render(<PublicStockistGrid variant="catalog" stockists={stockists} />);
}

function panel() {
  return within(screen.getByRole('complementary'));
}

function checkboxLabels(): string[] {
  return panel()
    .getAllByRole('checkbox')
    .map((box) => box.parentElement?.textContent ?? '');
}

function shownShops(): string[] {
  return screen.queryAllByRole('heading', { level: 3 }).map((node) => node.textContent ?? '');
}

async function expandAllRegions() {
  const user = userEvent.setup();
  for (const button of screen.getAllByRole('button', { name: /の都道府県を展開$/ })) {
    await user.click(button);
  }
}

describe('DATA-STOCKIST-003 stockist region data', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    currentSearch = '';
  });

  it('DATA-STOCKIST-003 地方は8つで、北から南の決まった順に並び、県の数は 1・6・7・9・7・5・4・8', () => {
    expect(STOCKIST_REGIONS.map((entry) => entry.region)).toEqual([
      '北海道',
      '東北',
      '関東',
      '中部',
      '近畿',
      '中国',
      '四国',
      '九州・沖縄',
    ]);
    expect(STOCKIST_REGIONS.map((entry) => entry.prefectures.length)).toEqual([1, 6, 7, 9, 7, 5, 4, 8]);
  });

  it('DATA-STOCKIST-003 都道府県は47で、重複が無く、正式な名前の定義の順に並ぶ', () => {
    expect(ALL_PREFECTURES).toHaveLength(47);
    expect(new Set(ALL_PREFECTURES).size).toBe(47);
    expect(ALL_PREFECTURES).toEqual(EXPECTED_PREFECTURES);
  });

  it('DATA-STOCKIST-003 住所が県名で始まる時は、47のどれでもその県名を返す', () => {
    for (const prefecture of ALL_PREFECTURES) {
      expect(getPrefectureFromAddress(`${prefecture}テスト市1-1`)).toBe(prefecture);
    }
  });

  it('DATA-STOCKIST-003 住所の前後の空白は除いてから県を決め、京都府と東京都のように名が重なる県も取り違えない', () => {
    expect(getPrefectureFromAddress('  　京都府京都市中京区 ')).toBe('京都府');
    expect(getPrefectureFromAddress('東京都京橋1-1')).toBe('東京都');
    expect(getPrefectureFromAddress('北海道札幌市')).toBe('北海道');
  });

  it('DATA-STOCKIST-003 住所の先頭が県名でない時は県なし（null）にする', () => {
    expect(getPrefectureFromAddress('')).toBeNull();
    expect(getPrefectureFromAddress('   ')).toBeNull();
    expect(getPrefectureFromAddress('パリ市1区')).toBeNull();
    expect(getPrefectureFromAddress('〒150-0001 東京都渋谷区')).toBeNull();
    expect(getPrefectureFromAddress('日本 東京都渋谷区')).toBeNull();
    expect(getPrefectureFromAddress('東京')).toBeNull();
  });

  it('DATA-STOCKIST-003 短い名は北海道だけそのままにし、ほかは末尾の都・府・県を1字消す', () => {
    expect(getPrefectureShortLabel('北海道')).toBe('北海道');
    expect(getPrefectureShortLabel('東京都')).toBe('東京');
    expect(getPrefectureShortLabel('大阪府')).toBe('大阪');
    expect(getPrefectureShortLabel('京都府')).toBe('京都');
    expect(getPrefectureShortLabel('神奈川県')).toBe('神奈川');

    const shortLabels = ALL_PREFECTURES.map(getPrefectureShortLabel);
    expect(new Set(shortLabels).size).toBe(47);
    for (const prefecture of ALL_PREFECTURES.filter((name) => name !== '北海道')) {
      expect(getPrefectureShortLabel(prefecture)).toBe(prefecture.slice(0, -1));
    }
  });

  it('DATA-STOCKIST-003 47都道府県すべてに店がある時、一覧は8つの地方を定義の順に、各地方の下の県を定義の順に出す', async () => {
    renderCatalog(SHOPS_IN_EVERY_PREFECTURE);

    expect(checkboxLabels()).toEqual(['ALL', '北海道', '東北', '関東', '中部', '近畿', '中国', '四国', '九州・沖縄']);

    await expandAllRegions();

    const expected = ['ALL'];
    for (const entry of STOCKIST_REGIONS) {
      expected.push(entry.region);
      if (entry.prefectures.length > 1) {
        expected.push(...entry.prefectures.map(getPrefectureShortLabel));
      }
    }
    expect(checkboxLabels()).toEqual(expected);
    expect(checkboxLabels()).toHaveLength(1 + 8 + 46);
  });

  it('DATA-STOCKIST-003 店のある県だけを選択肢にし、店が無い県と地方は出さない（県が1つだけの地方も親子のまま）', async () => {
    renderCatalog([shopIn('沖縄県', 1)]);

    expect(checkboxLabels()).toEqual(['ALL', '九州・沖縄']);

    await userEvent.setup().click(screen.getByRole('button', { name: '九州・沖縄の都道府県を展開' }));

    expect(checkboxLabels()).toEqual(['ALL', '九州・沖縄', '沖縄']);
  });

  it('DATA-STOCKIST-003 pref に47の正式な名前のどれを書いても、その県の店だけを出す', () => {
    const view = renderCatalog(SHOPS_IN_EVERY_PREFECTURE);

    for (const prefecture of ALL_PREFECTURES) {
      currentSearch = queryOf(prefecture);
      view.rerender(<PublicStockistGrid variant="catalog" stockists={SHOPS_IN_EVERY_PREFECTURE} />);

      expect(shownShops()).toEqual([`Shop ${prefecture}`]);
    }
  });

  it('DATA-STOCKIST-003 pref に短い名や定義に無い名を書いても許可の一覧に入らず、選択なし（ALL）として全部の店を出す', () => {
    renderCatalog(SHOPS_IN_EVERY_PREFECTURE, queryOf('東京,大阪,Tokyo,東京府,沖縄'));

    expect(shownShops()).toHaveLength(47);
    expect(panel().getByRole('checkbox', { name: 'ALL' })).toBeChecked();
  });

  it('DATA-STOCKIST-003 pref の書き戻しは、選ぶ順でなく定義の順に並べる（47すべてを選んでも47のまま）', async () => {
    const reversedOthers = [...ALL_PREFECTURES].reverse().filter((name) => name !== '北海道');
    renderCatalog(SHOPS_IN_EVERY_PREFECTURE, queryOf(reversedOthers.join(',')));

    await userEvent.setup().click(screen.getByRole('checkbox', { name: '北海道' }));

    expect(pushMock).toHaveBeenCalledTimes(1);
    const [target] = pushMock.mock.calls[0] as [string];
    const written = new URLSearchParams(target.split('?')[1]).get('pref');
    expect(written?.split(',')).toEqual(ALL_PREFECTURES);
  });
});
