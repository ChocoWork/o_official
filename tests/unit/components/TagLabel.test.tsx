import { render, screen, fireEvent } from '@testing-library/react';
import { TagLabel } from '@/components/ui/TagLabel/TagLabel';

describe('TagLabel', () => {
  it.each(['xs', 'sm', 'md', 'lg', 'xl'] as const)('applies the %s size token', (size) => {
    render(<TagLabel size={size}>Hello</TagLabel>);

    expect(screen.getByText('Hello')).toHaveAttribute('data-ui-tag-label-size', size);
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
