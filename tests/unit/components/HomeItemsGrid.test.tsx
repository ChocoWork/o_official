import React from 'react';
import { render, screen } from '@testing-library/react';
import { PublicItemGrid } from '@/features/items/components/PublicItemGrid';

// 旧 HomeItemsSection はコミット 3c8881f で削除され、ホームの ITEM セクションは
// PublicItemGrid の variant="home" に統合された。
// 件数の出し分けも matchMedia による再レンダリングから CSS クラスによる
// 表示制御へ変わっている。表示件数は FREQ-147 から FREQ-276 で変更され、
// 現行は「2xl 未満 6 件 / 2xl 以上 8 件、9 件目以降は描画しない」。

jest.mock('next/link', () => {
  const MockLink = ({ href, children, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  );
  MockLink.displayName = 'MockLink';
  return { __esModule: true, default: MockLink };
});

// next/image 固有の props（priority / fill / quality など）は DOM 属性ではないので、
// 生の <img> にそのまま撒くと React が non-boolean attribute エラーを投げる。
// DOM に出して良いものだけを明示的に通す。
jest.mock('next/image', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    const forwarded: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      const isDomSafe =
        ['src', 'alt', 'width', 'height', 'className', 'style', 'id', 'title'].includes(key) ||
        key.startsWith('data-') ||
        key.startsWith('aria-');
      if (isDomSafe) forwarded[key] = value;
    }
    return React.createElement('img', forwarded);
  },
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/',
}));

const makeItems = (count: number) =>
  Array.from({ length: count }).map((_, index) => ({
    id: index + 1,
    name: `Item ${index + 1}`,
    description: 'desc',
    price: 1000,
    image_url: '/img.png',
    category: 'TOPS',
    colors: [],
    stock_quantity: 5,
  }));

describe('ホームの ITEM セクション（PublicItemGrid variant="home"）', () => {
  test('9 件目以降は描画しない（最大 8 件）', () => {
    render(<PublicItemGrid variant="home" items={makeItems(10) as any} totalCount={20} />);

    expect(screen.getAllByTestId('item-card-link')).toHaveLength(8);
  });

  test('7〜8 件目は 2xl 以上でのみ表示される', () => {
    render(<PublicItemGrid variant="home" items={makeItems(10) as any} totalCount={20} />);

    const links = screen.getAllByTestId('item-card-link');

    // 1〜6 件目は全ブレークポイントで表示（表示制御クラスを持たない）
    for (const link of links.slice(0, 6)) {
      expect(link.className).not.toMatch(/hidden/);
    }

    // 7〜8 件目は 2xl 以上
    for (const link of links.slice(6, 8)) {
      expect(link).toHaveClass('hidden', '2xl:block');
    }
  });

  test('総数が表示数を上回る帯域でのみ VIEW ALL を出す', () => {
    // 総数 7 件：6 件表示の帯域だけ VIEW ALL を出し、8 件表示の 2xl では隠す
    render(<PublicItemGrid variant="home" items={makeItems(7) as any} totalCount={7} />);

    const viewAll = screen.getByTestId('home-section-view-all').parentElement;
    expect(viewAll).toHaveClass('flex', '2xl:hidden');
  });

  test('総数が全帯域の表示数を上回れば VIEW ALL を常に出す', () => {
    render(<PublicItemGrid variant="home" items={makeItems(10) as any} totalCount={30} />);

    const viewAll = screen.getByTestId('home-section-view-all').parentElement;
    expect(viewAll).toHaveClass('flex', '2xl:flex');
  });
});
