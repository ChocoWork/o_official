import React from 'react';
import { render, screen } from '@testing-library/react';
import { MultiSelect } from '@/components/ui/MultiSelect/MultiSelect';

describe('MultiSelect component', () => {
  const options = [
    { value: 'ALL', label: 'ALL' },
    { value: 'NEWS', label: 'NEWS' },
  ];

  test('defaults to the compact checkbox hit area', () => {
    const { container } = render(
      <MultiSelect
        variant="panel"
        options={options}
        values={['ALL']}
        onChange={jest.fn()}
      />,
    );

    const checkbox = screen.getByRole('checkbox', { name: 'ALL' });
    const root = checkbox.closest('[data-ui-checkbox]');

    expect(root).toBeInTheDocument();
    expect(root).toHaveAttribute('data-ui-checkbox-expand-hit-area', 'false');
    expect(root).toHaveClass('py-[3px]');
    expect(root).not.toHaveClass('hover:bg-[#f5f5f5]');
    expect(container.querySelectorAll('[data-ui-checkbox]').length).toBe(2);
  });

  test('can opt into the expanded checkbox hit area', () => {
    render(
      <MultiSelect
        variant="panel"
        options={options}
        values={['ALL']}
        onChange={jest.fn()}
        expandLabelHitArea
      />,
    );

    const checkbox = screen.getByRole('checkbox', { name: 'ALL' });
    const root = checkbox.closest('[data-ui-checkbox]');

    expect(root).toBeInTheDocument();
    expect(root).toHaveAttribute('data-ui-checkbox-expand-hit-area', 'true');
    expect(root).toHaveClass('py-1.5');
    expect(root).toHaveClass('hover:bg-[#f5f5f5]');
  });
});