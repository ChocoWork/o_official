import React from 'react';
import { render, screen } from '@testing-library/react';
import { StatusBadge } from '@/app/components/ui/StatusBadge';

describe('StatusBadge sizing', () => {
  test('text variant default md', () => {
    const { container } = render(<StatusBadge>Label</StatusBadge>);
    const badge = container.querySelector('span');
    expect(badge).toHaveClass('px-3', 'py-1', 'text-xs');
  });

  test('text variant sm and lg', () => {
    const { container: c1 } = render(<StatusBadge size="sm">Small</StatusBadge>);
    expect(c1.querySelector('span')).toHaveClass('px-2', 'py-[2px]', 'text-[10px]');

    const { container: c2 } = render(<StatusBadge size="lg">Large</StatusBadge>);
    expect(c2.querySelector('span')).toHaveClass('px-4', 'py-2', 'text-sm');
  });

  test('dot variant respects size map', () => {
    const { container: cSm } = render(<StatusBadge variant="dot" size="sm" />);
    expect(cSm.querySelector('span')).toHaveClass('h-1', 'w-1');

    const { container: cMd } = render(<StatusBadge variant="dot" size="md" />);
    expect(cMd.querySelector('span')).toHaveClass('h-2', 'w-2');

    const { container: cLg } = render(<StatusBadge variant="dot" size="lg" />);
    expect(cLg.querySelector('span')).toHaveClass('h-3', 'w-3');
  });

  test('count variant sizes and padding', () => {
    const { container: cSm } = render(<StatusBadge variant="count" count={5} size="sm" />);
    expect(cSm.querySelector('span')).toHaveClass('h-4', 'text-xs');

    const { container: cMd } = render(<StatusBadge variant="count" count={12} size="md" />);
    expect(cMd.querySelector('span')).toHaveClass('h-5', 'text-xs');

    const { container: cLg } = render(<StatusBadge variant="count" count={123} size="lg" />);
    expect(cLg.querySelector('span')).toHaveClass('h-6', 'text-sm');
  });
});
