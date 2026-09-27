import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { SingleSelect } from '@/components/ui/SingleSelect/SingleSelect';

// FREQ-379: dropdown の SingleSelect を APG の select-only combobox にする。
// 見出しは for で結び、誤りの案内は説明（aria-describedby）と誤りの状態（aria-invalid）で伝え、
// キーボードだけで選べるようにする。

const PREFECTURES = [
  { value: '', label: '選択してください' },
  { value: '北海道', label: '北海道' },
  { value: '青森県', label: '青森県' },
  { value: '東京都', label: '東京都' },
];

function ControlledPrefecture({
  errorText,
  onChange = () => {},
  initial = '',
}: {
  errorText?: string;
  onChange?: (value: string) => void;
  initial?: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <SingleSelect
      variant="dropdown"
      name="prefecture"
      label="都道府県"
      required
      options={PREFECTURES}
      value={value}
      errorText={errorText}
      onValueChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

describe('SingleSelect（dropdown）の combobox（FREQ-379）', () => {
  it('引き金は見出しを名前に持つ閉じた combobox', () => {
    render(<ControlledPrefecture />);

    const combobox = screen.getByRole('combobox', { name: '都道府県' });
    expect(combobox).toHaveAttribute('aria-expanded', 'false');
    expect(combobox).toHaveAttribute('aria-haspopup', 'listbox');
    expect(combobox).toHaveAttribute('aria-required', 'true');
    expect(combobox).toHaveAttribute('id', 'prefecture');
    // 見出しは部品全体を包まず、for で結びつける
    expect(screen.getByText('都道府県').closest('label')).toHaveAttribute('for', 'prefecture');
    expect(combobox.closest('label')).toBeNull();
  });

  it('案内が無いときは誤りの状態にせず、読み上げの入れ物だけを置く', () => {
    const { container } = render(<ControlledPrefecture />);

    const combobox = screen.getByRole('combobox', { name: '都道府県' });
    expect(combobox).not.toHaveAttribute('aria-invalid');
    expect(combobox).not.toHaveAttribute('aria-describedby');
    const region = container.querySelector('#prefecture-error');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent('');
  });

  it('案内があると、説明として結びつき、誤りの状態になる。名前には混ざらない', () => {
    render(<ControlledPrefecture errorText="都道府県を選択してください" />);

    const combobox = screen.getByRole('combobox', { name: '都道府県' });
    expect(combobox).toHaveAttribute('aria-invalid', 'true');
    expect(combobox).toHaveAttribute('aria-describedby', 'prefecture-error');
    expect(combobox).toHaveAccessibleDescription('都道府県を選択してください');
    expect(screen.getByText('都道府県を選択してください')).toHaveAttribute('aria-live', 'polite');
  });

  it('呼び出し側の aria-describedby と案内を重複なく並べる', () => {
    render(
      <>
        <p id="prefecture-hint">配送先の都道府県</p>
        <SingleSelect
          variant="dropdown"
          name="prefecture"
          label="都道府県"
          options={PREFECTURES}
          value=""
          aria-describedby="prefecture-hint prefecture-error"
          errorText="都道府県を選択してください"
        />
      </>,
    );

    expect(screen.getByRole('combobox', { name: '都道府県' })).toHaveAttribute(
      'aria-describedby',
      'prefecture-hint prefecture-error',
    );
  });

  it('↓ で開き、選択中の項目から矢印で移り、Enter で選んで閉じる。フォーカスは引き金のまま', async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    render(<ControlledPrefecture onChange={onChange} initial="北海道" />);

    const combobox = screen.getByRole('combobox', { name: '都道府県' });
    combobox.focus();
    await user.keyboard('{ArrowDown}');

    expect(combobox).toHaveAttribute('aria-expanded', 'true');
    const listbox = await screen.findByRole('listbox');
    expect(combobox).toHaveAttribute('aria-controls', listbox.id);
    // 開いた直後は選択中の項目を指す
    const active = () => document.getElementById(combobox.getAttribute('aria-activedescendant') ?? '');
    expect(active()).toHaveTextContent('北海道');

    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(active()).toHaveTextContent('東京都');
    expect(active()).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('東京都');
    expect(combobox).toHaveAttribute('aria-expanded', 'false');
    expect(combobox).toHaveTextContent('東京都');
    expect(combobox).toHaveFocus();
  });

  it('Esc で選ばずに閉じる', async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    render(<ControlledPrefecture onChange={onChange} initial="北海道" />);

    const combobox = screen.getByRole('combobox', { name: '都道府県' });
    combobox.focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('listbox');
    await user.keyboard('{ArrowDown}{Escape}');

    expect(combobox).toHaveAttribute('aria-expanded', 'false');
    expect(onChange).not.toHaveBeenCalled();
    expect(combobox).toHaveTextContent('北海道');
  });

  it('Home・End で先頭・末尾へ移り、Tab で指している項目を選んで閉じる', async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    render(
      <>
        <ControlledPrefecture onChange={onChange} />
        <button type="button">次の欄</button>
      </>,
    );

    const combobox = screen.getByRole('combobox', { name: '都道府県' });
    combobox.focus();
    await user.keyboard('{End}');
    await screen.findByRole('listbox');
    expect(document.getElementById(combobox.getAttribute('aria-activedescendant') ?? '')).toHaveTextContent('東京都');

    await user.keyboard('{Home}');
    expect(document.getElementById(combobox.getAttribute('aria-activedescendant') ?? '')).toHaveTextContent('選択してください');

    await user.keyboard('{End}');
    await user.tab();
    expect(onChange).toHaveBeenCalledWith('東京都');
    expect(combobox).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: '次の欄' })).toHaveFocus();
  });

  it('マウスで項目を押しても選べる', async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    render(<ControlledPrefecture onChange={onChange} />);

    await user.click(screen.getByRole('combobox', { name: '都道府県' }));
    const listbox = await screen.findByRole('listbox');
    await user.click(within(listbox).getByRole('option', { name: '青森県' }));

    expect(onChange).toHaveBeenCalledWith('青森県');
    expect(screen.getByRole('combobox', { name: '都道府県' })).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('SingleSelect（native）の案内（FREQ-379）', () => {
  it('案内があると select が誤りの状態になり、説明として結びつく', () => {
    render(
      <SingleSelect
        name="size"
        label="サイズ"
        options={[{ value: 'M', label: 'M' }]}
        defaultValue="M"
        errorText="サイズを選択してください"
      />,
    );

    const select = screen.getByRole('combobox', { name: 'サイズ' });
    expect(select.tagName).toBe('SELECT');
    expect(select).toHaveAttribute('aria-invalid', 'true');
    expect(select).toHaveAccessibleDescription('サイズを選択してください');
  });
});
