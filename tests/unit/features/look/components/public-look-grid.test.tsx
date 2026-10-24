import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { PublicLookGrid } from '@/features/look/components/PublicLookGrid';
import type { PublicLook } from '@/lib/look/public';

const mockPush = jest.fn();
let mockSearchParams = new URLSearchParams();
let mockPathname = '/look';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => mockSearchParams,
  usePathname: () => mockPathname,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

jest.mock('next/image', () => ({
  __esModule: true,
  default: ({
    src,
    alt,
    className,
    ...rest
  }: { src: string; alt: string; className?: string } & Record<string, unknown>) => {
    const testId = rest['data-testid'];
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={alt}
        className={className}
        data-testid={typeof testId === 'string' ? testId : 'look-card-image'}
      />
    );
  },
}));

jest.mock('@/components/animations/ScrollReveal', () => ({
  __esModule: true,
  default: ({
    children,
    className,
    'data-testid': testId,
  }: {
    children?: ReactNode;
    className?: string;
    'data-testid'?: string;
  }) => (
    <div data-testid={testId} className={className}>
      {children}
    </div>
  ),
}));

jest.mock('@/features/home/components/HomeSectionViewAll', () => ({
  __esModule: true,
  HomeSectionViewAll: ({
    href,
    ariaLabel,
    className,
  }: {
    href: string;
    ariaLabel: string;
    className?: string;
  }) => (
    <div data-testid="view-all-wrapper" className={className}>
      <a href={href} aria-label={ariaLabel} data-testid="home-section-view-all">
        VIEW ALL
      </a>
    </div>
  ),
}));

jest.mock('@/components/ui/SectionTitle/SectionTitle', () => ({
  __esModule: true,
  SectionTitle: ({ title }: { title: string }) => <h2>{title}</h2>,
}));

jest.mock('@/components/ui/Button/Button', () => ({
  __esModule: true,
  Button: ({
    children,
    variant: _variant,
    size: _size,
    shape: _shape,
    ...rest
  }: { children?: ReactNode } & Record<string, unknown>) => (
    <button type="button" {...rest}>
      {children}
    </button>
  ),
}));

jest.mock('@/components/ui/Drawer/Drawer', () => ({
  __esModule: true,
  Drawer: ({
    open,
    onClose,
    children,
  }: {
    open: boolean;
    onClose: () => void;
    children?: ReactNode;
  }) => (
    <div data-testid="filter-drawer" data-open={String(open)}>
      <button type="button" data-testid="drawer-on-close" onClick={onClose}>
        drawer-on-close
      </button>
      {children}
    </div>
  ),
}));

type MockMultiSelectProps = {
  values: string[];
  onChange: (values: string[]) => void;
  size: string;
  expandLabelHitArea?: boolean;
  options: { value: string; label: string }[];
  renderOptionLabel: (option: { value: string; label: string }) => ReactNode;
};
const mockMultiSelectProps: Record<string, MockMultiSelectProps> = {};

jest.mock('@/components/ui/MultiSelect/MultiSelect', () => ({
  __esModule: true,
  MultiSelect: (props: MockMultiSelectProps) => {
    mockMultiSelectProps[props.size] = props;
    return (
      <div
        data-testid={`multi-select-${props.size}`}
        data-values={props.values.join(',')}
        data-expand={String(Boolean(props.expandLabelHitArea))}
      >
        {props.options.map((option) => (
          <span key={option.value}>{props.renderOptionLabel(option)}</span>
        ))}
      </div>
    );
  },
}));

function createLook(overrides: Partial<PublicLook> & { id: number }): PublicLook {
  return {
    seasonYear: 2026,
    seasonType: 'SS',
    theme: `Theme ${overrides.id}`,
    themeDescription: `Theme description ${overrides.id}`,
    imageUrls: ['/look-1.png'],
    createdAt: '2026-01-01T00:00:00.000Z',
    linkedItems: [],
    ...overrides,
  };
}

function createLooks(count: number): PublicLook[] {
  return Array.from({ length: count }, (_, index) => createLook({ id: index + 1 }));
}

