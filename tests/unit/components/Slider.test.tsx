import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { Slider } from '@/components/ui/Slider/Slider';

describe('Slider component', () => {
  test('keeps the exact max endpoint reachable for uneven price bounds', () => {
    const handleRangeChange = jest.fn();
    const { rerender } = render(
      <Slider
        mode="range"
        min={2}
        max={89000}
        step={1000}
        rangeValue={[2, 89000]}
        onRangeChange={handleRangeChange}
      />,
    );

    const [minimumSlider, maximumSlider] = screen.getAllByRole('slider');
    fireEvent.change(minimumSlider, { target: { value: '1' } });

    expect(handleRangeChange).toHaveBeenLastCalledWith([1000, 89000]);

    rerender(
      <Slider
        mode="range"
        min={2}
        max={89000}
        step={1000}
        rangeValue={[1000, 88000]}
        onRangeChange={handleRangeChange}
      />,
    );

    const [, updatedMaximumSlider] = screen.getAllByRole('slider');
    fireEvent.change(updatedMaximumSlider, { target: { value: '89' } });

    expect(handleRangeChange).toHaveBeenLastCalledWith([1000, 89000]);
  });

  test('renders the active fill within the track bounds', () => {
    render(
      <Slider
        mode="range"
        min={2}
        max={89000}
        step={1000}
        rangeValue={[1000, 88000]}
        onRangeChange={jest.fn()}
      />,
    );

    const fill = screen.getByTestId('price-range-fill');
    const left = Number.parseFloat(fill.style.left);
    const width = Number.parseFloat(fill.style.width);

    expect(left).toBeGreaterThanOrEqual(0);
    expect(left).toBeLessThanOrEqual(100);
    expect(width).toBeGreaterThanOrEqual(0);
    expect(width).toBeLessThanOrEqual(100);
    expect(left + width).toBeLessThanOrEqual(100);
  });
});