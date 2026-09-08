import { fireEvent, render, screen } from '@testing-library/react';
import { Sheet } from '@/components/ui/Sheet/Sheet';

// FREQ-347: Sheet をモーダルとして正しく振る舞わせる

describe('Sheet', () => {
  it('title があれば dialog の名前は title になる', () => {
    render(
      <Sheet open onClose={() => {}} title="OPTIONS">
        <p>content</p>
      </Sheet>,
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('OPTIONS');
  });

  it('title がなければ aria-label を名前に使う', () => {
    render(
      <Sheet open onClose={() => {}} aria-label="選択">
        <p>content</p>
      </Sheet>,
    );

    expect(screen.getByRole('dialog')).toHaveAccessibleName('選択');
  });

  it('Escape で onClose を呼ぶ', () => {
    const onClose = jest.fn();
    render(
      <Sheet open onClose={onClose} title="OPTIONS">
        <p>content</p>
      </Sheet>,
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('開いている間は背景をスクロールさせず、閉じたら元に戻す', () => {
    const { rerender } = render(
      <Sheet open onClose={() => {}} title="OPTIONS">
        <p>content</p>
      </Sheet>,
    );
    expect(document.body.style.overflow).toBe('hidden');

    rerender(
      <Sheet open={false} onClose={() => {}} title="OPTIONS">
        <p>content</p>
      </Sheet>,
    );
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('開いたときシート内へフォーカスを移す', () => {
    render(
      <Sheet open onClose={() => {}} title="OPTIONS">
        <button type="button">buy</button>
      </Sheet>,
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});
