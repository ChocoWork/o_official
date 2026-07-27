import React from 'react';
import { render, screen } from '@testing-library/react';
import { Tooltip } from '@/components/ui/Tooltip/Tooltip';

// Tooltip は CSS ファイル方式へ移行済み。余白・文字サイズ・矢印の枠線幅は CSS の責務なので、
// ここでは size / placement / shape の属性契約と内容の描画だけを検証する。
describe('Tooltip component', () => {
  const tipOf = () => document.querySelector('[data-ui-tooltip]');

  test('content を描画し、既定は md サイズ', () => {
    render(
      <Tooltip content="hello">
        <button>hover</button>
      </Tooltip>,
    );

    expect(screen.getByText('hello')).toBeInTheDocument();
    expect(tipOf()).toHaveAttribute('data-ui-tooltip-size', 'md');
    expect(tipOf()).toHaveAttribute('data-ui-size', 'md');
  });

  test('size は属性に反映され、切り替えで追従する', () => {
    const { rerender } = render(
      <Tooltip content="small" size="sm">
        <button>hover</button>
      </Tooltip>,
    );
    expect(tipOf()).toHaveAttribute('data-ui-tooltip-size', 'sm');

    rerender(
      <Tooltip content="large" size="lg">
        <button>hover</button>
      </Tooltip>,
    );
    expect(tipOf()).toHaveAttribute('data-ui-tooltip-size', 'lg');
  });

  test('placement を属性へ出す', () => {
    render(
      <Tooltip content="tip" placement="bottom">
        <button>hover</button>
      </Tooltip>,
    );
    expect(tipOf()).toHaveAttribute('data-ui-tooltip-placement', 'bottom');
  });

  test('トリガーの子要素をそのまま描画する', () => {
    render(
      <Tooltip content="tip">
        <button>hover</button>
      </Tooltip>,
    );
    expect(screen.getByRole('button', { name: 'hover' })).toBeInTheDocument();
  });
});
