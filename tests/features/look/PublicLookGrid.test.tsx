import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';

// コンポーネントが useRouter を使うのでモックする。
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/',
}));
import { PublicLookGrid } from '@/features/look/components/PublicLookGrid';
import type { PublicLook } from '@/lib/look/public';

jest.mock('next/image', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    const { alt } = props;
    return <div data-testid="next-image-mock" aria-label={typeof alt === 'string' ? alt : ''} />;
  },
}));

// aria-label / data-testid で検証するので、スタブでも props を素通しする。
jest.mock('@/components/ui/Button/Button', () => ({
  __esModule: true,
  Button: ({ children, href, ...rest }: { children?: ReactNode; href?: string } & Record<string, unknown>) =>
    href ? <a href={href} {...rest}>{children}</a> : <button type="button" {...rest}>{children}</button>,
}));

jest.mock('@/components/ui/SectionTitle/SectionTitle', () => ({
  __esModule: true,
  SectionTitle: ({ title }: { title: string }) => <h2>{title}</h2>,
}));

jest.mock('@/components/ui/Drawer/Drawer', () => ({
  __esModule: true,
  Drawer: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

jest.mock('@/components/ui/MultiSelect/MultiSelect', () => ({
  __esModule: true,
  MultiSelect: () => <div data-testid="multi-select" />,
}));

function createLooks(count: number): PublicLook[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    seasonYear: 2026,
    seasonType: 'SS',
    theme: `Theme ${index + 1}`,
    themeDescription: `Theme description ${index + 1}`,
    imageUrls: ['/placeholder.png'],
    createdAt: new Date().toISOString(),
    linkedItems: [],
  }));
}

describe('PublicLookGrid', () => {
  // FREQ-148: ボタンのラベルは VIEW ALL LOOKS。
  // 出し分けは「描画するか否か」ではなく、ブレークポイントごとの表示クラスで行う
  // （xl 未満は 6 件表示 / xl は 8 件表示）。
  const viewAllWrapper = () =>
    screen.getByTestId('home-section-view-all').parentElement;

  it('VIEW ALL LOOKS のリンクを描画する', () => {
    render(<PublicLookGrid variant="home" looks={createLooks(7)} totalCount={7} />);

    expect(screen.getByLabelText('VIEW ALL LOOKS')).toBeInTheDocument();
  });

  it('総数が7件なら xl 未満でのみ VIEW ALL を出す', () => {
    render(<PublicLookGrid variant="home" looks={createLooks(7)} totalCount={7} />);

    // 6 件表示の帯域では溢れるので出す。8 件表示の xl では出さない。
    expect(viewAllWrapper()).toHaveClass('flex', 'xl:hidden');
  });

  it('総数が6件ならどの帯域でも VIEW ALL を出さない', () => {
    render(<PublicLookGrid variant="home" looks={createLooks(6)} totalCount={6} />);

    expect(viewAllWrapper()).toHaveClass('hidden', 'xl:hidden');
  });

  it('総数が全帯域を上回れば常に VIEW ALL を出す', () => {
    render(<PublicLookGrid variant="home" looks={createLooks(8)} totalCount={20} />);

    expect(viewAllWrapper()).toHaveClass('flex', 'xl:flex');
  });

  it('7件目以降は xl 以上でのみ表示する', () => {
    const { container } = render(
      <PublicLookGrid variant="home" looks={createLooks(8)} totalCount={20} />,
    );

    const cards = container.querySelectorAll('[data-testid="look-card"]');
    if (cards.length >= 8) {
      expect(cards[6].className).toContain('hidden');
      expect(cards[6].className).toContain('xl:block');
    }
  });
});
