/** @jest-environment node */
import type { SupabaseClient } from '@supabase/supabase-js';
import { createBootstrapDeps } from '../../../../scripts/admin/bootstrap-deps';

jest.mock('@/lib/audit', () => ({ logAudit: jest.fn() }));
jest.mock('@/lib/pwned-password', () => ({ checkPwnedPassword: jest.fn() }));

type Result = { data?: unknown; error?: unknown; count?: number | null };

/** どの鎖の呼び出しも自分を返し、await した時点で表ごとに決めた結果を返す。 */
function fakeClient(opts: {
  roles?: Result;
  userRolesCount?: Result;
  userRolesUpdate?: Result;
  userRolesUpsert?: Result;
  createUser?: { data?: unknown; error?: unknown };
  deleteUser?: { error?: unknown };
}) {
  const upsert = jest.fn(async () => opts.userRolesUpsert ?? { error: null });
  const builder = (kind: 'roles' | 'user_roles') => {
    let mode: 'select' | 'update' = 'select';
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = jest.fn(self);
    chain.eq = jest.fn(self);
    chain.or = jest.fn(self);
    chain.update = jest.fn(() => {
      mode = 'update';
      return chain;
    });
    chain.upsert = upsert;
    chain.single = jest.fn(async () => opts.roles ?? { data: { id: 'role-admin' }, error: null });
    chain.then = (resolve: (v: Result) => unknown) =>
      resolve(
        kind === 'user_roles' && mode === 'update'
          ? (opts.userRolesUpdate ?? { error: null })
          : (opts.userRolesCount ?? { count: 0, error: null }),
      );
    return chain;
  };
  const client = {
    from: jest.fn((table: 'roles' | 'user_roles') => builder(table)),
    auth: {
      admin: {
        createUser: jest.fn(async () => opts.createUser ?? { data: { user: { id: 'u1' } }, error: null }),
        deleteUser: jest.fn(async () => opts.deleteUser ?? { error: null }),
      },
    },
  };
  return { client: client as unknown as SupabaseClient, upsert, raw: client };
}

describe('createBootstrapDeps', () => {
  test('DD-ADMIN-018 counts active admins', async () => {
    const { client } = fakeClient({ userRolesCount: { count: 2, error: null } });
    await expect(createBootstrapDeps(client).countActiveAdmins()).resolves.toBe(2);
  });

  test('DD-ADMIN-018 counts zero when count is null', async () => {
    const { client } = fakeClient({ userRolesCount: { count: null, error: null } });
    await expect(createBootstrapDeps(client).countActiveAdmins()).resolves.toBe(0);
  });

  test('DD-ADMIN-018 throws when counting fails', async () => {
    const { client } = fakeClient({ userRolesCount: { count: null, error: { message: 'x' } } });
    await expect(createBootstrapDeps(client).countActiveAdmins()).rejects.toThrow('count active admins failed');
  });

  test('DD-ADMIN-018 creates a confirmed admin user', async () => {
    const { client, raw } = fakeClient({});
    const result = await createBootstrapDeps(client).createUser({ email: 'a@example.com', password: 'p', displayName: 'N' });
    expect(result).toEqual({ kind: 'created', id: 'u1' });
    expect(raw.auth.admin.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ email_confirm: true, app_metadata: { role: 'admin' } }),
    );
  });

  test('DD-ADMIN-018 reports exists by code', async () => {
    const { client } = fakeClient({ createUser: { data: null, error: { code: 'email_exists', message: 'm', status: 422 } } });
    await expect(createBootstrapDeps(client).createUser({ email: 'a@example.com', password: 'p' })).resolves.toEqual({ kind: 'exists' });
  });

  test('DD-ADMIN-018 reports exists by message', async () => {
    const { client } = fakeClient({ createUser: { data: null, error: { message: 'User already registered' } } });
    await expect(createBootstrapDeps(client).createUser({ email: 'a@example.com', password: 'p' })).resolves.toEqual({ kind: 'exists' });
  });

  test('DD-ADMIN-018 returns only status and code on failure', async () => {
    const { client } = fakeClient({ createUser: { data: null, error: { code: 'unexpected', message: 'leak a@example.com', status: 500 } } });
    const result = await createBootstrapDeps(client).createUser({ email: 'a@example.com', password: 'p' });
    expect(result).toEqual({ kind: 'failed', status: 500, code: 'unexpected' });
  });

  test('DD-ADMIN-018 fails when no user comes back and there is no error', async () => {
    const { client } = fakeClient({ createUser: { data: { user: null }, error: null } });
    const result = await createBootstrapDeps(client).createUser({ email: 'a@example.com', password: 'p' });
    expect(result).toEqual({ kind: 'failed', status: undefined, code: undefined });
  });

  test('DD-ADMIN-018 fails when the response has no data at all', async () => {
    const { client } = fakeClient({ createUser: { data: null, error: null } });
    const result = await createBootstrapDeps(client).createUser({ email: 'a@example.com', password: 'p' });
    expect(result).toMatchObject({ kind: 'failed' });
  });

  test('DD-ADMIN-018 grants the admin role', async () => {
    const { client, upsert } = fakeClient({});
    await createBootstrapDeps(client).grantAdminRole('u1');
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'u1', role_id: 'role-admin', active: true, expires_at: null }),
      { onConflict: 'user_id,role_id' },
    );
  });

  test('DD-ADMIN-018 throws when the admin role is missing', async () => {
    const { client } = fakeClient({ roles: { data: null, error: { message: 'x' } } });
    await expect(createBootstrapDeps(client).grantAdminRole('u1')).rejects.toThrow('admin role not found');
  });

  test('DD-ADMIN-018 throws when deactivating roles fails', async () => {
    const { client } = fakeClient({ userRolesUpdate: { error: { message: 'x' } } });
    await expect(createBootstrapDeps(client).grantAdminRole('u1')).rejects.toThrow('deactivate roles failed');
  });

  test('DD-ADMIN-018 throws when upserting the role fails', async () => {
    const { client } = fakeClient({ userRolesUpsert: { error: { message: 'x' } } });
    await expect(createBootstrapDeps(client).grantAdminRole('u1')).rejects.toThrow('grant admin role failed');
  });

  test('DD-ADMIN-018 deletes a user', async () => {
    const { client, raw } = fakeClient({});
    await createBootstrapDeps(client).deleteUser('u1');
    expect(raw.auth.admin.deleteUser).toHaveBeenCalledWith('u1');
  });

  test('DD-ADMIN-018 throws when deleting fails', async () => {
    const { client } = fakeClient({ deleteUser: { error: { message: 'x' } } });
    await expect(createBootstrapDeps(client).deleteUser('u1')).rejects.toThrow('delete user failed');
  });
});
