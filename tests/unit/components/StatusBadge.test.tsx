import React from 'react';
import { render } from '@testing-library/react';
import { StatusBadge } from '@/components/ui/StatusBadge/StatusBadge';

// StatusBadge は Tailwind ユーティリティ直書きから CSS ファイル方式へ移行済み。
// 見た目の値（px-3 / h-5 など）は CSS 側の責務なので、ここでは
// 「どの variant / size で描画したか」という属性契約だけを検証する。
describe('StatusBadge', () => {
  const badgeOf = (container: HTMLElement) => container.querySelector('[data-ui-badge]');

  test('既定は text variant / md サイズ', () => {
    const { container } = render(<StatusBadge>Label</StatusBadge>);
    const badge = badgeOf(container);

    expect(badge).toHaveAttribute('data-ui-badge-variant', 'text');
    expect(badge).toHaveAttribute('data-ui-size', 'md');
    expect(badge).toHaveTextContent('Label');
  });

  test('size を指定すると data-ui-size に反映される', () => {
    for (const size of ['sm', 'md', 'lg'] as const) {
      const { container } = render(<StatusBadge size={size}>Label</StatusBadge>);
      expect(badgeOf(container)).toHaveAttribute('data-ui-size', size);
    }
  });

  test('dot variant は size を保ったまま variant を切り替える', () => {
    for (const size of ['sm', 'md', 'lg'] as const) {
      const { container } = render(<StatusBadge variant="dot" size={size} />);
      const badge = badgeOf(container);

      expect(badge).toHaveAttribute('data-ui-badge-variant', 'dot');
      expect(badge).toHaveAttribute('data-ui-size', size);
    }
  });

  test('count variant は件数を表示し size を反映する', () => {
    const { container } = render(<StatusBadge variant="count" count={12} size="lg" />);
    const badge = badgeOf(container);

    expect(badge).toHaveAttribute('data-ui-badge-variant', 'count');
    expect(badge).toHaveAttribute('data-ui-size', 'lg');
    expect(badge).toHaveTextContent('12');
  });

  test('桁数が多い count は multi フラグが立つ', () => {
    const { container: single } = render(<StatusBadge variant="count" count={5} />);
    expect(badgeOf(single)).not.toHaveAttribute('data-ui-badge-multi');

    const { container: multi } = render(<StatusBadge variant="count" count={123} />);
    expect(badgeOf(multi)).toHaveAttribute('data-ui-badge-multi', 'true');
  });

  test('tone は text variant の属性として出る', () => {
    const { container } = render(<StatusBadge tone="danger">NG</StatusBadge>);
    expect(badgeOf(container)).toHaveAttribute('data-ui-badge-tone', 'danger');
  });
});
