import { render, screen } from '@testing-library/react';
import { BannerAlert } from '@/components/ui/BannerAlert';

describe('BannerAlert', () => {
  it('renders message and applies size classes', () => {
    const { rerender } = render(<BannerAlert message="Hello" size="sm" />);
    const findOuter = (el: Element | null) => {
      let cur = el;
      while (cur && cur !== document.body) {
        if (cur.className && typeof cur.className === 'string' && cur.className.match(/px-\d/)) {
          return cur;
        }
        cur = cur.parentElement;
      }
      return null;
    };

    const textEl = screen.getByText('Hello');
    const container = findOuter(textEl);
    expect(container).toBeInTheDocument();
    expect(container).toHaveClass('px-4', 'py-2');

    rerender(<BannerAlert message="Hello" size="lg" />);
    const textEl2 = screen.getByText('Hello');
    const containerLg = findOuter(textEl2);
    expect(containerLg).toHaveClass('px-8', 'py-6');
  });

  it('hides icon when not provided and shows when provided', () => {
    render(<BannerAlert message="Test" />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});