const LINKED_ITEM = {
  category: 'tops',
  id: 77,
  name: 'Linen Shirt',
  price: 12000,
  imageUrl: '/item-77.png',
};

function setSearch(query: string) {
  mockSearchParams = new URLSearchParams(query);
}

function select(size: string, values: string[]) {
  act(() => {
    mockMultiSelectProps[size].onChange(values);
  });
}

beforeEach(() => {
  mockPush.mockReset();
  mockSearchParams = new URLSearchParams();
  mockPathname = '/look';
  for (const key of Object.keys(mockMultiSelectProps)) {
    delete mockMultiSelectProps[key];
  }
});

describe('PublicLookGrid home', () => {
  it('DD-LOOK-001 テスト観点#1 home で8件に切り、7件目と8件目だけ 2xl 以上で出す', () => {
    render(<PublicLookGrid variant="home" looks={createLooks(9)} totalCount={9} />);

    const cards = screen.getAllByTestId('look-card');
    expect(cards).toHaveLength(8);
    expect(cards[5].className).not.toContain('hidden 2xl:block');
    expect(cards[6].className).toContain('hidden 2xl:block');
    expect(cards[7].className).toContain('hidden 2xl:block');
    expect(screen.queryByText('Theme 9', { selector: 'h3' })).not.toBeInTheDocument();
  });

  it('DD-LOOK-001 テスト観点#1 home は section#look と見出し LOOK を描く', () => {
    const { container } = render(
      <PublicLookGrid variant="home" looks={createLooks(1)} totalCount={1} />,
    );

    expect(container.querySelector('section#look')).not.toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'LOOK' })).toBeInTheDocument();
  });

  it('DD-LOOK-001 テスト観点#2 totalCount が無ければ VIEW ALL に class を付けない', () => {
    render(<PublicLookGrid variant="home" looks={createLooks(3)} />);

    expect(screen.getByTestId('view-all-wrapper')).not.toHaveAttribute('class');
  });

  it('DD-LOOK-001 テスト観点#3 総数 6 は全帯域で VIEW ALL を隠す', () => {
    render(<PublicLookGrid variant="home" looks={createLooks(6)} totalCount={6} />);

    expect(screen.getByTestId('view-all-wrapper')).toHaveClass('hidden', '2xl:hidden');
    expect(screen.getByTestId('view-all-wrapper')).not.toHaveClass('flex');
  });

  it('DD-LOOK-001 テスト観点#4 総数 7 と 8 は 2xl 未満でだけ VIEW ALL を出す', () => {
    const { rerender } = render(
      <PublicLookGrid variant="home" looks={createLooks(7)} totalCount={7} />,
    );
    expect(screen.getByTestId('view-all-wrapper')).toHaveClass('flex', '2xl:hidden');

    rerender(<PublicLookGrid variant="home" looks={createLooks(8)} totalCount={8} />);
    expect(screen.getByTestId('view-all-wrapper')).toHaveClass('flex', '2xl:hidden');
    expect(screen.getByTestId('view-all-wrapper')).not.toHaveClass('2xl:flex');
  });

  it('DD-LOOK-001 テスト観点#5 総数 9 は全帯域で VIEW ALL を出し、行き先と名前を渡す', () => {
    render(<PublicLookGrid variant="home" looks={createLooks(8)} totalCount={9} />);

    expect(screen.getByTestId('view-all-wrapper')).toHaveClass('flex', '2xl:flex');
    const link = screen.getByLabelText('VIEW ALL LOOKS');
    expect(link).toHaveAttribute('href', '/look');
  });

  it('DD-LOOK-001 テスト観点#6 home で LOOK が0件なら空の文を出し、VIEW ALL は総数の決まりのまま', () => {
    render(<PublicLookGrid variant="home" looks={[]} totalCount={0} />);

    expect(screen.getByText('公開中のLOOKがありません')).toBeInTheDocument();
    expect(screen.queryByTestId('look-card')).not.toBeInTheDocument();
    expect(screen.getByTestId('view-all-wrapper')).toHaveClass('hidden', '2xl:hidden');
  });

  it('DD-LOOK-001 テスト観点#7 home の格子に className があればそれを使う', () => {
    render(
      <PublicLookGrid variant="home" looks={createLooks(2)} className="custom-home-grid" />,
    );

    expect(screen.getAllByTestId('look-card')[0].parentElement).toHaveClass('custom-home-grid');
  });

  it('DD-LOOK-001 テスト観点#7 home の格子に className が無ければ既定の格子 class を使う', () => {
    render(<PublicLookGrid variant="home" looks={createLooks(2)} />);

    expect(screen.getAllByTestId('look-card')[0].parentElement).toHaveClass(
      'grid',
      'grid-cols-2',
      'md:grid-cols-3',
      '2xl:grid-cols-4',
    );
  });

  it('DD-LOOK-001 テスト観点#1 home の先頭6件のカードには出し分けの class を付けない', () => {
    render(<PublicLookGrid variant="home" looks={createLooks(6)} totalCount={6} />);

    for (const card of screen.getAllByTestId('look-card')) {
      expect(card.className).toBe('border border-black/10 lg:border-0');
    }
  });
});

