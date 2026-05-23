import React from 'react';
import { render, screen } from '@testing-library/react';
import { Accordion } from '@/components/ui/Accordion/Accordion';

describe('Accordion', () => {
  const items = [
    {
      key: 'shipping',
      title: 'Shipping',
      content: <p>Shipping details</p>,
    },
    {
      key: 'returns',
      title: 'Returns',
      content: <p>Returns details</p>,
    },
  ] as const;

  it('uses hover highlight by default', () => {
    const { container } = render(<Accordion items={items} />);

    expect(container.querySelector('[data-ui-accordion]')).toHaveAttribute(
      'data-ui-accordion-hover-highlight',
      'true',
    );
  });

  it('disables hover highlight when requested', () => {
    const { container } = render(<Accordion items={items} highlightOnHover={false} />);

    expect(container.querySelector('[data-ui-accordion]')).toHaveAttribute(
      'data-ui-accordion-hover-highlight',
      'false',
    );
  });

  it('disables underline when requested', () => {
    const { container } = render(<Accordion items={items} showUnderline={false} />);

    expect(container.querySelector('[data-ui-accordion]')).toHaveAttribute(
      'data-ui-accordion-show-underline',
      'false',
    );
  });

  it('opens the first default item in single mode', () => {
    render(<Accordion items={items} defaultOpenKeys={['shipping']} />);

    expect(screen.getByText('Shipping details')).toBeInTheDocument();
    expect(screen.queryByText('Returns details')).not.toBeInTheDocument();
  });
});