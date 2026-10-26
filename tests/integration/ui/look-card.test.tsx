import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { PublicLookGrid } from '@/features/look/components/PublicLookGrid';
import type { PublicLookListItem } from '@/lib/look/public';

const pushMock = jest.fn();

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

jest.mock('next/navigation', () => ({
  usePathname: () => '/look',
  useRouter: () => ({ push: (...args: unknown[]) => pushMock(...args) }),
  useSearchParams: () => new URLSearchParams(''),
}));

const COAT = { category: 'COAT', id: 10, name: 'Wool coat', price: 48000, imageUrl: 'https://signed.test/coat.jpg' };
const BAG = { category: 'BAG', id: 11, name: 'Leather bag', price: 12000, imageUrl: 'https://signed.test/bag.jpg' };

function makeLook(overrides: Partial<PublicLookListItem> = {}): PublicLookListItem {
  return {
    id: 7,
    seasonYear: 2026,
    seasonType: 'AW',
    theme: 'Quiet hours',
    imageUrls: ['https://signed.test/first.jpg', 'https://signed.test/second.jpg'],
    createdAt: '2026-09-01T00:00:00Z',
    linkedItems: [COAT, BAG],
    ...overrides,
  };
}

function renderCard(look: PublicLookListItem = makeLook()) {
  render(<PublicLookGrid variant="catalog" looks={[look]} />);
  return screen.getByTestId('look-card');
}

