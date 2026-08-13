import { fireEvent, render, screen } from '@testing-library/react';
import { SingleSelect } from '@/components/ui/SingleSelect/SingleSelect';

describe('SingleSelect option actions', () => {
  it('runs an option action without selecting the option', () => {
    const onValueChange = jest.fn();
    const onDelete = jest.fn();
    render(
      <SingleSelect
        variant="dropdown"
        aria-label="支出摘要"
        options={[
          { value: '__add__', label: '＋ 新しい項目を追加' },
          { value: 'custom', label: '外注検品', actionLabel: '外注検品を削除', onAction: onDelete },
        ]}
        value=""
        onValueChange={onValueChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '支出摘要' }));
    fireEvent.click(screen.getByRole('button', { name: '外注検品を削除' }));

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onValueChange).not.toHaveBeenCalled();
  });
});
