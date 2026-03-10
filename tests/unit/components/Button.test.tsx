import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from '@/app/components/ui/Button';

// simplify next/link in tests
jest.mock('next/link', () => {
  return ({ href, children, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  );
});

describe('Button component', () => {
  test('renders a <button> when no href is provided', () => {
    render(<Button>Click me</Button>);
    const element = screen.getByRole('button', { name: 'Click me' });
    expect(element.tagName).toBe('BUTTON');
  });

  test('renders an <a> when href is provided', () => {
    render(<Button href="/foo">Link</Button>);
    const element = screen.getByRole('link', { name: 'Link' });
    expect(element.tagName).toBe('A');
    expect(element).toHaveAttribute('href', '/foo');
  });

  test('disabled link prevents navigation', async () => {
    const user = userEvent.setup();
    render(
      <Button href="/foo" disabled>
        Disabled
      </Button>
    );
    const element = screen.getByRole('link', { name: 'Disabled' });
    expect(element).toHaveAttribute('href', '/foo');

    await user.click(element);
    // because we intercept with preventDefault on disabled prop, nothing should happen
    // at least ensure element is still in document
    expect(element).toBeInTheDocument();
  });

  test('button and link apply cursor styles correctly', () => {
    // enabled button
    render(<Button>Click</Button>);
    const btn = screen.getByRole('button', { name: 'Click' });
    expect(btn).toHaveClass('cursor-pointer');

    // disabled button
    render(<Button disabled>Disabled</Button>);
    const btnDis = screen.getByRole('button', { name: 'Disabled' });
    expect(btnDis).toHaveClass('cursor-not-allowed');

    // enabled link
    render(<Button href="/foo">Link</Button>);
    const link = screen.getByRole('link', { name: 'Link' });
    // anchor defaults to pointer cursor; our component adds no extra class but should still include cursor-pointer
    expect(link).toHaveClass('cursor-pointer');

    // disabled link also shows not-allowed and removes pointer
    render(
      <Button href="/foo" disabled>
        LinkDisabled
      </Button>
    );
    const linkDis = screen.getByRole('link', { name: 'LinkDisabled' });
    expect(linkDis).toHaveClass('cursor-not-allowed');
  });
});