describe('PublicLookGrid catalog 初めの選択と URL', () => {
  const mixedLooks = [
    createLook({ id: 1, seasonType: 'SS', theme: 'Spring' }),
    createLook({ id: 2, seasonType: 'AW', theme: 'Autumn' }),
  ];

  it('DD-LOOK-001 テスト観点#8 URL も initialSeason も無ければ ALL が選ばれ全部が出る', () => {
    render(<PublicLookGrid variant="catalog" looks={mixedLooks} />);

    expect(screen.getAllByTestId('look-card')).toHaveLength(2);
    expect(screen.getByTestId('multi-select-3xs')).toHaveAttribute('data-values', 'ALL');
  });

  it('DD-LOOK-001 テスト観点#9 URL の season=aw は AW だけを出す', () => {
    setSearch('season=aw');
    render(<PublicLookGrid variant="catalog" looks={mixedLooks} />);

    expect(screen.getAllByTestId('look-card')).toHaveLength(1);
    expect(screen.getAllByText('Autumn').length).toBeGreaterThan(0);
    expect(screen.queryByText('Spring')).not.toBeInTheDocument();
    expect(screen.getByTestId('multi-select-3xs')).toHaveAttribute('data-values', 'AW');
  });

  it('DD-LOOK-001 URL に season が無ければ initialSeason を使う', () => {
    render(<PublicLookGrid variant="catalog" looks={mixedLooks} initialSeason="SS" />);

    expect(screen.getAllByTestId('look-card')).toHaveLength(1);
    expect(screen.getAllByText('Spring').length).toBeGreaterThan(0);
  });

  it('DD-LOOK-001 URL の season が正しくなければ initialSeason に戻す', () => {
    setSearch('season=winter');
    render(<PublicLookGrid variant="catalog" looks={mixedLooks} initialSeason="SS" />);

    expect(screen.getByTestId('multi-select-3xs')).toHaveAttribute('data-values', 'SS');
  });

  it('DD-LOOK-001 テスト観点#10 URL が変わったら選択を合わせる', () => {
    const { rerender } = render(<PublicLookGrid variant="catalog" looks={mixedLooks} />);
    expect(screen.getAllByTestId('look-card')).toHaveLength(2);

    setSearch('season=SS');
    rerender(<PublicLookGrid variant="catalog" looks={mixedLooks} />);

    expect(screen.getByTestId('multi-select-3xs')).toHaveAttribute('data-values', 'SS');
    expect(screen.getAllByTestId('look-card')).toHaveLength(1);
    expect(screen.getAllByText('Spring').length).toBeGreaterThan(0);
  });

  it('DD-LOOK-001 テスト観点#11 URL が同じ値のまま描き直しても選択は変わらない', () => {
    setSearch('season=AW');
    const { rerender } = render(<PublicLookGrid variant="catalog" looks={mixedLooks} />);

    setSearch('season=aw');
    rerender(<PublicLookGrid variant="catalog" looks={mixedLooks} />);

    expect(screen.getByTestId('multi-select-3xs')).toHaveAttribute('data-values', 'AW');
    expect(mockPush).not.toHaveBeenCalled();
  });
});

