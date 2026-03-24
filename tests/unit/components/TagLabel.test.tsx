import { render, screen, fireEvent } from '@testing-library/react';
import { TagLabel } from '@/components/ui/TagLabel';

describe('TagLabel', () => {
  it('renders children and adjusts size padding/font', () => {
    const { rerender } = render(<TagLabel size="sm">Hello</TagLabel>);
    const el = screen.getByText('Hello');
    expect(el).toHaveClass('px-2', 'py-0.5');

    rerender(<TagLabel size="lg">Hello</TagLabel>);
    const elLg = screen.getByText('Hello');
    expect(elLg).toHaveClass('px-4', 'py-1.5', 'text-sm');
  });

  it('calls onRemove when removable', () => {
    const fn = jest.fn();
    render(
      <TagLabel removable onRemove={fn}>
        Remove
      </TagLabel>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(fn).toHaveBeenCalled();
  });
});
