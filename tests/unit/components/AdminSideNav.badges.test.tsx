import { fireEvent, render, screen, within } from '@testing-library/react';
import AdminSideNav from '@/components/AdminSideNav';

describe('AdminSideNav の未処理の件数', () => {
  it('件数があるタブは、ボタンの名前に件数を含める', () => {
    render(<AdminSideNav activeTab="KPI" onTabChange={jest.fn()} tabs={['KPI', 'ORDER']} badges={{ ORDER: 3 }} />);

    expect(screen.getByRole('button', { name: 'ORDER 未処理 3件' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'KPI' })).toBeInTheDocument();
  });

  it('FREQ-547-AC-01: DISCOUNT はCONTACTの直後のタブとして並び、押すと切り替わる', () => {
    const onTabChange = jest.fn();
    render(<AdminSideNav activeTab="CONTACT" onTabChange={onTabChange} tabs={['CONTACT', 'DISCOUNT', 'SETTINGS']} />);

    const nav = screen.getByRole('navigation', { name: '管理メニュー' });
    expect(within(nav).getAllByRole('button').map((button) => button.textContent)).toEqual(['CONTACT', 'DISCOUNT', 'SETTINGS']);
    fireEvent.click(screen.getByRole('button', { name: 'DISCOUNT' }));
    expect(onTabChange).toHaveBeenCalledWith('DISCOUNT');
  });

  it('0件なら件数を出さない', () => {
    render(<AdminSideNav activeTab="KPI" onTabChange={jest.fn()} tabs={['ORDER']} badges={{ ORDER: 0 }} />);

    expect(screen.getByRole('button', { name: 'ORDER' })).toBeInTheDocument();
  });
});