describe('PublicLookGrid catalog 選択の操作', () => {
  const mixedLooks = [
    createLook({ id: 1, seasonType: 'SS', theme: 'Spring' }),
    createLook({ id: 2, seasonType: 'AW', theme: 'Autumn' }),
  ];

  it('DD-LOOK-001 テスト観点#12 SS を選ぶと状態を変えて URL に season=SS を書く', () => {
    render(<PublicLookGrid variant="catalog" looks={mixedLooks} />);

    select('3xs', ['ALL', 'SS']);

    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/look?season=SS', { scroll: false });
    expect(screen.getByTestId('multi-select-3xs')).toHaveAttribute('data-values', 'SS');
    expect(screen.getAllByTestId('look-card')).toHaveLength(1);
  });

  it('DD-LOOK-001 テスト観点#13 ALL に戻すと season だけ消してほかのクエリを残す', () => {
    setSearch('season=SS&x=1');
    render(<PublicLookGrid variant="catalog" looks={mixedLooks} />);

    select('3xs', ['ALL']);

    expect(mockPush).toHaveBeenCalledWith('/look?x=1', { scroll: false });
    expect(screen.getAllByTestId('look-card')).toHaveLength(2);
  });

  it('DD-LOOK-001 テスト観点#14 ALL に戻してクエリが空なら pathname だけにする', () => {
    setSearch('season=SS');
    render(<PublicLookGrid variant="catalog" looks={mixedLooks} />);

    select('3xs', []);

    expect(mockPush).toHaveBeenCalledWith('/look', { scroll: false });
  });

  it('DD-LOOK-001 テスト観点#15 選択も URL も同じなら何もしない', () => {
    setSearch('season=SS');
    render(<PublicLookGrid variant="catalog" looks={mixedLooks} />);

    select('3xs', ['SS']);

    expect(mockPush).not.toHaveBeenCalled();
    expect(screen.getByTestId('multi-select-3xs')).toHaveAttribute('data-values', 'SS');
  });

  it('DD-LOOK-001 テスト観点#16 選択は同じでも URL が違えば2回目も URL に書く', () => {
    render(<PublicLookGrid variant="catalog" looks={mixedLooks} />);

    select('3xs', ['SS']);
    select('3xs', ['SS']);

    expect(mockPush).toHaveBeenCalledTimes(2);
    expect(mockPush).toHaveBeenNthCalledWith(1, '/look?season=SS', { scroll: false });
    expect(mockPush).toHaveBeenNthCalledWith(2, '/look?season=SS', { scroll: false });
  });

  it('DD-LOOK-001 テスト観点#12 選択の値が季節でなければ ALL にする', () => {
    setSearch('season=AW');
    render(<PublicLookGrid variant="catalog" looks={mixedLooks} />);

    select('3xs', ['unknown']);

    expect(mockPush).toHaveBeenCalledWith('/look', { scroll: false });
    expect(screen.getAllByTestId('look-card')).toHaveLength(2);
  });
});

describe('PublicLookGrid catalog 空の表示', () => {
  it('DD-LOOK-001 テスト観点#17 catalog で LOOK が0件なら空の文だけを出す', () => {
    render(<PublicLookGrid variant="catalog" looks={[]} />);

    expect(screen.getByText('公開中のLOOKがありません')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'すべて見る' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('look-card')).not.toBeInTheDocument();
  });

  it('DD-LOOK-001 テスト観点#18 絞った結果が0件なら文と「すべて見る」を出し、押すと ALL に戻す', () => {
    setSearch('season=SS');
    render(
      <PublicLookGrid
        variant="catalog"
        looks={[createLook({ id: 2, seasonType: 'AW', theme: 'Autumn' })]}
      />,
    );

    expect(screen.getByText('該当シーズンのLOOKがありません')).toBeInTheDocument();
    expect(screen.queryByTestId('look-card')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'すべて見る' }));

    expect(mockPush).toHaveBeenCalledWith('/look', { scroll: false });
    expect(screen.getAllByTestId('look-card')).toHaveLength(1);
    expect(screen.queryByText('該当シーズンのLOOKがありません')).not.toBeInTheDocument();
  });
});

