import React from 'react';
import { render, screen } from '@testing-library/react';
import { ActionSheet, ActionSheetAction } from '@/components/ui/ActionSheet';

describe('ActionSheet sizing', () => {
  const actions: ActionSheetAction[] = [
    { key: 'a', label: 'Action A', onSelect: jest.fn() },
    { key: 'b', label: 'Action B', onSelect: jest.fn(), destructive: true },
  ];

  test('default md buttons have medium padding and text', () => {
    const { container } = render(
      <ActionSheet open onClose={() => {}} actions={actions} />
    );
    const buttons = container.querySelectorAll('button');
    expect(buttons[0]).toHaveClass('px-6', 'py-4', 'text-sm');
    expect(buttons[1]).toHaveClass('px-6', 'py-4', 'text-sm');
  });

  test('sm size shrinks padding and text', () => {
    const { container } = render(
      <ActionSheet open onClose={() => {}} actions={actions} size="sm" />
    );
    const btn = container.querySelector('button');
    expect(btn).toHaveClass('px-4', 'py-2', 'text-xs');
  });

  test('lg size increases padding and text', () => {
    const { container } = render(
      <ActionSheet open onClose={() => {}} actions={actions} size="lg" />
    );
    const btn = container.querySelector('button');
    expect(btn).toHaveClass('px-8', 'py-6', 'text-base');
  });
});
