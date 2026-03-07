import React from 'react';
import { render, screen } from '@testing-library/react';
import { Tooltip } from '@/app/components/ui/Tooltip';

describe('Tooltip component', () => {
  test('renders content with default (md) size classes', () => {
    render(
      <Tooltip content="hello">
        <button>hover</button>
      </Tooltip>
    );
    const tip = screen.getByText('hello');
    expect(tip).toHaveClass('px-4');
    expect(tip).toHaveClass('py-2');
    expect(tip).toHaveClass('text-xs');
    // arrow should use md border size
    const arrow = tip.querySelector('span');
    expect(arrow).toHaveClass('border-l-4');
  });

  test('size prop modifies padding, text and arrow classes', () => {
    const { rerender } = render(
      <Tooltip content="small" size="sm">
        <button>hover</button>
      </Tooltip>
    );

    let tip = screen.getByText('small');
    expect(tip).toHaveClass('px-2', 'py-1', 'text-[10px]');
    let arrow = tip.querySelector('span');
    expect(arrow).toHaveClass('border-l-3');

    rerender(
      <Tooltip content="large" size="lg">
        <button>hover</button>
      </Tooltip>
    );
    tip = screen.getByText('large');
    expect(tip).toHaveClass('px-5', 'py-3', 'text-sm');
    arrow = tip.querySelector('span');
    expect(arrow).toHaveClass('border-l-5');
  });
});