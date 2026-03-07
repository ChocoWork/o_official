import React from 'react';
import { render, screen } from '@testing-library/react';
import { List } from '@/app/components/ui/List';

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
    expect(ul).toHaveClass('space-y-3');
  });
});