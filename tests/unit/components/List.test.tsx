import React from 'react';
import { render } from '@testing-library/react';
import { List } from '@/components/ui/List/List';

// stub next/image globally to simple <img> so src attribute is predictable
jest.mock('next/image', () => ({
  __esModule: true,
  default: ({ src, alt, ...props }: any) => React.createElement('img', { src: src as string, alt: alt as string, ...props }),
}));

describe('List component', () => {
  const items = ['a', 'b', 'c'];
  const renderItem = (item: string) => <span>{item}</span>;

  // List は CSS ファイル方式へ移行済み。行間（space-y-2 など）は CSS の責務なので、
  // ここでは size / variant の属性契約と項目の描画だけを検証する。
  const listOf = (container: HTMLElement) => container.querySelector('[data-ui-list]');

  test('項目をすべて描画する', () => {
    const { container } = render(<List items={items} renderItem={renderItem} />);
    expect(container.querySelectorAll('li')).toHaveLength(items.length);
  });

  test('既定は md サイズ', () => {
    const { container } = render(<List items={items} renderItem={renderItem} />);
    expect(listOf(container)).toHaveAttribute('data-ui-list-size', 'md');
  });

  test('size は data-ui-list-size に反映される', () => {
    const { container, rerender } = render(
      <List items={items} renderItem={renderItem} size="sm" />
    );
    expect(listOf(container)).toHaveAttribute('data-ui-list-size', 'sm');

    rerender(<List items={items} renderItem={renderItem} size="lg" />);
    expect(listOf(container)).toHaveAttribute('data-ui-list-size', 'lg');
  });

  describe('showcase variant', () => {
    const showcaseItems = [
      { id: 1, name: 'Foo', category: 'BAR', price: 100, imageUrl: '/foo.png' },
    ];

    beforeEach(() => {
      // mock next/image to simple <img>
      jest.mock('next/image', () => ({
        __esModule: true,
        default: ({ src, alt, ...props }: any) => React.createElement('img', { src: src as string, alt: alt as string, ...props }),
      }));
    });

    afterEach(() => {
      jest.unmock('next/image');
    });

    test('placeholder icon shown when getImage omitted', () => {
      render(
        <List
          items={showcaseItems}
          variant="showcase"
          itemKey={(i) => String(i.id)}
          getName={(i) => i.name}
          getCategory={(i) => i.category}
          getPrice={(i) => `${i.price}`}
          size="sm"
        />
      );
      // icon element exists (ri-image-line)
      expect(document.querySelector('.ri-image-line')).toBeInTheDocument();
    });

    test('getImage が URL を返すと画像を描画する', () => {
      render(
        <List
          items={showcaseItems}
          variant="showcase"
          itemKey={(i) => String(i.id)}
          getName={(i) => i.name}
          getCategory={(i) => i.category}
          getPrice={(i) => `${i.price}`}
          getImage={(i) => i.imageUrl}
          getHref={(i) => `/foo/${i.id}`}
          size="sm"
        />
      );
      const img = document.querySelector('img');
      expect(img).toHaveAttribute('src', expect.stringContaining('/foo.png'));
      // 画像の見た目とホバー背景は List.css の責務なので、
      // ここでは showcase variant として描画されたことだけを確認する。
      expect(document.querySelector('[data-ui-list]')).toHaveAttribute(
        'data-ui-list-variant',
        'showcase',
      );
    });
  });
});