describe('PublicLookGrid catalog の絞り込みの見た目', () => {
  const looks = createLooks(1);

  it('DD-LOOK-001 絞り込みの見た目 サイドバーは大きさ 3xs で広げず、引き出しは xs で押せる範囲を広げる', () => {
    render(<PublicLookGrid variant="catalog" looks={looks} />);

    expect(screen.getByTestId('multi-select-3xs')).toHaveAttribute('data-expand', 'false');
    expect(screen.getByTestId('multi-select-xs')).toHaveAttribute('data-expand', 'true');
    expect(screen.getByTestId('multi-select-3xs').closest('aside')).not.toBeNull();
    expect(screen.getByTestId('filter-drawer')).toContainElement(
      screen.getByTestId('multi-select-xs'),
    );
  });

  it('DD-LOOK-001 絞り込みの見た目 選択肢の名前は ALL・SS・AW で、文字は 4xs の大きさで出す', () => {
    render(<PublicLookGrid variant="catalog" looks={looks} />);

    const sidebar = within(screen.getByTestId('multi-select-3xs'));
    for (const label of ['ALL', 'SS', 'AW']) {
      expect(sidebar.getByText(label)).toHaveStyle({ fontSize: 'var(--lk-size-4xs)' });
    }
  });

  it('DD-LOOK-001 テスト観点#19 FILTER を押すと引き出しが開き、閉じるボタンで閉じる', () => {
    const { container } = render(<PublicLookGrid variant="catalog" looks={looks} />);
    const drawer = screen.getByTestId('filter-drawer');
    const floating = container.querySelector('[data-filter-button="floating"]') as HTMLElement;

    expect(drawer).toHaveAttribute('data-open', 'false');
    expect(floating).toHaveAttribute('aria-haspopup', 'dialog');
    expect(floating).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(floating);
    expect(drawer).toHaveAttribute('data-open', 'true');
    expect(floating).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Close filter drawer' }));
    expect(drawer).toHaveAttribute('data-open', 'false');
    expect(floating).toHaveAttribute('aria-expanded', 'false');
  });

  it('DD-LOOK-001 テスト観点#19 Drawer の onClose でも引き出しが閉じる', () => {
    const { container } = render(<PublicLookGrid variant="catalog" looks={looks} />);
    const drawer = screen.getByTestId('filter-drawer');

    fireEvent.click(container.querySelector('[data-filter-button="floating"]') as HTMLElement);
    expect(drawer).toHaveAttribute('data-open', 'true');

    fireEvent.click(screen.getByTestId('drawer-on-close'));
    expect(drawer).toHaveAttribute('data-open', 'false');
  });

  it('DD-LOOK-001 テスト観点#20 置き物の FILTER は隠れ、押せず、引き出しを開けない', () => {
    const { container } = render(<PublicLookGrid variant="catalog" looks={looks} />);
    const bar = container.querySelector('[data-filter-bar="placeholder"]') as HTMLElement;
    const button = container.querySelector('[data-filter-button="placeholder"]') as HTMLElement;

    expect(bar).toHaveAttribute('aria-hidden', 'true');
    expect(bar).toHaveClass('pointer-events-none', 'invisible');
    expect(button).toHaveAttribute('tabindex', '-1');
    expect(button).not.toHaveAttribute('aria-haspopup');
    expect(button).not.toHaveAttribute('aria-expanded');

    fireEvent.click(button);
    expect(screen.getByTestId('filter-drawer')).toHaveAttribute('data-open', 'false');
  });

  it('DD-LOOK-001 テスト観点#20 固定の FILTER は見えて押せる', () => {
    const { container } = render(<PublicLookGrid variant="catalog" looks={looks} />);
    const bar = container.querySelector('[data-filter-bar="floating"]') as HTMLElement;
    const button = container.querySelector('[data-filter-button="floating"]') as HTMLElement;

    expect(bar).not.toHaveAttribute('aria-hidden');
    expect(bar).not.toHaveClass('invisible');
    expect(button).not.toHaveAttribute('tabindex');
  });

  it('DD-LOOK-001 テスト観点#7 catalog の格子に className があればそれを使う', () => {
    render(<PublicLookGrid variant="catalog" looks={looks} className="custom-catalog-grid" />);

    expect(screen.getAllByTestId('look-card')[0].parentElement).toHaveClass('custom-catalog-grid');
  });

  it('DD-LOOK-001 テスト観点#7 catalog の格子に className が無ければ既定の格子 class を使う', () => {
    render(<PublicLookGrid variant="catalog" looks={looks} />);

    expect(screen.getAllByTestId('look-card')[0].parentElement).toHaveClass('grid', 'grid-cols-2');
  });
});

