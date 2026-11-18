/**
 * @jest-environment jsdom
 */
/**
 * DD-AUTH-082 管理画面のサイドナビの入口「パスキー」（/admin/passkeys へのリンク）。店員の2つの役割（管理者・サポーター）の両方に出る。
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import AdminSideNav from '@/components/AdminSideNav';

describe('DD-AUTH-082 AdminSideNav のパスキーの入口', () => {
  test.each([
    ['管理者', ['KPI', 'USER'] as const],
    ['サポーター', ['ORDER', 'CONTACT'] as const],
  ])('DD-AUTH-082 %s にも「パスキー」のリンクが /admin/passkeys へ出る', (_role, tabs) => {
    render(<AdminSideNav activeTab={tabs[0]} onTabChange={() => undefined} tabs={[...tabs]} />);
    expect(screen.getByRole('link', { name: 'パスキー' })).toHaveAttribute('href', '/admin/passkeys');
  });

  test('DD-AUTH-082 タブが空（店員でない）なら、入口も出さない', () => {
    render(<AdminSideNav activeTab="KPI" onTabChange={() => undefined} tabs={[]} />);
    expect(screen.queryByRole('link', { name: 'パスキー' })).not.toBeInTheDocument();
  });
});
