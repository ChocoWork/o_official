import React from 'react';
import { render, screen } from '@testing-library/react';
import { Toolbar, ToolbarItem } from '@/components/ui/Toolbar';

const items: ToolbarItem[] = [
  { key: 'one', iconClass: 'ri-star-line', label: 'One' },
  { key: 'two', iconClass: 'ri-heart-line' },
];

describe('Toolbar component', () => {
  test('default md size applies expected paddings and dimensions', () => {
    const { container } = render(<Toolbar leftItems={items} />);
    const header = container.querySelector('header');
    expect(header).toHaveClass('p-4');

    const buttons = container.querySelectorAll('button');
    // first button has label
    expect(buttons[0]).toHaveClass('h-10');
    expect(buttons[0]).toHaveClass('gap-2');
    const label = screen.getByText('One');
    expect(label).toHaveClass('text-sm');
    // second button is icon-only
    expect(buttons[1]).toHaveClass('w-10');
  });

  test('sm size shrinks everything', () => {
    const { container } = render(<Toolbar leftItems={items} size="sm" />);
    const header = container.querySelector('header');
    expect(header).toHaveClass('p-2');

    const buttons = container.querySelectorAll('button');
    expect(buttons[0]).toHaveClass('h-8');
    expect(buttons[0]).toHaveClass('gap-1');
    const label = screen.getByText('One');
    expect(label).toHaveClass('text-xs');
    expect(buttons[1]).toHaveClass('w-8');
  });

  test('lg size increases everything', () => {
    const { container } = render(<Toolbar leftItems={items} size="lg" />);
    const header = container.querySelector('header');
    expect(header).toHaveClass('p-6');

    const buttons = container.querySelectorAll('button');
    expect(buttons[0]).toHaveClass('h-12');
    expect(buttons[0]).toHaveClass('gap-3');
    const label = screen.getByText('One');
    expect(label).toHaveClass('text-base');
    expect(buttons[1]).toHaveClass('w-12');
  });
});