describe('PublicLookGrid カード', () => {
  it('DD-LOOK-001 テスト観点#21 写真が0枚なら /placeholder.png を出し、重ねる写真は出さない', () => {
    render(
      <PublicLookGrid variant="catalog" looks={[createLook({ id: 1, imageUrls: [] })]} />,
    );

    expect(screen.getByTestId('look-card-image')).toHaveAttribute('src', '/placeholder.png');
    expect(screen.queryByTestId('look-card-image-hover')).not.toBeInTheDocument();
  });

  it('DD-LOOK-001 テスト観点#21 先頭の写真が空文字でも /placeholder.png を出す', () => {
    render(
      <PublicLookGrid variant="catalog" looks={[createLook({ id: 1, imageUrls: [''] })]} />,
    );

    expect(screen.getByTestId('look-card-image')).toHaveAttribute('src', '/placeholder.png');
  });

  it('DD-LOOK-001 テスト観点#21 写真が1枚ならその写真だけを出す', () => {
    render(
      <PublicLookGrid
        variant="catalog"
        looks={[createLook({ id: 1, theme: 'Solo', imageUrls: ['/a.png'] })]}
      />,
    );

    const image = screen.getByTestId('look-card-image');
    expect(image).toHaveAttribute('src', '/a.png');
    expect(image).toHaveAttribute('alt', 'Solo');
    expect(screen.queryByTestId('look-card-image-hover')).not.toBeInTheDocument();
  });

  it('DD-LOOK-001 テスト観点#21 写真が2枚なら2枚目を乗った時に重ねる写真として出す', () => {
    render(
      <PublicLookGrid
        variant="catalog"
        looks={[createLook({ id: 1, imageUrls: ['/a.png', '/b.png'] })]}
      />,
    );

    expect(screen.getByTestId('look-card-image')).toHaveAttribute('src', '/a.png');
    const hover = screen.getByTestId('look-card-image-hover');
    expect(hover).toHaveAttribute('src', '/b.png');
    expect(hover).toHaveClass('opacity-0', 'group-hover:opacity-100');
  });

  it('DD-LOOK-001 カードはシーズンを lg 以上は 2026SS・lg 未満は 2026 SS で出す', () => {
    render(
      <PublicLookGrid
        variant="catalog"
        looks={[createLook({ id: 5, seasonYear: 2026, seasonType: 'AW', theme: 'Moon' })]}
      />,
    );

    const overlay = screen.getByTestId('look-card-overlay');
    expect(within(overlay).getByText('2026AW')).toBeInTheDocument();
    expect(within(overlay).getByRole('heading', { level: 3, name: 'Moon' })).toBeInTheDocument();
    const caption = screen.getByTestId('look-card-caption');
    expect(within(caption).getByText('2026 AW')).toBeInTheDocument();
    expect(caption).toHaveAttribute('href', '/look/5');
    expect(caption.closest('[data-testid="look-card"]')?.querySelector('a.group')).toHaveAttribute(
      'href',
      '/look/5',
    );
  });

  it('DD-LOOK-001 テスト観点#22 関連商品があるカードは重ねた関連・罫線・下のリンクを出す', () => {
    render(
      <PublicLookGrid
        variant="catalog"
        looks={[createLook({ id: 1, linkedItems: [LINKED_ITEM] })]}
      />,
    );

    expect(screen.getByTestId('look-card-overlay-title')).toHaveClass(
      'transition-opacity',
      'group-hover:opacity-0',
    );
    const overlayItem = screen.getByTestId('look-card-overlay-item');
    expect(overlayItem).toHaveAttribute('role', 'link');
    expect(overlayItem).toHaveAttribute('tabindex', '0');
    expect(within(overlayItem).getByText('Linen Shirt')).toBeInTheDocument();
    expect(overlayItem.textContent).toMatch(/12,000/);
    expect(screen.getByTestId('look-card-divider')).toBeInTheDocument();
    const lowerLinks = screen
      .getAllByRole('link', { hidden: true })
      .filter((link) => link.getAttribute('href') === '/item/77');
    expect(lowerLinks).toHaveLength(1);
    expect(within(lowerLinks[0]).getByText('Linen Shirt')).toBeInTheDocument();
    expect(screen.getByText('¥12,000')).toBeInTheDocument();
  });

  it('DD-LOOK-001 テスト観点#23 関連商品が無いカードは入れ替えの class・重ねた関連・罫線を出さない', () => {
    render(<PublicLookGrid variant="catalog" looks={[createLook({ id: 1 })]} />);

    expect(screen.getByTestId('look-card-overlay-title').className).not.toContain('group-hover:opacity-0');
    expect(screen.queryByTestId('look-card-overlay-items')).not.toBeInTheDocument();
    expect(screen.queryByTestId('look-card-overlay-item')).not.toBeInTheDocument();
    expect(screen.queryByTestId('look-card-divider')).not.toBeInTheDocument();
  });

  it('DD-LOOK-001 テスト観点#24 重ねた関連の行を押すと既定の動きと伝わりを止めて商品へ移る', () => {
    render(
      <PublicLookGrid
        variant="catalog"
        looks={[createLook({ id: 1, linkedItems: [LINKED_ITEM] })]}
      />,
    );
    const bubbled = jest.fn();
    document.body.addEventListener('click', bubbled);

    const notPrevented = fireEvent.click(screen.getByTestId('look-card-overlay-item'));
    document.body.removeEventListener('click', bubbled);

    expect(notPrevented).toBe(false);
    expect(bubbled).not.toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/item/77');
  });

  it('DD-LOOK-001 テスト観点#25 重ねた関連の行は Enter だけで移り、Space などでは移らない', () => {
    render(
      <PublicLookGrid
        variant="catalog"
        looks={[createLook({ id: 1, linkedItems: [LINKED_ITEM] })]}
      />,
    );
    const row = screen.getByTestId('look-card-overlay-item');
    const bubbled = jest.fn();
    document.body.addEventListener('keydown', bubbled);

    const spacePassed = fireEvent.keyDown(row, { key: ' ' });
    const otherPassed = fireEvent.keyDown(row, { key: 'a' });
    expect(spacePassed).toBe(true);
    expect(otherPassed).toBe(true);
    expect(mockPush).not.toHaveBeenCalled();
    expect(bubbled).toHaveBeenCalledTimes(2);

    bubbled.mockClear();
    const enterPassed = fireEvent.keyDown(row, { key: 'Enter' });
    document.body.removeEventListener('keydown', bubbled);

    expect(enterPassed).toBe(false);
    expect(bubbled).not.toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/item/77');
  });

  it('DD-LOOK-001 テスト観点#26 catalog のカードの class は既定の枠線だけ', () => {
    render(<PublicLookGrid variant="catalog" looks={createLooks(8)} />);

    for (const card of screen.getAllByTestId('look-card')) {
      expect(card.className).toBe('border border-black/10 lg:border-0');
    }
  });

  it('DD-LOOK-001 テスト観点#27 テーマと商品名のタグは HTML にせず文字のまま出す', () => {
    const { container } = render(
      <PublicLookGrid
        variant="catalog"
        looks={[
          createLook({
            id: 1,
            theme: '<b>x</b>',
            linkedItems: [{ ...LINKED_ITEM, name: '<i>y</i>' }],
          }),
        ]}
      />,
    );

    expect(screen.getAllByText('<b>x</b>').length).toBeGreaterThan(0);
    expect(screen.getAllByText('<i>y</i>').length).toBeGreaterThan(0);
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('i:not(.ri-close-line)')).toBeNull();
  });
});
