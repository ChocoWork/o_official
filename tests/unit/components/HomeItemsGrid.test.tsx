import React from 'react';
import { render, screen } from '@testing-library/react';
import { PublicItemGrid } from '@/features/items/components/PublicItemGrid';

// 旧 HomeItemsSection はコミット 3c8881f で削除され、ホームの ITEM セクションは
// PublicItemGrid の variant="home" に統合された。
// 件数の出し分けも matchMedia による再レンダリングから CSS クラスによる
// 表示制御へ変わっている（FREQ-147: lg 未満 6 件 / lg 8 件 / xl 10 件）。

jest.mock('next/link', () => {
  const MockLink = ({ href, children, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  );
  MockLink.displayName = 'MockLink';
  return { __esModule: true, default: MockLink };
});

jest.mock('next/image', () => ({
  __esModule: true,
  default: ({ src, alt, ...props }: any) =>
    React.createElement('img', { src: src as string, alt: alt as string, ...props }),
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
  test('渡された商品をすべて描画する', () => {
    render(<PublicItemGrid variant="home" items={makeItems(10) as any} totalCount={20} />);

    expect(screen.getAllByTestId('item-card-link')).toHaveLength(10);
  });

  test('7〜8 件目は lg 以上、9 件目以降は xl 以上でのみ表示される', () => {
    render(<PublicItemGrid variant="home" items={makeItems(10) as any} totalCount={20} />);

    const links = screen.getAllByTestId('item-card-link');

    // 1〜6 件目は全ブレークポイントで表示（表示制御クラスを持たない）
    for (const link of links.slice(0, 6)) {
      expect(link.className).not.toMatch(/hidden/);
    }

    // 7〜8 件目は lg 以上
    for (const link of links.slice(6, 8)) {
      expect(link).toHaveClass('hidden', 'lg:block');
    }

    // 9〜10 件目は xl 以上
    for (const link of links.slice(8, 10)) {
      expect(link).toHaveClass('hidden', 'xl:block');
    }
  });

  test('総数が表示数を上回る帯域でのみ VIEW ALL を出す', () => {
    // 総数 7 件：6 件表示の帯域だけ VIEW ALL を出し、8 件・10 件表示の帯域では隠す
    render(<PublicItemGrid variant="home" items={makeItems(7) as any} totalCount={7} />);

    const viewAll = screen.getByTestId('home-section-view-all').parentElement;
    expect(viewAll).toHaveClass('flex', 'lg:hidden', 'xl:hidden');
  });

  test('総数が全帯域の表示数を上回れば VIEW ALL を常に出す', () => {
    render(<PublicItemGrid variant="home" items={makeItems(10) as any} totalCount={30} />);

    const viewAll = screen.getByTestId('home-section-view-all').parentElement;
    expect(viewAll).toHaveClass('flex', 'lg:flex', 'xl:flex');
  });
});
