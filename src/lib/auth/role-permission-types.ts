import type { PermissionCode } from '@/lib/auth/admin-rbac';

export type PermissionRole = 'admin' | 'supporter';

export type PermissionRoleState = {
  code: PermissionRole;
  label: string;
  version: string;
  permissionCodes: PermissionCode[];
};

export type PermissionDefinition = {
  code: PermissionCode;
  area: string;
  label: string;
  requires: PermissionCode[];
  fixed: boolean;
  upcoming: boolean;
};

export type PermissionsMatrix = {
  permissions: PermissionDefinition[];
  roles: PermissionRoleState[];
};

export type RolePermissionChange = {
  roleCode: PermissionRole;
  permissionCodes: PermissionCode[];
  expectedVersion: string;
  requestKey: string;
};

export type RolePermissionChangeResult = {
  role: PermissionRoleState;
  changedCount: number;
};
