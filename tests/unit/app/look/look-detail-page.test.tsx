import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';

jest.mock('@/lib/look/server', () => ({
  getPublishedLooks: jest.fn(),
  getPublishedLookById: jest.fn(),
}));

type MockLinkedItem = {
  id: number;
  name: string;
  category: string;
  price: number;
  imageUrl: string;
};

type ListMockProps = {
  items: MockLinkedItem[];
  itemKey: (item: MockLinkedItem) => string;
  getName: (item: MockLinkedItem) => string;
  getCategory: (item: MockLinkedItem) => string;
  getPrice: (item: MockLinkedItem) => string;
  getImage: (item: MockLinkedItem) => string;
  getHref: (item: MockLinkedItem) => string;
  variant: string;
  size: string;
};

jest.mock('@/components/ui/List/List', () => ({
  List: (props: ListMockProps) => (
    <ul data-testid="list" data-variant={props.variant} data-size={props.size}>
      {props.items.map((item) => (
        <li key={props.itemKey(item)} data-testid="list-item" data-href={props.getHref(item)}>
          <span data-testid="list-name">{props.getName(item)}</span>
          <span data-testid="list-category">{props.getCategory(item)}</span>
          <span data-testid="list-price">{props.getPrice(item)}</span>
          <span data-testid="list-image">{props.getImage(item)}</span>
        </li>
      ))}
    </ul>
  ),
}));

type BottomNavMockProps = {
  items: Array<{
    key: string;
    label: string;
    href?: string;
    disabled?: boolean;
    icon: ReactNode;
  }>;
  fixed?: boolean;
  appearance?: string;
  size?: string;
};

jest.mock('@/components/ui/BottomNavigation/BottomNavigation', () => ({
  BottomNavigation: (props: BottomNavMockProps) => (
    <div
      data-testid="bottom-nav"
      data-fixed={String(props.fixed)}
      data-appearance={props.appearance}
      data-size={props.size}
    >
      {props.items.map((item) => (
        <div
          key={item.key}
          data-testid={`bottom-nav-${item.key}`}
          data-label={item.label}
          data-href={item.href ?? ''}
          data-has-href={String(item.href !== undefined)}
          data-disabled={String(Boolean(item.disabled))}
        >
          {item.icon}
        </div>
      ))}
    </div>
  ),
}));

jest.mock('@/features/look/components/LookImageGallery', () => ({
  LookImageGallery: (props: { theme: string; imageUrls: string[] }) => (
    <div
      data-testid="gallery"
      data-theme={props.theme}
      data-urls={JSON.stringify(props.imageUrls)}
    />
  ),
}));

import LookDetailPage, { generateMetadata } from '@/app/look/[id]/page';
import { getPublishedLookById, getPublishedLooks } from '@/lib/look/server';

const mockGetPublishedLooks = getPublishedLooks as jest.Mock;
const mockGetPublishedLookById = getPublishedLookById as jest.Mock;

function makeLook(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    seasonYear: 2026,
    seasonType: 'AW',
    theme: `Theme ${id}`,
    themeDescription: `Description ${id}`,
    imageUrls: [`https://example.test/look-${id}-1.jpg`],
    createdAt: '2026-10-01T00:00:00Z',
    linkedItems: [],
    ...overrides,
  };
}

const THREE_LOOKS = [makeLook(30), makeLook(20), makeLook(10)];

function paramsOf(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function renderPage(id: string) {
  const element = await LookDetailPage(paramsOf(id));
  return render(element);
}

describe('LookDetailPage generateMetadata', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetPublishedLookById.mockResolvedValue(null);
  });

  it('DD-LOOK-030 数でない id は取り出さずに Look not found のメタを返す', async () => {
    const metadata = await generateMetadata(paramsOf('abc'));

    expect(mockGetPublishedLookById).not.toHaveBeenCalled();
    expect(metadata).toEqual({
      title: 'Look not found | Le Fil des Heures',
      description: '指定されたルックは見つかりませんでした。',
    });
  });

  it('DD-LOOK-030 1件の取り出しが null なら Look not found のメタを返す', async () => {
    const metadata = await generateMetadata(paramsOf('5'));

    expect(mockGetPublishedLookById).toHaveBeenCalledWith(5);
    expect(metadata).toEqual({
      title: 'Look not found | Le Fil des Heures',
      description: '指定されたルックは見つかりませんでした。',
    });
  });

  it('DD-LOOK-030 見つかれば title・説明文・OG の1枚目の画像を返す', async () => {
    mockGetPublishedLookById.mockResolvedValue(
      makeLook(7, {
        theme: 'Dawn',
        themeDescription: '朝の着こなし',
        imageUrls: ['https://example.test/a.jpg', 'https://example.test/b.jpg'],
      }),
    );

    const metadata = await generateMetadata(paramsOf('7'));

    expect(mockGetPublishedLookById).toHaveBeenCalledWith(7);
    expect(metadata.title).toBe('Dawn | LOOK | Le Fil des Heures');
    expect(metadata.description).toBe('朝の着こなし');
    expect(metadata.openGraph).toEqual({
      title: 'Dawn | LOOK | Le Fil des Heures',
      description: '朝の着こなし',
      images: [{ url: 'https://example.test/a.jpg' }],
    });
  });

  it('DD-LOOK-030 説明文が空ならテーマから description を作り、画像0枚なら OG の画像を空にする', async () => {
    mockGetPublishedLookById.mockResolvedValue(
      makeLook(8, { theme: 'Dusk', themeDescription: '', imageUrls: [] }),
    );

    const metadata = await generateMetadata(paramsOf('8'));

    expect(metadata.description).toBe('Dusk のスタイリング詳細ページ');
    expect(metadata.openGraph).toEqual({
      title: 'Dusk | LOOK | Le Fil des Heures',
      description: 'Dusk のスタイリング詳細ページ',
      images: [],
    });
  });
});

