/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });

import type { SupabaseClient } from '@supabase/supabase-js';
import { ROLE_PERMISSION_CATALOG } from '@/lib/auth/role-permission-catalog';
import { getPermissionsMatrix, setRolePermissions, setUserRole, RolePermissionStoreError } from '@/lib/auth/role-permission-store';
import type { RolePermissionChange } from '@/lib/auth/role-permission-types';

const rpc = jest.fn();
const client = { rpc } as unknown as SupabaseClient;
const codes = ROLE_PERMISSION_CATALOG.map((p) => p.code).sort();
const role = { code: 'supporter', version: '9223372036854775807', permissionCodes: ['admin.shipping.manage'] };
const matrix = () => ({ permissionCodes: codes, roles: [{ code: 'admin', version: '0', permissionCodes: codes }, role] });
const change: RolePermissionChange = { roleCode: 'supporter', permissionCodes: ['admin.shipping.manage'], expectedVersion: '9007199254740993', requestKey: '10000000-0000-4000-8000-000000000001' };
beforeEach(() => rpc.mockReset());

test('GETは認可actorだけをRPCへ渡し、表示定義と役割名を付け、bigint精度を保つ', async () => {
  rpc.mockResolvedValue({ data: matrix(), error: null });
  const result = await getPermissionsMatrix(client, 'actor');
  expect(rpc).toHaveBeenCalledWith('admin_get_permissions', { _actor_id: 'actor' });
  expect(result).toEqual({ permissions: ROLE_PERMISSION_CATALOG, roles: [
    { code: 'admin', label: '店長', version: '0', permissionCodes: codes }, { ...role, label: 'サポーター' },
  ] });
});

test('保存はsnake_case契約の全引数を渡し、依存不足を補わず結果を表示型へ変換する', async () => {
  rpc.mockResolvedValue({ data: { role, changedCount: 1 }, error: null });
  expect(await setRolePermissions(client, 'actor', change)).toEqual({ role: { ...role, label: 'サポーター' }, changedCount: 1 });
  expect(rpc).toHaveBeenCalledWith('admin_set_role_permissions', {
    _actor_id: 'actor', _role_code: 'supporter', _permission_codes: ['admin.shipping.manage'],
    _expected_version: '9007199254740993', _request_key: change.requestKey,
  });
});

test.each(['admin', 'supporter', 'user'] as const)('役割%sの変更もpublic RPC1回だけ', async (next) => {
  rpc.mockResolvedValue({ data: { previousRole: 'unknown', role: next }, error: null });
  expect(await setUserRole(client, 'actor', 'target', next)).toEqual({ previousRole: 'unknown', role: next });
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(rpc).toHaveBeenCalledWith('admin_set_user_role', { _actor_id: 'actor', _user_id: 'target', _role_code: next });
});

test.each([
  ['ROLE_PERMISSION_ARGUMENT_INVALID', '22023'], ['ROLE_PERMISSION_FORBIDDEN', '42501'],
  ['ROLE_PERMISSION_FIXED', '42501'], ['ROLE_PERMISSION_VERSION_CONFLICT', 'P0001'],
  ['ROLE_PERMISSION_REQUEST_KEY_CONFLICT', 'P0001'], ['LAST_ADMIN_REQUIRED', 'P0001'],
  ['SELF_ROLE_CHANGE_FORBIDDEN', '42501'], ['USER_NOT_FOUND', 'P0002'],
])('全文とSQLSTATEが一致した%sだけを業務拒否へ変換', async (message, code) => {
  rpc.mockResolvedValue({ data: null, error: { message, code, details: 'PRIVATE', hint: 'PRIVATE' } });
  await expect(setRolePermissions(client, 'actor', change)).rejects.toMatchObject({ code: message });
});

test.each([
  { message: 'ROLE_PERMISSION_FIXED', code: 'P0001' },
  { message: 'OTHER', code: '42501' },
  { message: 'prefix ROLE_PERMISSION_FIXED', code: '42501' },
  { message: 'ROLE_PERMISSION_FIXED suffix', code: '42501' },
  { message: 'ROLE_PERMISSION_FIXED\n', code: '42501' },
  { message: 'ROLE_PERMISSION_FIXED', code: null },
])('未知のエラー組%jを漏らさず内部失敗にする', async (error) => {
  rpc.mockResolvedValue({ data: null, error: { ...error, details: 'PRIVATE', hint: 'PRIVATE' } });
  const failure = await setRolePermissions(client, 'actor', change).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(RolePermissionStoreError);
  expect(failure).toMatchObject({ code: null, message: 'Role permission operation failed' });
  expect(JSON.stringify(failure)).not.toContain('PRIVATE');
});

test.each([
  null,
  { ...matrix(), permissionCodes: [...codes, 'other.permission'] },
  { ...matrix(), permissionCodes: codes.slice(1) },
  { ...matrix(), roles: [{ ...role, permissionCodes: ['other.permission'] }] },
  { ...matrix(), roles: [role, role] },
  { ...matrix(), roles: [{ ...role, code: 'user' }] },
  { ...matrix(), roles: [{ code: 'admin', version: '01', permissionCodes: [] }, role] },
  { ...matrix(), roles: [{ code: 'admin', version: '1\n', permissionCodes: [] }, role] },
  { ...matrix(), roles: [{ code: 'admin', version: 1, permissionCodes: [] }, role] },
])('不正なGET戻り値%jは30コード外を返さず失敗', async (data) => {
  rpc.mockResolvedValue({ data, error: null });
  await expect(getPermissionsMatrix(client, 'actor')).rejects.toMatchObject({ code: null });
});

test.each([
  null,
  { role: { ...role, permissionCodes: ['other.permission'] }, changedCount: 1 },
  { role: { ...role, permissionCodes: ['admin.users.read', 'admin.users.read'] }, changedCount: 1 },
  { role: { ...role, code: 'admin' }, changedCount: 1 },
  { role: { ...role, version: '9223372036854775808' }, changedCount: 1 },
  { role, changedCount: -1 }, { role, changedCount: 0.5 }, { role, changedCount: 31 },
])('不正な保存戻り値%jは内部失敗', async (data) => {
  rpc.mockResolvedValue({ data, error: null });
  await expect(setRolePermissions(client, 'actor', change)).rejects.toMatchObject({ code: null });
});

test.each([null, { previousRole: 1, role: 'user' }, { previousRole: 'admin', role: 'other' }, { previousRole: 'admin', role: 'admin' }])('不正な役割変更戻り値%jは内部失敗', async (data) => {
  rpc.mockResolvedValue({ data, error: null });
  await expect(setUserRole(client, 'actor', 'target', 'user')).rejects.toMatchObject({ code: null });
});

test('通信例外にも生のmessage/causeを付けない', async () => {
  rpc.mockRejectedValue(new Error('PRIVATE'));
  await expect(getPermissionsMatrix(client, 'actor')).rejects.toMatchObject({ code: null, message: 'Role permission operation failed' });
});

test('DBに余分な内部フィールドがあっても許した表示フィールドだけを返す', async () => {
  rpc.mockResolvedValue({ data: { ...matrix(), privateField: 'PRIVATE', roles: matrix().roles.map((r) => ({ ...r, privateField: 'PRIVATE' })) }, error: null });
  expect(JSON.stringify(await getPermissionsMatrix(client, 'actor'))).not.toContain('PRIVATE');
  rpc.mockResolvedValue({ data: { role: { ...role, privateField: 'PRIVATE' }, changedCount: 0, privateField: 'PRIVATE' }, error: null });
  expect(JSON.stringify(await setRolePermissions(client, 'actor', change))).not.toContain('PRIVATE');
});
