import React from 'react';
import { render, screen } from '@testing-library/react';
import { Stats, StatItem } from '@/components/ui/Stats/Stats';

const items: StatItem[] = [
  { label: 'A', value: '1', icon: <i data-testid="icon"></i> },
];

describe('Stats component', () => {
  test('renders value, label, and icon with the data-ui contract', () => {
    const { container } = render(<Stats items={items} />);
    const root = container.querySelector('[data-ui-stats]');
    expect(root).toHaveAttribute('data-ui-size', 'md');
    expect(container.querySelector('[data-ui-stats-card]')).toBeInTheDocument();
    expect(screen.getByTestId('icon').parentElement).toHaveAttribute('data-ui-stats-icon', '');
    expect(screen.getByText('1')).toHaveAttribute('data-ui-stats-value', '');
    expect(screen.getByText('A')).toHaveAttribute('data-ui-stats-label', '');
  });

  test('size is reflected on data-ui-size', () => {
    const { container, rerender } = render(<Stats items={items} size="sm" />);
    expect(container.querySelector('[data-ui-stats]')).toHaveAttribute('data-ui-size', 'sm');
    rerender(<Stats items={items} size="lg" />);
    expect(container.querySelector('[data-ui-stats]')).toHaveAttribute('data-ui-size', 'lg');
  });

  test('forwards className props to the matching elements', () => {
    const { container } = render(
      <Stats
        items={items}
        className="root-x"
        cardClassName="card-x"
        valueClassName="val-x"
        labelClassName="lab-x"
      />,
    );
    expect(container.querySelector('[data-ui-stats]')).toHaveClass('root-x');
    expect(container.querySelector('[data-ui-stats-card]')).toHaveClass('card-x');
    expect(screen.getByText('1')).toHaveClass('val-x');
    expect(screen.getByText('A')).toHaveClass('lab-x');
  });

  test('renders without an icon wrapper when icon is omitted', () => {
    const { container } = render(<Stats items={[{ label: 'B', value: '2' }]} />);
    expect(container.querySelector('[data-ui-stats-icon]')).toBeNull();
    expect(screen.getByText('2')).toHaveAttribute('data-ui-stats-value', '');
  });
});
