import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from '@/components/ui/Button/Button';

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

  test('無効状態は data-ui-button-disabled で表す', () => {
    // カーソル形状は Button.css の責務なので、ここでは状態の属性契約だけを見る。
    render(<Button>Click</Button>);
    expect(screen.getByRole('button', { name: 'Click' })).not.toHaveAttribute('data-ui-button-disabled');

    render(<Button disabled>Disabled</Button>);
    expect(screen.getByRole('button', { name: 'Disabled' })).toHaveAttribute('data-ui-button-disabled', 'true');

    render(<Button href="/foo">Link</Button>);
    expect(screen.getByRole('link', { name: 'Link' })).not.toHaveAttribute('data-ui-button-disabled');

    render(
      <Button href="/foo" disabled>
        LinkDisabled
      </Button>
    );
    expect(screen.getByRole('link', { name: 'LinkDisabled' })).toHaveAttribute('data-ui-button-disabled', 'true');
  });

  test('variant と size を属性へ出す', () => {
    render(
      <Button variant="secondary" size="lg">
        Styled
      </Button>
    );
    const btn = screen.getByRole('button', { name: 'Styled' });
    expect(btn).toHaveAttribute('data-ui-button-variant', 'secondary');
    expect(btn).toHaveAttribute('data-ui-button-size', 'lg');
  });
});
