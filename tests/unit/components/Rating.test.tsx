import React from 'react';
import { render, screen } from '@testing-library/react';
import { Rating } from '@/components/ui/Rating';

describe('Rating component', () => {
  test('renders correct number of stars and applies small size classes', () => {
    render(<Rating value={3} max={5} size="sm" readOnly />);
    const stars = screen.getAllByTestId('rating-star');
    expect(stars).toHaveLength(5);

    // each wrapper should include the small size dimensions/text
    stars.forEach((star) => {
      expect(star).toHaveClass('h-4');
      expect(star).toHaveClass('w-4');
      expect(star).toHaveClass('text-xl');
    });
  });

  test('switching size updates the class names', () => {
    const { rerender } = render(<Rating value={2} max={5} size="md" readOnly />);
    let stars = screen.getAllByTestId('rating-star');
    stars.forEach((star) => {
      expect(star).toHaveClass('h-6');
      expect(star).toHaveClass('w-6');
      expect(star).toHaveClass('text-2xl');
    });

    rerender(<Rating value={2} max={5} size="lg" readOnly />);
    stars = screen.getAllByTestId('rating-star');
    stars.forEach((star) => {
      expect(star).toHaveClass('h-8');
      expect(star).toHaveClass('w-8');
      expect(star).toHaveClass('text-3xl');
    });
  });

  test('interactive mode adds buttons with aria-labels', () => {
    const onChange = jest.fn();
    render(<Rating value={1} max={3} onChange={onChange} size="md" />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(3);
    expect(buttons[0]).toHaveAttribute('aria-label', 'rating-1');
    expect(buttons[1]).toHaveAttribute('aria-label', 'rating-2');
  });
});
