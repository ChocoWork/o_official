import React from 'react';
import { render, screen } from '@testing-library/react';
import { Drawer } from '@/components/ui/Drawer/Drawer';

// Drawer は CSS ファイル方式へ移行済み。幅（max-w-md など）は CSS の責務なので、
// ここでは size / side の属性契約と中身の描画を検証する。
describe('Drawer', () => {
  const children = <div>content</div>;
  const baseProps = { open: true, onClose: () => {} };
  const drawerOf = (container: HTMLElement) => container.querySelector('[data-ui-drawer]');

  it('中身を描画する', () => {
    render(<Drawer {...baseProps}>{children}</Drawer>);
    expect(screen.getByText('content')).toBeInTheDocument();
  });

  it('既定は md サイズ', () => {
    const { container } = render(<Drawer {...baseProps}>{children}</Drawer>);
    expect(drawerOf(container)).toHaveAttribute('data-ui-drawer-size', 'md');
  });

  it('size は data-ui-drawer-size に反映される', () => {
    for (const size of ['sm', 'md', 'lg'] as const) {
      const { container } = render(
        <Drawer {...baseProps} size={size}>
          {children}
        </Drawer>,
      );
      expect(drawerOf(container)).toHaveAttribute('data-ui-drawer-size', size);
    }
  });

  it('side を属性へ出す', () => {
    const { container } = render(
      <Drawer {...baseProps} side="left">
        {children}
      </Drawer>,
    );
    expect(drawerOf(container)).toHaveAttribute('data-ui-drawer-side', 'left');
  });
});
