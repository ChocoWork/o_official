import React from 'react';
import { render, screen } from '@testing-library/react';
import { Toolbar } from '@/components/ui/Toolbar/Toolbar';
import type { ToolbarItem } from '@/components/ui/Toolbar/Toolbar_type';

// Toolbar は CSS ファイル方式へ移行済み。余白・寸法は CSS の責務なので、
// ここでは size / variant / ラベル有無の属性契約と描画を検証する。
const items: ToolbarItem[] = [
  { key: 'one', iconClass: 'ri-star-line', label: 'One' },
  { key: 'two', iconClass: 'ri-heart-line' },
];

describe('Toolbar component', () => {
  const toolbarOf = (container: HTMLElement) => container.querySelector('[data-ui-toolbar]');

  test('左右の項目を描画する', () => {
    const { container } = render(<Toolbar leftItems={items} />);

    expect(screen.getByRole('button', { name: 'One' })).toBeInTheDocument();
    expect(container.querySelectorAll('button')).toHaveLength(items.length);
  });

  test('既定は md サイズ', () => {
    const { container } = render(<Toolbar leftItems={items} />);
    expect(toolbarOf(container)).toHaveAttribute('data-ui-toolbar-size', 'md');
  });

  test('size は data-ui-toolbar-size に反映される', () => {
    for (const size of ['sm', 'md', 'lg'] as const) {
      const { container } = render(<Toolbar leftItems={items} size={size} />);
      expect(toolbarOf(container)).toHaveAttribute('data-ui-toolbar-size', size);
    }
  });

  test('ラベルの有無を項目のフラグで表す', () => {
    const { container } = render(<Toolbar leftItems={items} />);
    const buttons = container.querySelectorAll('button');

    // ラベルがある項目にだけフラグが立ち、無い項目では属性そのものを出さない。
    expect(buttons[0]).toHaveAttribute('data-ui-toolbar-item-has-label', 'true');
    expect(buttons[1]).not.toHaveAttribute('data-ui-toolbar-item-has-label');
  });
});