describe('SCR-LOOK-002 look card', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('SCR-LOOK-002 1枚目の写真をテーマを代替の文にして出し、2枚目があれば乗った時に重ねて替える写真として足す', () => {
    const card = renderCard();

    const photos = within(card).getAllByRole('img');
    expect(photos).toHaveLength(2);
    expect(photos[0]).toHaveAttribute('src', 'https://signed.test/first.jpg');
    expect(photos[0]).toHaveAttribute('alt', 'Quiet hours');
    const hover = within(card).getByTestId('look-card-image-hover');
    expect(hover).toHaveAttribute('src', 'https://signed.test/second.jpg');
    expect(hover).toHaveClass('opacity-0', 'group-hover:opacity-100');
    expect(photos[0].className).not.toMatch(/scale|zoom/);
    expect(hover.className).not.toMatch(/scale|zoom/);
  });

  it('SCR-LOOK-002 写真が1枚の時は2枚目を足さず、無い時は /placeholder.png を出す', () => {
    const { unmount } = render(<PublicLookGrid variant="catalog" looks={[makeLook({ imageUrls: ['https://signed.test/only.jpg'] })]} />);
    expect(screen.queryByTestId('look-card-image-hover')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('look-card')).getAllByRole('img')).toHaveLength(1);
    unmount();

    renderCard(makeLook({ imageUrls: [] }));
    expect(within(screen.getByTestId('look-card')).getByRole('img')).toHaveAttribute('src', '/placeholder.png');
  });

  it('SCR-LOOK-002 lg 以上は写真の下部のグラデーションにシーズンを「2026AW」の形で、テーマを大文字のセリフ体で重ねる', () => {
    const card = renderCard();

    const overlay = within(card).getByTestId('look-card-overlay');
    expect(overlay).toHaveClass('hidden', 'lg:block', 'absolute', 'text-white');
    expect(overlay.className).toContain('linear-gradient(to_top');
    const title = within(card).getByTestId('look-card-overlay-title');
    expect(within(title).getByText('2026AW')).toBeInTheDocument();
    const theme = within(title).getByRole('heading', { level: 3 });
    expect(theme).toHaveTextContent('Quiet hours');
    expect(theme).toHaveClass('font-display', 'uppercase');
  });

  it('SCR-LOOK-002 lg 未満は写真の下の情報パネルにシーズンを「2026 AW」の形で、テーマと関連商品を出し、カード全体を枠線で囲む', () => {
    const card = renderCard();

    expect(card).toHaveClass('border', 'border-black/10', 'lg:border-0');
    const caption = within(card).getByTestId('look-card-caption');
    expect(caption).toHaveClass('lg:hidden');
    expect(within(caption).getByText('2026 AW')).toHaveClass('text-black/80', 'font-medium');
    expect(within(caption).getByRole('heading', { level: 3 })).toHaveTextContent('Quiet hours');
    expect(within(card).getByTestId('look-card-divider')).toHaveClass('lg:hidden');
  });

  it('SCR-LOOK-002 写真と重ねた文字は詳細への1つのリンクで包み、情報パネルのシーズンとテーマは同じ行き先の2つ目のリンクにする', () => {
    const card = renderCard();

    const links = within(card)
      .getAllByRole('link')
      .filter((link) => link.getAttribute('href')?.startsWith('/look/'));
    expect(links).toHaveLength(2);
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/look/7', '/look/7']);
    expect(within(links[0]).getByTestId('look-card-overlay')).toBeInTheDocument();
    expect(links[1]).toBe(within(card).getByTestId('look-card-caption'));
  });

  it('SCR-LOOK-002 重ねた関連商品は名前と価格を並べたリンクの役を持つ行で、乗った時だけ見えるように入れ替える', () => {
    const card = renderCard();

    const title = within(card).getByTestId('look-card-overlay-title');
    expect(title).toHaveClass('group-hover:opacity-0');
    const itemsBlock = within(card).getByTestId('look-card-overlay-items');
    expect(itemsBlock).toHaveClass('opacity-0', 'pointer-events-none', 'group-hover:opacity-100');

    const rows = within(card).getAllByTestId('look-card-overlay-item');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute('role', 'link');
    expect(rows[0]).toHaveAttribute('tabindex', '0');
    expect(rows[0].tagName).toBe('DIV');
    expect(rows[0]).toHaveTextContent('Wool coat');
    expect(rows[0]).toHaveTextContent(/48,000/);
    expect(rows[1]).toHaveTextContent('Leather bag');
    expect(rows[1]).toHaveTextContent(/12,000/);
    const underline = rows[0].querySelector('[aria-hidden="true"]');
    expect(underline).toHaveClass('underline-animation-left2right', 'bg-white', 'scale-x-0', 'group-hover/item:scale-x-100');
  });

  it('SCR-LOOK-002 重ねた関連商品の行は押すと既定の動きを止めて商品へ移り、カードの詳細へは移らない', () => {
    const card = renderCard();
    const rows = within(card).getAllByTestId('look-card-overlay-item');

    const notPrevented = fireEvent.click(rows[1]);

    expect(notPrevented).toBe(false);
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith('/item/11');
  });

  it('SCR-LOOK-002 重ねた関連商品の行は Enter で商品へ移り、Space や他のキーでは移らない', () => {
    const card = renderCard();
    const [row] = within(card).getAllByTestId('look-card-overlay-item');

    expect(fireEvent.keyDown(row, { key: 'Enter' })).toBe(false);
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenLastCalledWith('/item/10');

    expect(fireEvent.keyDown(row, { key: ' ' })).toBe(true);
    expect(fireEvent.keyDown(row, { key: 'Tab' })).toBe(true);
    expect(pushMock).toHaveBeenCalledTimes(1);
  });

  it('SCR-LOOK-002 情報パネルの関連商品はカードのリンクの外の普通のリンクで、名前と¥の価格を出す', () => {
    const card = renderCard();

    const caption = within(card).getByTestId('look-card-caption');
    const panelLinks = within(card)
      .getAllByRole('link')
      .filter((link) => link.getAttribute('href')?.startsWith('/item/'));
    expect(panelLinks.map((link) => link.getAttribute('href'))).toEqual(['/item/10', '/item/11']);
    for (const link of panelLinks) {
      expect(link.parentElement?.closest('a')).toBeNull();
      expect(caption.contains(link)).toBe(false);
      expect(link).toHaveClass('text-black');
    }
    expect(panelLinks[0]).toHaveTextContent('Wool coat');
    expect(panelLinks[0]).toHaveTextContent('¥48,000');
    expect(panelLinks[0].querySelector('[aria-hidden="true"]')).toHaveClass('underline-animation-left2right');
    expect(panelLinks[0].querySelector('[aria-hidden="true"]')).not.toHaveClass('bg-white');
  });

  it('SCR-LOOK-002 関連商品が無いカードは罫線と並びを出さず、乗った時の入れ替えもしない', () => {
    const card = renderCard(makeLook({ linkedItems: [] }));

    expect(within(card).queryByTestId('look-card-divider')).not.toBeInTheDocument();
    expect(within(card).queryByTestId('look-card-overlay-items')).not.toBeInTheDocument();
    expect(within(card).queryAllByTestId('look-card-overlay-item')).toHaveLength(0);
    expect(within(card).getByTestId('look-card-overlay-title')).not.toHaveClass('group-hover:opacity-0');
    expect(card.querySelector('.look-related-items')).not.toBeInTheDocument();
    expect(
      within(card)
        .getAllByRole('link')
        .every((link) => link.getAttribute('href') === '/look/7'),
    ).toBe(true);
  });

  it('SCR-LOOK-002 一覧とホームの区画は同じカードを使い、ホームでも同じ造りで出す', () => {
    render(<PublicLookGrid variant="home" looks={[makeLook()]} totalCount={1} />);

    const card = screen.getByTestId('look-card');
    expect(card).toHaveClass('border', 'border-black/10', 'lg:border-0');
    expect(within(card).getByTestId('look-card-overlay')).toBeInTheDocument();
    expect(within(card).getByTestId('look-card-caption')).toHaveAttribute('href', '/look/7');
    expect(within(card).getAllByTestId('look-card-overlay-item')).toHaveLength(2);
  });

  describe('画面に入った時の出方', () => {
    const originalObserver = globalThis.IntersectionObserver;

    afterEach(() => {
      Object.defineProperty(globalThis, 'IntersectionObserver', { value: originalObserver, writable: true });
    });

    it('SCR-LOOK-002 画面に入るまでは data-reveal を立てず、入った写真のカバーと文字の覆いに別々に立てる', () => {
      const observed: Array<{ target: Element; fire: () => void }> = [];
      class ObserverStub {
        private readonly callback: IntersectionObserverCallback;
        constructor(callback: IntersectionObserverCallback) {
          this.callback = callback;
        }
        observe(target: Element) {
          observed.push({
            target,
            fire: () =>
              this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver),
          });
        }
        unobserve() {}
        disconnect() {}
        takeRecords() {
          return [];
        }
      }
      Object.defineProperty(globalThis, 'IntersectionObserver', { value: ObserverStub, writable: true });

      const card = renderCard();
      const cover = card.querySelector<HTMLElement>('.reveal-cover');
      const mask = card.querySelector<HTMLElement>('.reveal-mask');
      expect(cover).toBeInTheDocument();
      expect(mask).toBeInTheDocument();

      // 写真は読み込みが終わってから監視を始める
      for (const image of Array.from(card.querySelectorAll('img'))) {
        fireEvent.load(image);
      }
      expect(observed.map(({ target }) => target)).toEqual(expect.arrayContaining([cover, mask]));
      expect(cover).not.toHaveAttribute('data-reveal');
      expect(mask).not.toHaveAttribute('data-reveal');

      observed.find(({ target }) => target === mask)?.fire();

      expect(mask).toHaveAttribute('data-reveal', 'true');
      expect(cover).not.toHaveAttribute('data-reveal');

      observed.find(({ target }) => target === cover)?.fire();

      expect(cover).toHaveAttribute('data-reveal', 'true');
      expect(mask?.querySelector('.reveal-rise')).toHaveClass('reveal-rise-x');
    });
  });
});
