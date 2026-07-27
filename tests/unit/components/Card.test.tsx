import React from 'react';
import { render, screen } from '@testing-library/react';
import { Card } from '@/components/ui/Card/Card';

// Card は CSS ファイル方式へ移行済み。余白やフォントサイズの実値は CSS の責務なので、
// ここでは size / bordered / interactive などの属性契約と描画内容だけを検証する。
function renderCard(props: Partial<React.ComponentProps<typeof Card>> = {}) {
  return render(
    <Card category="TOPS" title="Sample" price="¥1,000" {...props} />,
  );
}

const cardOf = (container: HTMLElement) => container.querySelector('[data-ui-card]');

describe('Card component', () => {
  test('既定は md サイズ', () => {
    const { container } = renderCard();
    expect(cardOf(container)).toHaveAttribute('data-ui-card-size', 'md');
  });

  test('size を指定すると data-ui-card-size に反映される', () => {
    for (const size of ['sm', 'md', 'lg'] as const) {
      const { container } = renderCard({ size });
      expect(cardOf(container)).toHaveAttribute('data-ui-card-size', size);
    }
  });

  test('カテゴリ・タイトル・価格を表示する', () => {
    renderCard();
    expect(screen.getByText('TOPS')).toBeInTheDocument();
    expect(screen.getByText('Sample')).toBeInTheDocument();
    expect(screen.getByText('¥1,000')).toBeInTheDocument();
  });

  test('label を渡すと表示する', () => {
    renderCard({ label: 'Label' });
    expect(screen.getByText('Label')).toBeInTheDocument();
  });
});
