import { render, screen } from '@testing-library/react';
import AdminSideNav from '@/components/AdminSideNav';

describe('AdminSideNav の未処理の件数', () => {
  it('件数があるタブは、ボタンの名前に件数を含める', () => {
    render(<AdminSideNav activeTab="KPI" onTabChange={jest.fn()} tabs={['KPI', 'ORDER']} badges={{ ORDER: 3 }} />);

    expect(screen.getByRole('button', { name: 'ORDER 未処理 3件' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'KPI' })).toBeInTheDocument();
  });

  it('0件なら件数を出さない', () => {
    render(<AdminSideNav activeTab="KPI" onTabChange={jest.fn()} tabs={['ORDER']} badges={{ ORDER: 0 }} />);

    expect(screen.getByRole('button', { name: 'ORDER' })).toBeInTheDocument();
  });
});
