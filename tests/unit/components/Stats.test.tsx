import React from 'react';
import { render, screen } from '@testing-library/react';
import { Stats, StatItem } from '@/components/ui/Stats';

const items: StatItem[] = [
  { label: 'A', value: '1', icon: <i data-testid="icon"></i> },
];

describe('Stats component', () => {
  test('default md size applies mid padding and text', () => {
    const { container } = render(<Stats items={items} />);
    // find card by border class
    const card = container.querySelector('div.border');
    expect(card).toHaveClass('p-6');
    const icon = screen.getByTestId('icon');
    expect(icon.parentElement).toHaveClass('h-10');
    const value = screen.getByText('1');
    expect(value).toHaveClass('text-3xl');
  });

  test('sm size shrinks padding, icon, and value', () => {
    const { container } = render(<Stats items={items} size="sm" />);
    const card = container.querySelector('div.border');
    expect(card).toHaveClass('p-4');
    const icon = screen.getByTestId('icon');
    expect(icon.parentElement).toHaveClass('h-6');
    const value = screen.getByText('1');
    expect(value).toHaveClass('text-2xl');
  });

  test('lg size increases padding, icon, and value', () => {
    const { container } = render(<Stats items={items} size="lg" />);
    const card = container.querySelector('div.border');
    expect(card).toHaveClass('p-8');
    const icon = screen.getByTestId('icon');
    expect(icon.parentElement).toHaveClass('h-12');
    const value = screen.getByText('1');
    expect(value).toHaveClass('text-4xl');
  });
});