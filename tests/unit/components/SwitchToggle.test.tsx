import { fireEvent, render, screen } from '@testing-library/react';
import { SwitchToggle } from '@/components/ui/SwitchToggle/SwitchToggle';

test('ariaLabel を指定すると正確な名前を持ち、label の可視 span を出さず操作できる', () => {
  const onChange = jest.fn();
  render(<SwitchToggle checked={false} onChange={onChange} label="表示しないラベル" ariaLabel="サポーター：荷作り・発送票閲覧" />);
  const toggle = screen.getByRole('switch', { name: 'サポーター：荷作り・発送票閲覧' });
  expect(screen.queryByText('表示しないラベル')).not.toBeInTheDocument();
  fireEvent.click(toggle);
  expect(onChange).toHaveBeenCalledWith(true);
});

test('ariaLabel が空文字でも可視 label を出さない', () => {
  render(<SwitchToggle checked onChange={jest.fn()} label="表示しないラベル" ariaLabel="" />);
  expect(screen.getByRole('switch')).toHaveAttribute('aria-label', '');
  expect(screen.queryByText('表示しないラベル')).not.toBeInTheDocument();
});

test('ariaLabel 未指定は従来の label と操作・disabled を保つ', () => {
  const onChange = jest.fn();
  const { rerender } = render(<SwitchToggle checked onChange={onChange} label="従来のラベル" />);
  const toggle = screen.getByRole('switch', { name: '従来のラベル' });
  expect(screen.getByText('従来のラベル')).toBeVisible();
  expect(toggle).not.toHaveAttribute('aria-label');
  fireEvent.click(toggle);
  expect(onChange).toHaveBeenCalledWith(false);
  rerender(<SwitchToggle checked onChange={onChange} label="従来のラベル" disabled />);
  fireEvent.click(toggle);
  expect(onChange).toHaveBeenCalledTimes(1);
});
