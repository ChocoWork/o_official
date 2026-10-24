/**
 * ホーム `/` の ABOUT の区画（SCR-HOME-003）を、ページ本体 `Home` を描いて確かめる結合テスト。
 * 取得の関数と範囲外の格子の部品は差し替え、ABOUT の見出し・文・3本柱・ボタン・画像を実物の部品で描く。
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import Home from '@/app/page';

jest.mock('next/image', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    const { src, alt, className, sizes, fill } = props;
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src as string}
        alt={alt as string}
        className={className as string}
        sizes={sizes as string}
        data-fill={fill ? 'true' : 'false'}
      />
    );
  },
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

jest.mock('@/lib/items/public', () => ({
  getPublishedItems: jest.fn().mockResolvedValue([]),
  getPublishedItemsCount: jest.fn().mockResolvedValue(0),
}));
jest.mock('@/lib/look/server', () => ({
  getPublishedLooks: jest.fn().mockResolvedValue([]),
  getPublishedLooksCount: jest.fn().mockResolvedValue(0),
}));
jest.mock('@/features/news/services/public', () => ({
  getPublishedNews: jest.fn().mockResolvedValue([]),
  getPublishedNewsCount: jest.fn().mockResolvedValue(0),
}));
jest.mock('@/features/stockist/services/public', () => ({
  getHomePublicStockists: jest.fn().mockResolvedValue([]),
}));
jest.mock('@/features/items/components/PublicItemGrid', () => ({
  PublicItemGrid: () => <div data-testid="stub-item-grid" />,
}));
jest.mock('@/features/look/components/PublicLookGrid', () => ({
  PublicLookGrid: () => <div data-testid="stub-look-grid" />,
}));
jest.mock('@/features/news/components/PublicNewsGrid', () => ({
  PublicNewsGrid: () => <div data-testid="stub-news-grid" />,
}));
jest.mock('@/features/stockist/components/PublicStockistGrid', () => ({
  PublicStockistGrid: () => <div data-testid="stub-stockist-grid" />,
}));
jest.mock('@/features/search/components/SearchHomePreview', () => ({
  SearchHomePreview: () => null,
}));

const PILLARS = [
  {
    en: 'TIMELSS & UNISEX',
    ja: 'タイムレス＆ユニセックス',
    body: '時代も性別もサイズも超えてフリーな着こなしを。古着になっても時を超えて誰かに手に取ってもらえる服を。',
  },
  {
    en: 'NATURAL FIBERS',
    ja: '天然繊維100%',
    body: '洗うほど馴染み、役目を終えれば土に還る。古着のような確かな厚みと手触りを。',
  },
  {
    en: 'MADE TO ORDER',
    ja: '国内受注生産',
    body: '必要なときに、必要な人に、必要な分だけ。日本の技術を次世代に紡ぐ。',
  },
];

async function renderAbout(): Promise<HTMLElement> {
  const ui = await Home();
  const { container } = render(ui);
  const about = container.querySelector<HTMLElement>('section#about');
  if (!about) {
    throw new Error('ABOUT section not found');
  }
  return about;
}

function isBefore(first: Element, second: Element): boolean {
  return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
}

describe('ホームの ABOUT の区画', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: jest.fn().mockImplementation(() => ({
        matches: false,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      })),
    });
  });

  it('SCR-HOME-003 区画は id を about にした section で、見出しは共通の見出しの部品による h2 の ABOUT にする', async () => {
    const about = await renderAbout();

    expect(about).toHaveClass('section-space-about');
    const heading = within(about).getByRole('heading', { level: 2, name: 'ABOUT' });
    expect(heading).toHaveClass('section-title__heading');
    expect(screen.getAllByRole('heading', { level: 2, name: 'ABOUT' })).toHaveLength(1);
  });

  it('SCR-HOME-003 考えの文を2つ、ブランドの大きさのトークンを style で当てて出す', async () => {
    const about = await renderAbout();

    const first = within(about).getByText('長く着られる服だけをつくる。それが、唯一のこだわり。');
    const second = within(about).getByText('流行ではなく、タイムレスなシルエットと素材を。');
    for (const paragraph of [first, second]) {
      expect(paragraph.tagName).toBe('P');
      expect(paragraph).toHaveClass('about-main-text');
      expect(paragraph.style.fontSize).toBe('var(--lk-size-sm)');
    }
    expect(isBefore(first, second)).toBe(true);
  });

  it('SCR-HOME-003 3本柱は英字の題を h3 にして、日本語・説明と共に決まった順に縦へ並べる', async () => {
    const about = await renderAbout();

    const titles = within(about).getAllByRole('heading', { level: 3 });
    expect(titles.map((title) => title.textContent)).toEqual(PILLARS.map((pillar) => pillar.en));
    for (const title of titles) {
      expect(title).toHaveClass('about-secondary-title', 'font-brand');
      expect(title.style.fontSize).toBe('var(--lk-size-3xs)');
    }
    PILLARS.forEach((pillar, index) => {
      const block = titles[index].parentElement as HTMLElement;
      expect(within(block).getByText(pillar.ja)).toBeInTheDocument();
      expect(within(block).getByText(pillar.body)).toHaveClass('about-main-text');
    });
  });

  it('SCR-HOME-003 3本柱の外側は上下に細い罫線を引き、柱の間にも仕切りの線を引く', async () => {
    const about = await renderAbout();

    const pillars = within(about).getAllByRole('heading', { level: 3 })[0].parentElement?.parentElement as HTMLElement;
    expect(pillars).toHaveClass('divide-y', 'divide-black/10', 'border-t', 'border-b', 'border-black/10');
    expect(pillars.children).toHaveLength(3);
  });

  it('SCR-HOME-003 左の列は見出し・考えの文・3本柱・READ OUR STORY の順に並ぶ', async () => {
    const about = await renderAbout();

    const heading = within(about).getByRole('heading', { level: 2, name: 'ABOUT' });
    const firstText = within(about).getByText('長く着られる服だけをつくる。それが、唯一のこだわり。');
    const firstPillar = within(about).getByRole('heading', { level: 3, name: PILLARS[0].en });
    const lastPillar = within(about).getByRole('heading', { level: 3, name: PILLARS[2].en });
    const button = within(about).getByRole('link', { name: 'READ OUR STORY' });

    expect(isBefore(heading, firstText)).toBe(true);
    expect(isBefore(firstText, firstPillar)).toBe(true);
    expect(isBefore(lastPillar, button)).toBe(true);
  });

  it('SCR-HOME-003 READ OUR STORY のボタンは常にあり、行き先は /about で、控えめな secondary の最小の大きさにする', async () => {
    const about = await renderAbout();

    const button = within(about).getByRole('link', { name: 'READ OUR STORY' });
    expect(button).toHaveAttribute('href', '/about');
    expect(button).toHaveAttribute('data-ui-button-variant', 'secondary');
    expect(button).toHaveAttribute('data-ui-button-size', 'xs');
  });

  it('SCR-HOME-003 画像は手元の /about.png を3:4の枠いっぱいに出し、代替テキストを About Le Fil des Heures にする', async () => {
    const about = await renderAbout();

    const image = within(about).getByRole('img', { name: 'About Le Fil des Heures' });
    expect(image).toHaveAttribute('src', '/about.png');
    expect(image).toHaveAttribute('data-fill', 'true');
    expect(image).toHaveAttribute('sizes', '(min-width: 768px) 50vw, 100vw');
    const frame = image.parentElement as HTMLElement;
    expect(frame).toHaveClass('relative', 'aspect-3/4', 'overflow-hidden');
  });

  it('SCR-HOME-003 768px 以上は左に文3・右に画像2の2列にし、768px 未満は画像を上、文を下に積む', async () => {
    const about = await renderAbout();

    const image = within(about).getByRole('img', { name: 'About Le Fil des Heures' });
    const imageColumn = image.parentElement?.parentElement as HTMLElement;
    const grid = imageColumn.parentElement as HTMLElement;
    const textColumn = within(about).getByRole('heading', { level: 2, name: 'ABOUT' }).closest('div.order-2') as HTMLElement;

    expect(grid).toHaveClass('grid', 'grid-cols-1', 'md:grid-cols-[3fr_2fr]');
    expect(textColumn).toHaveClass('order-2', 'md:order-1');
    expect(imageColumn).toHaveClass('order-1', 'md:order-2');
    expect(textColumn.parentElement).toBe(grid);
  });

  it('SCR-HOME-003 ABOUT の区画に独立した CONCEPT の見出しや検索の窓の直後の CONCEPT の抜粋を置かない', async () => {
    await renderAbout();

    expect(screen.queryByText(/CONCEPT/)).toBeNull();
    expect(screen.queryByRole('heading', { name: /CONCEPT/ })).toBeNull();
  });
});
