import React from 'react';
import { render } from '@testing-library/react';
import { MapView } from '@/components/ui/MapView';

describe('MapView component', () => {
  test('default (md) embed container has h-48', () => {
    const { container } = render(<MapView embedUrl="https://example.com" />);
    const div = container.querySelector('div');
    expect(div).toHaveClass('h-48');
  });

  test('sm size embed container has h-32', () => {
    const { container } = render(<MapView embedUrl="https://example.com" size="sm" />);
    const div = container.querySelector('div');
    expect(div).toHaveClass('h-32');
  });

  test('lg size embed container has h-64', () => {
    const { container } = render(<MapView embedUrl="https://example.com" size="lg" />);
    const div = container.querySelector('div');
    expect(div).toHaveClass('h-64');
  });

  test('non-embed uses min-h classes', () => {
    const { container } = render(<MapView size="sm" showTitle />);
    // second div inside root corresponds to embedWrapper
    const divs = container.querySelectorAll('div > div');
    const inner = divs[1];
    expect(inner).toHaveClass('min-h-32');
  });
});