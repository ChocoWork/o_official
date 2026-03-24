import React from 'react';
import { render, screen } from '@testing-library/react';
import { List } from '@/components/ui/List';

// stub next/image globally to simple <img> so src attribute is predictable
jest.mock('next/image', () => ({
  __esModule: true,
  default: ({ src, alt, ...props }: any) => <img src={src as string} alt={alt as string} {...props} />,
}));

describe('List component', () => {
  const items = ['a', 'b', 'c'];
  const renderItem = (item: string) => <span>{item}</span>;

  test('renders with default size (md) gap', () => {
    const { container } = render(<List items={items} renderItem={renderItem} />);
    const ul = container.querySelector('ul');
    expect(ul).toHaveClass('space-y-2');
  });

  test('size prop adjusts spacing', () => {
    const { rerender, container } = render(
      <List items={items} renderItem={renderItem} size="sm" />
    );
    let ul = container.querySelector('ul');
    expect(ul).toHaveClass('space-y-1');

    rerender(<List items={items} renderItem={renderItem} size="lg" />);
    ul = container.querySelector('ul');
    expect(ul).toHaveClass('space-y-4');
  });

  describe('showcase variant', () => {
    const showcaseItems = [
      { id: 1, name: 'Foo', category: 'BAR', price: 100, imageUrl: '/foo.png' },
    ];

    beforeEach(() => {
      // mock next/image to simple <img>
      jest.mock('next/image', () => ({
        __esModule: true,
        default: ({ src, alt, ...props }: any) => <img src={src as string} alt={alt as string} {...props} />,
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

    test('renders image when getImage returns url and li has hover class', () => {
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
      expect(img).toHaveClass('object-contain');
      // the li wrapper should include hover bg class
      const li = document.querySelector('li');
      expect(li).toHaveClass('hover:bg-[#f5f5f5]');
    });
  });
});