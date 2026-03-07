import React from 'react';
import { render, screen } from '@testing-library/react';
import { Card } from '@/app/components/ui/Card';

// simple helper to render card with title/price
function renderCard(size?: 'sm' | 'md' | 'lg') {
  return render(
    <Card
      category="TOPS"
      title="Sample"
      price="¥1,000"
      size={size}
    />
  );
}

describe('Card component', () => {
  test('defaults to medium padding and text size', () => {
    const { container } = renderCard();
    const article = container.querySelector('article');
    expect(article).toHaveClass('p-6');
    const title = screen.getByText('Sample');
    expect(title).toHaveClass('text-base');
    const price = screen.getByText('¥1,000');
    expect(price).toHaveClass('text-base');
  });

  test('small size uses smaller padding and font sizes', () => {
    const { container } = renderCard('sm');
    const article = container.querySelector('article');
    expect(article).toHaveClass('p-4');
    const title = screen.getByText('Sample');
    expect(title).toHaveClass('text-sm');
    const price = screen.getByText('¥1,000');
    expect(price).toHaveClass('text-sm');
  });
  
  test('renders optional label', () => {
    render(
      <Card category="TOPS" title="A" price="¥1" label="Label" />
    );
    expect(screen.getByText('Label')).toBeInTheDocument();
  });

  test('large size uses larger padding and font sizes', () => {
    const { container } = renderCard('lg');
    const article = container.querySelector('article');
    expect(article).toHaveClass('p-8');
    const title = screen.getByText('Sample');
    expect(title).toHaveClass('text-lg');
    const price = screen.getByText('¥1,000');
    expect(price).toHaveClass('text-lg');
  });
});