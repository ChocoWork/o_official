import React from 'react';
import { render, screen } from '@testing-library/react';
import { Rating } from '@/components/ui/Rating/Rating';

// Rating は CSS ファイル方式へ移行済み。星の寸法（h-4 / w-4 など）は CSS の責務なので、
// ここでは星の本数・size 属性・操作可否といった振る舞いの契約だけを検証する。
describe('Rating component', () => {
  const rootOf = (container: HTMLElement) => container.querySelector('[data-ui-rating]');

  test('max の数だけ星を描画する', () => {
    render(<Rating value={3} max={5} size="sm" readOnly />);
    expect(screen.getAllByTestId('rating-star')).toHaveLength(5);
  });

  test('size は data-ui-size に反映される', () => {
    for (const size of ['sm', 'md', 'lg'] as const) {
      const { container } = render(<Rating value={2} max={5} size={size} readOnly />);
      expect(rootOf(container)).toHaveAttribute('data-ui-size', size);
    }
  });

  test('size を切り替えると属性が追従する', () => {
    const { container, rerender } = render(<Rating value={2} max={5} size="md" readOnly />);
    expect(rootOf(container)).toHaveAttribute('data-ui-size', 'md');

    rerender(<Rating value={2} max={5} size="lg" readOnly />);
    expect(rootOf(container)).toHaveAttribute('data-ui-size', 'lg');
  });

  test('readOnly ではボタンにしない', () => {
    render(<Rating value={3} max={5} readOnly />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  test('操作可能なときはボタンと aria-label を出す', () => {
    const onChange = jest.fn();
    render(<Rating value={1} max={3} onChange={onChange} size="md" />);

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(3);
    expect(buttons[0]).toHaveAttribute('aria-label', 'rating-1');
    expect(buttons[1]).toHaveAttribute('aria-label', 'rating-2');
  });
});