describe('LookDetailPage 本体', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetPublishedLooks.mockResolvedValue(THREE_LOOKS);
  });

  describe('見つからない', () => {
    it('DD-LOOK-030 全件の中に同じ id が無ければ見出し Look not found だけを返す', async () => {
      await renderPage('999');

      expect(screen.getByRole('heading', { level: 1, name: 'Look not found' })).toBeInTheDocument();
      expect(screen.queryByTestId('gallery')).not.toBeInTheDocument();
      expect(screen.queryByTestId('look-detail-bottom-nav')).not.toBeInTheDocument();
      expect(screen.queryByTestId('bottom-nav')).not.toBeInTheDocument();
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
    });

    it('DD-LOOK-030 数でない id は見つからず Look not found を返す', async () => {
      await renderPage('abc');

      expect(screen.getByRole('heading', { name: 'Look not found' })).toBeInTheDocument();
      expect(screen.queryByTestId('gallery')).not.toBeInTheDocument();
    });

    it('DD-LOOK-030 取り出しが空の配列でも Look not found を返す', async () => {
      mockGetPublishedLooks.mockResolvedValue([]);

      await renderPage('30');

      expect(screen.getByRole('heading', { name: 'Look not found' })).toBeInTheDocument();
    });

    it('DD-LOOK-030 全件の取り出しは getPublishedLooks を引数なしで1回呼ぶ', async () => {
      await renderPage('20');

      expect(mockGetPublishedLooks).toHaveBeenCalledTimes(1);
      expect(mockGetPublishedLooks).toHaveBeenCalledWith();
      expect(mockGetPublishedLookById).not.toHaveBeenCalled();
    });
  });

  describe('前後のナビ', () => {
    it('DD-LOOK-030 真ん中の LOOK は前後の両方が /look/<id> のリンクで、固定のナビは disabled でない', async () => {
      await renderPage('20');

      const nav = screen.getByRole('navigation', { name: 'Look navigation' });
      const prev = within(nav).getByRole('link', { name: 'Previous look: Theme 30' });
      const next = within(nav).getByRole('link', { name: 'Next look: Theme 10' });
      expect(prev).toHaveAttribute('href', '/look/30');
      expect(next).toHaveAttribute('href', '/look/10');

      expect(screen.getByTestId('bottom-nav-prev')).toHaveAttribute('data-href', '/look/30');
      expect(screen.getByTestId('bottom-nav-prev')).toHaveAttribute('data-disabled', 'false');
      expect(screen.getByTestId('bottom-nav-next')).toHaveAttribute('data-href', '/look/10');
      expect(screen.getByTestId('bottom-nav-next')).toHaveAttribute('data-disabled', 'false');
    });

    it('DD-LOOK-030 先頭の LOOK は前が薄い非リンクで、固定のナビの前は disabled で href なし', async () => {
      await renderPage('30');

      const nav = screen.getByTestId('look-detail-bottom-nav');
      expect(within(nav).queryByRole('link', { name: /Previous look/ })).not.toBeInTheDocument();
      const placeholder = within(nav).getByText('PREV LOOK').closest('div');
      expect(placeholder).toHaveAttribute('aria-hidden', 'true');
      expect(placeholder).toHaveClass('opacity-30');
      expect(within(nav).getByRole('link', { name: 'Next look: Theme 20' })).toHaveAttribute(
        'href',
        '/look/20',
      );

      const prev = screen.getByTestId('bottom-nav-prev');
      expect(prev).toHaveAttribute('data-disabled', 'true');
      expect(prev).toHaveAttribute('data-has-href', 'false');
      expect(screen.getByTestId('bottom-nav-next')).toHaveAttribute('data-disabled', 'false');
      expect(screen.getByTestId('bottom-nav-next')).toHaveAttribute('data-href', '/look/20');
    });

    it('DD-LOOK-030 末尾の LOOK は後が薄い非リンクで、固定のナビの後は disabled で href なし', async () => {
      await renderPage('10');

      const nav = screen.getByTestId('look-detail-bottom-nav');
      expect(within(nav).queryByRole('link', { name: /Next look/ })).not.toBeInTheDocument();
      const placeholder = within(nav).getByText('NEXT LOOK').closest('div');
      expect(placeholder).toHaveAttribute('aria-hidden', 'true');
      expect(placeholder).toHaveClass('opacity-30');
      expect(within(nav).getByRole('link', { name: 'Previous look: Theme 20' })).toHaveAttribute(
        'href',
        '/look/20',
      );

      const next = screen.getByTestId('bottom-nav-next');
      expect(next).toHaveAttribute('data-disabled', 'true');
      expect(next).toHaveAttribute('data-has-href', 'false');
      expect(screen.getByTestId('bottom-nav-prev')).toHaveAttribute('data-href', '/look/20');
    });

    it('DD-LOOK-030 1件だけの LOOK は前後とも薄い非リンクで、固定のナビも両方 disabled', async () => {
      mockGetPublishedLooks.mockResolvedValue([makeLook(1)]);

      await renderPage('1');

      const nav = screen.getByTestId('look-detail-bottom-nav');
      expect(
        within(nav).queryByRole('link', { name: /Previous look|Next look/ }),
      ).not.toBeInTheDocument();
      expect(within(nav).getByRole('link', { name: 'Look list' })).toBeInTheDocument();
      expect(screen.getByTestId('bottom-nav-prev')).toHaveAttribute('data-disabled', 'true');
      expect(screen.getByTestId('bottom-nav-next')).toHaveAttribute('data-disabled', 'true');
    });

    it('DD-LOOK-030 どの LOOK でも LOOK LIST は /look へのリンクで、固定のナビも /look', async () => {
      await renderPage('20');

      const nav = screen.getByTestId('look-detail-bottom-nav');
      expect(within(nav).getByRole('link', { name: 'Look list' })).toHaveAttribute('href', '/look');
      const list = screen.getByTestId('bottom-nav-list');
      expect(list).toHaveAttribute('data-href', '/look');
      expect(list).toHaveAttribute('data-disabled', 'false');
    });

    it('DD-LOOK-030 固定のナビは固定・filled・md で3項目を前・一覧・後の順に並べる', async () => {
      await renderPage('20');

      const bottomNav = screen.getByTestId('bottom-nav');
      expect(bottomNav).toHaveAttribute('data-fixed', 'true');
      expect(bottomNav).toHaveAttribute('data-appearance', 'filled');
      expect(bottomNav).toHaveAttribute('data-size', 'md');
      expect(
        Array.from(bottomNav.children).map((child) => child.getAttribute('data-label')),
      ).toEqual(['PREV LOOK', 'LOOK LIST', 'NEXT LOOK']);
      expect(screen.getByTestId('look-detail-fixed-nav')).toHaveClass('md:hidden');
    });
  });

  describe('情報', () => {
    it('DD-LOOK-030 シーズンを「2026 AW」の形にし、テーマを h1 で出す', async () => {
      await renderPage('20');

      expect(screen.getByText('2026 AW')).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 1, name: 'Theme 20' })).toBeInTheDocument();
    });

    it('DD-LOOK-030 SS のシーズンも年と種別を空白で結んで出す', async () => {
      mockGetPublishedLooks.mockResolvedValue([
        makeLook(3, { seasonYear: 2027, seasonType: 'SS' }),
      ]);

      await renderPage('3');

      expect(screen.getByText('2027 SS')).toBeInTheDocument();
    });

    it('DD-LOOK-030 説明文を段落で出す', async () => {
      await renderPage('20');

      const paragraph = screen.getByText('Description 20');
      expect(paragraph.tagName).toBe('P');
    });

    it('DD-LOOK-030 説明文が空なら空白1文字の段落を出す', async () => {
      mockGetPublishedLooks.mockResolvedValue([makeLook(4, { themeDescription: '' })]);

      const { container } = await renderPage('4');

      const paragraphs = Array.from(container.querySelectorAll('p')).filter(
        (p) => p.textContent === ' ',
      );
      expect(paragraphs).toHaveLength(1);
      expect(paragraphs[0]).toHaveClass('leading-loose');
    });

    it('DD-LOOK-030 ギャラリーにテーマと画像の URL の並びを渡す', async () => {
      const urls = ['https://example.test/x.jpg', 'https://example.test/y.jpg'];
      mockGetPublishedLooks.mockResolvedValue([
        makeLook(5, { theme: 'Gallery', imageUrls: urls }),
      ]);

      await renderPage('5');

      const gallery = screen.getByTestId('gallery');
      expect(gallery).toHaveAttribute('data-theme', 'Gallery');
      expect(gallery).toHaveAttribute('data-urls', JSON.stringify(urls));
    });

    it('DD-LOOK-030 テーマと説明文の HTML をタグのまま文字で出す', async () => {
      mockGetPublishedLooks.mockResolvedValue([
        makeLook(6, { theme: '<b>x</b>', themeDescription: '<i>y</i>' }),
      ]);

      const { container } = await renderPage('6');

      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('<b>x</b>');
      expect(screen.getByText('<i>y</i>')).toBeInTheDocument();
      expect(container.querySelector('b')).toBeNull();
      expect(container.querySelector('i')).toBeNull();
    });
  });

  describe('関連商品', () => {
    it('DD-LOOK-030 関連商品が0件なら「紐づけ商品はありません」を出し、List を描かない', async () => {
      await renderPage('20');

      expect(screen.getByText('紐づけ商品はありません')).toBeInTheDocument();
      expect(screen.queryByTestId('list')).not.toBeInTheDocument();
    });

    it('DD-LOOK-030 関連商品があれば List に名前・分類・円の価格・画像・/item/<id> を渡す', async () => {
      mockGetPublishedLooks.mockResolvedValue([
        makeLook(9, {
          linkedItems: [
            {
              id: 77,
              name: 'Coat',
              category: 'OUTER',
              price: 12000,
              imageUrl: 'https://example.test/coat.jpg',
            },
          ],
        }),
      ]);

      await renderPage('9');

      expect(screen.queryByText('紐づけ商品はありません')).not.toBeInTheDocument();
      const list = screen.getByTestId('list');
      expect(list).toHaveAttribute('data-variant', 'showcase');
      expect(list).toHaveAttribute('data-size', 'xs');
      expect(screen.getByTestId('list-item')).toHaveAttribute('data-href', '/item/77');
      expect(screen.getByTestId('list-name')).toHaveTextContent('Coat');
      expect(screen.getByTestId('list-category')).toHaveTextContent('OUTER');
      expect(screen.getByTestId('list-price')).toHaveTextContent('￥12,000');
      expect(screen.getByTestId('list-image')).toHaveTextContent('https://example.test/coat.jpg');
    });

    it('DD-LOOK-030 関連商品は渡された並びのまま複数出し、価格に小数を付けない', async () => {
      mockGetPublishedLooks.mockResolvedValue([
        makeLook(9, {
          linkedItems: [
            { id: 2, name: 'B', category: 'TOPS', price: 980, imageUrl: 'b.jpg' },
            { id: 1, name: 'A', category: 'BOTTOMS', price: 1234567, imageUrl: 'a.jpg' },
          ],
        }),
      ]);

      await renderPage('9');

      expect(screen.getAllByTestId('list-name').map((n) => n.textContent)).toEqual(['B', 'A']);
      expect(screen.getAllByTestId('list-price').map((n) => n.textContent)).toEqual([
        '￥980',
        '￥1,234,567',
      ]);
    });
  });

  describe('アイコン', () => {
    it('DD-LOOK-030 3列のナビのアイコンは既定の大きさと渡した class、固定のナビは渡した大きさと class なし', async () => {
      await renderPage('20');

      const gridIcons = within(screen.getByTestId('look-detail-bottom-nav')).getAllByTestId(
        'look-detail-nav-icon',
      );
      expect(gridIcons).toHaveLength(3);
      for (const icon of gridIcons) {
        expect(icon.getAttribute('style')).toContain('var(--lk-size-7xl)');
        expect(icon).toHaveClass('block', 'text-black');
        expect(icon).toHaveAttribute('aria-hidden', 'true');
        expect(icon).toHaveAttribute('stroke-width', '1');
      }

      const fixedIcons = within(screen.getByTestId('bottom-nav')).getAllByTestId(
        'look-detail-nav-icon',
      );
      expect(fixedIcons).toHaveLength(3);
      for (const icon of fixedIcons) {
        expect(icon.getAttribute('style')).toContain('var(--bottom-nav-icon-size)');
        expect(icon.getAttribute('class')).toBe('block ');
      }
    });

    it('DD-LOOK-030 先頭の薄い非リンクのアイコンも既定の大きさと text-black class で出す', async () => {
      await renderPage('30');

      const nav = screen.getByTestId('look-detail-bottom-nav');
      const placeholderIcon = within(
        within(nav).getByText('PREV LOOK').closest('div') as HTMLElement,
      ).getByTestId('look-detail-nav-icon');
      expect(placeholderIcon.getAttribute('style')).toContain('var(--lk-size-7xl)');
      expect(placeholderIcon).toHaveClass('text-black');
    });
  });
});
