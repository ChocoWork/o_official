import React from 'react';
import { render } from '@testing-library/react';
import { MapView } from '@/components/ui/MapView/MapView';

// MapView は CSS ファイル方式へ移行済み。高さ（h-48 / min-h-32 など）は CSS の責務なので、
// ここでは size / variant の属性契約と、埋め込みの有無による描画差を検証する。
describe('MapView component', () => {
  const rootOf = (container: HTMLElement) => container.querySelector('[data-ui-mapview]');

  test('既定は md サイズ', () => {
    const { container } = render(<MapView embedUrl="https://example.com" />);
    expect(rootOf(container)).toHaveAttribute('data-ui-mapview-size', 'md');
  });

  test('size は data-ui-mapview-size に反映される', () => {
    for (const size of ['sm', 'md', 'lg'] as const) {
      const { container } = render(<MapView embedUrl="https://example.com" size={size} />);
      expect(rootOf(container)).toHaveAttribute('data-ui-mapview-size', size);
    }
  });

  test('埋め込みURLがあれば iframe を描画する', () => {
    const { container } = render(<MapView embedUrl="https://example.com" />);
    expect(container.querySelector('iframe')).toHaveAttribute('src', 'https://example.com');
  });

  test('埋め込みURLが無ければ iframe を描画しない', () => {
    const { container } = render(<MapView size="sm" showTitle />);
    expect(container.querySelector('iframe')).toBeNull();
    // 埋め込みが無い場合も size の契約は保たれる
    expect(rootOf(container)).toHaveAttribute('data-ui-mapview-size', 'sm');
  });
});
