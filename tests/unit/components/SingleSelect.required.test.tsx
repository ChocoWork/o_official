import { render, screen } from '@testing-library/react';
import { SingleSelect } from '@/components/ui/SingleSelect/SingleSelect';

describe('SingleSelect required marker', () => {
  it('required のとき必須マーカーを表示し、トリガーに id を付ける', () => {
    render(
      <SingleSelect
        variant="dropdown"
        label="都道府県"
        name="prefecture"
        required
        options={[
          { value: '', label: '選択してください' },
          { value: '東京都', label: '東京都' },
        ]}
        value=""
      />,
    );

    const marker = screen.getByText('*');
    expect(marker).toHaveClass('single-select__required');
    expect(marker).toHaveAttribute('aria-hidden', 'true');
    // マーカーは aria-hidden なのでアクセシブル名は「都道府県」のまま（読み上げ二重化なし）
    expect(screen.getByRole('combobox', { name: '都道府県' })).toHaveAttribute(
      'id',
      'prefecture',
    );
  });

  it('required でないとき必須マーカーを表示しない', () => {
    render(
      <SingleSelect
        variant="dropdown"
        label="保存済みの配送先"
        name="savedAddress"
        options={[{ value: 'new', label: '新規' }]}
        value="new"
      />,
    );

    expect(screen.queryByText('*')).not.toBeInTheDocument();
  });
});
