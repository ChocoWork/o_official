import { render, screen } from '@testing-library/react';
import Page from '@/app/admin/settings/permissions/page';
import { clientFetch } from '@/lib/client-fetch';
import { ROLE_PERMISSION_CATALOG } from '@/lib/auth/role-permission-catalog';
import type { PermissionsMatrix } from '@/lib/auth/role-permission-types';

jest.mock('@/lib/client-fetch', () => ({ clientFetch: jest.fn() }));
const fetchMock = jest.mocked(clientFetch);

beforeEach(() => fetchMock.mockReset());

test('直URLで GET が403なら表を出さず、管理画面へ戻れる', async () => {
  fetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: 'raw error' }) } as Response);
  render(<Page />);
  expect(await screen.findByRole('alert')).toHaveTextContent('アクセス権限がありません');
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: '管理画面に戻る' })).toHaveAttribute('href', '/admin?tab=SETTINGS');
  expect(fetchMock).toHaveBeenCalledWith('/api/admin/permissions', { cache: 'no-store' });
});

test('固定2コード以外を全解除した店長もGET成功でこの画面と戻るリンクを使える', async () => {
  const data: PermissionsMatrix = {
    permissions: [...ROLE_PERMISSION_CATALOG],
    roles: [
      { code: 'admin', label: '店長', version: '21', permissionCodes: ['admin.users.manage', 'admin.permissions.manage'] },
      { code: 'supporter', label: 'サポーター', version: '3', permissionCodes: [] },
    ],
  };
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data }) } as Response);
  render(<Page />);
  expect(await screen.findByRole('table')).toBeVisible();
  expect(screen.getByRole('heading', { level: 1, name: '権限' })).toBeVisible();
  expect(screen.getByRole('switch', { name: '店長：荷作り・発送票閲覧' })).not.toBeChecked();
  expect(screen.getByRole('link', { name: '管理画面に戻る' })).toHaveAttribute('href', '/admin?tab=SETTINGS');
});
