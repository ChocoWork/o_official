import { render, screen, fireEvent } from '@testing-library/react';
import { Dialog } from '@/components/ui/Dialog/Dialog';

// Dialog は CSS ファイル方式へ移行済み。最大幅やボタン高さは CSS の責務なので、
// ここでは size の属性契約と、タイトル描画・バックドロップの閉じる動作を検証する。
describe('Dialog', () => {
  const dialogOf = (container: HTMLElement) => container.querySelector('[data-ui-dialog]');

  it('タイトルと既定のボタンを描画する', () => {
    render(<Dialog open onClose={() => {}} title="Hi" />);

    expect(screen.getByText('Hi')).toBeInTheDocument();
    expect(screen.getByText('CANCEL')).toBeInTheDocument();
    expect(screen.getByText('CONFIRM')).toBeInTheDocument();
  });

  it('size は data-ui-dialog-size に反映される', () => {
    for (const size of ['sm', 'md', 'lg'] as const) {
      const { container } = render(<Dialog open onClose={() => {}} size={size} title="T" />);
      expect(dialogOf(container)).toHaveAttribute('data-ui-dialog-size', size);
    }
  });

  it('size を切り替えると属性が追従する', () => {
    const { container, rerender } = render(<Dialog open onClose={() => {}} size="sm" title="T" />);
    expect(dialogOf(container)).toHaveAttribute('data-ui-dialog-size', 'sm');

    rerender(<Dialog open onClose={() => {}} size="lg" title="T" />);
    expect(dialogOf(container)).toHaveAttribute('data-ui-dialog-size', 'lg');
  });

  it('バックドロップのクリックで onClose を呼ぶ', () => {
    const onClose = jest.fn();
    render(<Dialog open onClose={onClose} title="Test" />);

    fireEvent.click(document.querySelector('.dialog-overlay')!);
    expect(onClose).toHaveBeenCalled();
  });
});
