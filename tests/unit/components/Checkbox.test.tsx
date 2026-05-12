import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import { Checkbox } from '@/components/ui/Checkbox';

describe('Checkbox component', () => {
  test('defaults to the compact hit area and keeps the row wrapper separate from the label', async () => {
    const user = userEvent.setup();
    const { container } = render(<Checkbox label="利用規約に同意する" />);
    const root = container.querySelector('[data-ui-checkbox]');

    if (!root) {
      throw new Error('Checkbox root not found');
    }

    const checkbox = screen.getByRole('checkbox', { name: '利用規約に同意する' });
    const textLabel = screen.getByText('利用規約に同意する');

    expect(root.tagName).toBe('DIV');
    expect(root).toHaveAttribute('data-ui-checkbox-expand-hit-area', 'false');

    await user.click(root);
    expect(checkbox).not.toBeChecked();

    await user.click(textLabel);
    expect(checkbox).toBeChecked();
  });

  test('keeps the expanded label hit area when enabled', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <Checkbox
        label="ニュースレターを受け取る"
        expandLabelHitArea
      />,
    );
    const root = container.querySelector('[data-ui-checkbox]');

    if (!root) {
      throw new Error('Checkbox root not found');
    }

    const checkbox = screen.getByRole('checkbox', { name: 'ニュースレターを受け取る' });

    expect(root.tagName).toBe('LABEL');
    expect(root).toHaveAttribute('data-ui-checkbox-expand-hit-area', 'true');

    await user.click(root);
    expect(checkbox).toBeChecked();
  });
});