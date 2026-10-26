import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { PublicLookGrid } from '@/features/look/components/PublicLookGrid';
import type { PublicLookListItem } from '@/lib/look/public';

jest.mock('next/link', () => {
  return ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  );
});

jest.mock('next/image', () => ({
  __esModule: true,
  default: ({ src, alt, ...rest }: { src: string; alt: string; fill?: boolean; sizes?: string }) => {
    const { fill: _fill, sizes: _sizes, ...passthrough } = rest;
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={alt} {...passthrough} />;
  },
}));

// ホームの URL に season が付いていても、区画は絞らないことを確かめるために season を入れておく
jest.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: jest.fn() }),
  useSearchParams: () => new URLSearchParams('season=SS'),
}));

function makeLooks(count: number): PublicLookListItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    seasonYear: 2026,
    seasonType: index % 2 === 0 ? 'SS' : 'AW',
    theme: `Theme ${index + 1}`,
    imageUrls: [`https://signed.test/look-${index + 1}.jpg`],
    createdAt: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
    linkedItems: [],
  }));
}

function viewAllWrapper(): HTMLElement {
  const wrapper = screen.getByRole('link', { name: 'VIEW ALL LOOKS' }).parentElement;
  if (!wrapper) {
    throw new Error('VIEW ALL wrapper not found');
  }
  return wrapper;
}

describe('SCR-LOOK-003 home look section', () => {
  it('SCR-LOOK-003 section#look の中に下線付きの見出し LOOK と、一覧と同じ格子・カードを出す', () => {
    const { container } = render(<PublicLookGrid variant="home" looks={makeLooks(3)} totalCount={3} />);

    const section = container.querySelector('section#look');
    expect(section).toBeInTheDocument();
    const heading = within(section as HTMLElement).getByRole('heading', { level: 2, name: 'LOOK' });
    expect(heading).toHaveClass('underline');
    const cards = within(section as HTMLElement).getAllByTestId('look-card');
    expect(cards).toHaveLength(3);
    expect(cards[0].parentElement).toHaveClass('grid', 'grid-cols-2', 'md:grid-cols-3', '2xl:grid-cols-4');
    expect(within(cards[0]).getByTestId('look-card-caption')).toHaveAttribute('href', '/look/1');
  });

  it('SCR-LOOK-003 渡された並びのまま8件まで描き、7件目と8件目は 2xl 以上だけで出す', () => {
    render(<PublicLookGrid variant="home" looks={makeLooks(10)} totalCount={10} />);

    const cards = screen.getAllByTestId('look-card');
    expect(cards).toHaveLength(8);
    expect(
      cards.map((card) => within(card).getByTestId('look-card-caption').textContent),
    ).toEqual(Array.from({ length: 8 }, (_, index) => expect.stringContaining(`Theme ${index + 1}`)));
    cards.slice(0, 6).forEach((card) => expect(card).not.toHaveClass('hidden'));
    cards.slice(6).forEach((card) => expect(card).toHaveClass('hidden', '2xl:block'));
  });

  it('SCR-LOOK-003 8件に満たない時は渡された件数だけを描く', () => {
    render(<PublicLookGrid variant="home" looks={makeLooks(5)} totalCount={5} />);

    expect(screen.getAllByTestId('look-card')).toHaveLength(5);
    screen.getAllByTestId('look-card').forEach((card) => expect(card).not.toHaveClass('hidden'));
  });

  it('SCR-LOOK-003 区画の下に読み上げの名前が VIEW ALL LOOKS で行き先が /look のボタンを置く', () => {
    render(<PublicLookGrid variant="home" looks={makeLooks(9)} totalCount={9} />);

    const link = screen.getByRole('link', { name: 'VIEW ALL LOOKS' });
    expect(link).toHaveAttribute('href', '/look');
    expect(link).toHaveTextContent('VIEW ALL');
    expect(screen.getByTestId('home-section-view-all')).toBe(link);
  });

  it.each([
    [9, ['flex', '2xl:flex'], ['hidden', '2xl:hidden']],
    [8, ['flex', '2xl:hidden'], ['hidden', '2xl:flex']],
    [7, ['flex', '2xl:hidden'], ['hidden', '2xl:flex']],
    [6, ['hidden', '2xl:hidden'], ['flex', '2xl:flex']],
    [0, ['hidden', '2xl:hidden'], ['flex', '2xl:flex']],
  ])('SCR-LOOK-003 総数が%i件の時の VIEW ALL は %j の帯域の指定になる', (totalCount, present, absent) => {
    render(<PublicLookGrid variant="home" looks={makeLooks(Math.min(totalCount, 8))} totalCount={totalCount} />);

    const wrapper = viewAllWrapper();
    for (const name of present) {
      expect(wrapper).toHaveClass(name);
    }
    for (const name of absent) {
      expect(wrapper).not.toHaveClass(name);
    }
  });

  it('SCR-LOOK-003 総数を渡さない時は VIEW ALL を隠さない', () => {
    render(<PublicLookGrid variant="home" looks={makeLooks(2)} />);

    const wrapper = viewAllWrapper();
    expect(wrapper).not.toHaveClass('hidden');
    expect(wrapper).not.toHaveClass('2xl:hidden');
    expect(wrapper).not.toHaveClass('2xl:flex');
  });

  it('SCR-LOOK-003 総数の取り出しに失敗して 0 になった時は、LOOK が描かれていても VIEW ALL を隠す', () => {
    render(<PublicLookGrid variant="home" looks={makeLooks(3)} totalCount={0} />);

    expect(viewAllWrapper()).toHaveClass('hidden', '2xl:hidden');
    expect(screen.getAllByTestId('look-card')).toHaveLength(3);
  });

  it('SCR-LOOK-003 LOOK が0件の時は「公開中のLOOKがありません」を出し、カードを出さない', () => {
    render(<PublicLookGrid variant="home" looks={[]} totalCount={0} />);

    expect(screen.getByRole('heading', { level: 2, name: 'LOOK' })).toBeInTheDocument();
    expect(screen.getByText('公開中のLOOKがありません')).toBeInTheDocument();
    expect(screen.queryAllByTestId('look-card')).toHaveLength(0);
    expect(viewAllWrapper()).toHaveClass('hidden', '2xl:hidden');
  });

  it('SCR-LOOK-003 ホームの区画にはシーズンの絞り込みを置かず、URL の season でも絞らない', () => {
    render(<PublicLookGrid variant="home" looks={makeLooks(4)} totalCount={4} />);

    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'FILTER' })).not.toBeInTheDocument();
    expect(screen.getAllByTestId('look-card')).toHaveLength(4);
  });
});
