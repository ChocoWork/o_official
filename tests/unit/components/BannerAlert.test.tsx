import { render, screen } from '@testing-library/react';
import { BannerAlert } from '@/components/ui/BannerAlert/BannerAlert';

// BannerAlert は CSS ファイル方式へ移行済み。余白（px-4 / py-2 など）は CSS の責務なので、
// ここでは size / variant / description 有無の属性契約と描画内容を検証する。
describe('BannerAlert', () => {
  const alertOf = (container: HTMLElement) => container.querySelector('[data-ui-banner-alert]');

  it('メッセージを描画する', () => {
    render(<BannerAlert message="Hello" />);
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });

  it('size は data-ui-banner-alert-size に反映される', () => {
    for (const size of ['sm', 'md', 'lg'] as const) {
      const { container } = render(<BannerAlert message="Hello" size={size} />);
      expect(alertOf(container)).toHaveAttribute('data-ui-banner-alert-size', size);
    }
  });

  it('size を切り替えると属性が追従する', () => {
    const { container, rerender } = render(<BannerAlert message="Hello" size="sm" />);
    expect(alertOf(container)).toHaveAttribute('data-ui-banner-alert-size', 'sm');

    rerender(<BannerAlert message="Hello" size="lg" />);
    expect(alertOf(container)).toHaveAttribute('data-ui-banner-alert-size', 'lg');
  });

  it('description の有無をタイトル側のフラグで表す', () => {
    const { container, rerender } = render(<BannerAlert message="Test" />);
    // 説明が無いときは属性そのものを出さない。
    expect(container.querySelector('[data-ui-banner-alert-has-description]')).toBeNull();

    rerender(<BannerAlert message="Test" description="詳細" />);
    expect(container.querySelector('[data-ui-banner-alert-has-description]')).toHaveAttribute(
      'data-ui-banner-alert-has-description',
      'true',
    );
    expect(screen.getByText('詳細')).toBeInTheDocument();
  });

  it('variant を属性へ出す', () => {
    const { container } = render(<BannerAlert message="Test" variant="error" />);
    expect(alertOf(container)).toHaveAttribute('data-ui-banner-alert-variant', 'error');
  });
});
