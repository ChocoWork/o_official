import React from 'react';
import { render, screen } from '@testing-library/react';
import { ActionSheet } from '@/components/ui/ActionSheet/ActionSheet';
import type { ActionSheetAction } from '@/components/ui/ActionSheet/ActionSheet_types';

// ActionSheet は CSS ファイル方式へ移行済み。余白・文字サイズは CSS の責務なので、
// ここでは size / destructive の属性契約と、アクションの描画を検証する。
describe('ActionSheet', () => {
  const actions: ActionSheetAction[] = [
    { key: 'a', label: 'Action A', onSelect: jest.fn() },
    { key: 'b', label: 'Action B', onSelect: jest.fn(), destructive: true },
  ];

  const sheetOf = (container: HTMLElement) => container.querySelector('[data-ui-action-sheet]');

  test('アクションを描画する', () => {
    render(<ActionSheet open onClose={() => {}} actions={actions} />);

    expect(screen.getByRole('button', { name: 'Action A' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Action B' })).toBeInTheDocument();
  });

  test('既定は md サイズ', () => {
    const { container } = render(<ActionSheet open onClose={() => {}} actions={actions} />);
    expect(sheetOf(container)).toHaveAttribute('data-ui-action-sheet-size', 'md');
  });

  test('size は data-ui-action-sheet-size に反映される', () => {
    for (const size of ['sm', 'md', 'lg'] as const) {
      const { container } = render(
        <ActionSheet open onClose={() => {}} actions={actions} size={size} />,
      );
      expect(sheetOf(container)).toHaveAttribute('data-ui-action-sheet-size', size);
    }
  });

  test('destructive なアクションにフラグが立つ', () => {
    const { container } = render(<ActionSheet open onClose={() => {}} actions={actions} />);

    const flagged = container.querySelectorAll('[data-ui-action-sheet-destructive="true"]');
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toHaveTextContent('Action B');
  });
});
