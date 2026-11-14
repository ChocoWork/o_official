import { bootstrapFirstAdmin, type BootstrapDeps, type BootstrapInput } from '../../../../scripts/admin/bootstrap-core';
import type { AuditEvent } from '@/lib/audit';

const PASSWORD = 'correct-horse-battery-1';

function makeDeps(overrides: Partial<BootstrapDeps> = {}) {
  const calls: Array<[string, unknown]> = [];
  const audits: AuditEvent[] = [];
  const deps: BootstrapDeps = {
    countActiveAdmins: async () => {
      calls.push(['countActiveAdmins', undefined]);
      return 0;
    },
    checkPwned: async (p) => {
      calls.push(['checkPwned', p]);
      return { status: 'ok' };
    },
    createUser: async (a) => {
      calls.push(['createUser', a]);
      return { kind: 'created', id: 'u1' };
    },
    grantAdminRole: async (id) => {
      calls.push(['grantAdminRole', id]);
    },
    deleteUser: async (id) => {
      calls.push(['deleteUser', id]);
    },
    audit: async (e) => {
      calls.push(['audit', e]);
      audits.push(e);
    },
    ...overrides,
  };
  const called = (name: string) => calls.filter(([n]) => n === name);
  return { deps, calls, audits, called };
}

const input = (o: Partial<BootstrapInput> = {}): BootstrapInput => ({
  email: 'owner@example.com',
  password: PASSWORD,
  passwordConfirmation: PASSWORD,
  ...o,
});

describe('bootstrapFirstAdmin', () => {
  it('creates admin when no admin exists', async () => {
    const t = makeDeps();
    const r = await bootstrapFirstAdmin(input(), t.deps);
    expect(r).toEqual({ ok: true, userId: 'u1', email: 'owner@example.com', pwnedCheck: 'ok' });
    expect(t.called('grantAdminRole')[0][1]).toBe('u1');
    expect(t.audits).toHaveLength(1);
    expect(t.audits[0]).toMatchObject({
      action: 'admin_bootstrap',
      actor_id: null,
      actor_email: null,
      resource: 'users',
      resource_id: 'u1',
      outcome: 'success',
    });
  });

  it('normalizes email before creating', async () => {
    const t = makeDeps();
    await bootstrapFirstAdmin(input({ email: '  Owner@Example.COM ' }), t.deps);
    expect((t.called('createUser')[0][1] as { email: string }).email).toBe('owner@example.com');
  });

  it('refuses when an admin exists', async () => {
    const t = makeDeps({ countActiveAdmins: async () => 1 });
    const r = await bootstrapFirstAdmin(input(), t.deps);
    expect(r).toMatchObject({ ok: false, reason: 'admin_exists' });
    expect(t.called('checkPwned')).toHaveLength(0);
    expect(t.called('createUser')).toHaveLength(0);
    expect(t.called('audit')).toHaveLength(0);
  });

  it('rejects mismatched confirmation', async () => {
    const t = makeDeps();
    const r = await bootstrapFirstAdmin(input({ passwordConfirmation: 'different-password-123' }), t.deps);
    expect(r).toMatchObject({ ok: false, reason: 'password_mismatch' });
    expect(t.called('countActiveAdmins')).toHaveLength(0);
  });

  it('rejects short password', async () => {
    const t = makeDeps();
    const p = 'a'.repeat(15);
    const r = await bootstrapFirstAdmin(input({ password: p, passwordConfirmation: p }), t.deps);
    expect(r).toMatchObject({ ok: false, reason: 'invalid_password', message: 'パスワードは16文字以上で入力してください' });
  });

  it('rejects password over 72 bytes', async () => {
    const t = makeDeps();
    const p = 'あ'.repeat(25);
    const r = await bootstrapFirstAdmin(input({ password: p, passwordConfirmation: p }), t.deps);
    expect(r).toMatchObject({ ok: false, reason: 'invalid_password' });
  });

  it('rejects pwned password', async () => {
    const t = makeDeps({ checkPwned: async () => ({ status: 'pwned', count: 3 }) });
    const r = await bootstrapFirstAdmin(input(), t.deps);
    expect(r).toMatchObject({ ok: false, reason: 'pwned_password' });
    expect(t.called('createUser')).toHaveLength(0);
  });

  it('continues when pwned check is unavailable', async () => {
    const t = makeDeps({ checkPwned: async () => ({ status: 'unavailable', reason: 'timeout' }) });
    const r = await bootstrapFirstAdmin(input(), t.deps);
    expect(r).toMatchObject({ ok: true, pwnedCheck: 'unavailable' });
    expect(t.audits).toHaveLength(2);
    expect(t.audits[0]).toMatchObject({ outcome: 'error', detail: 'pwned_check_unavailable:timeout' });
    expect(t.audits[1]).toMatchObject({ outcome: 'success' });
  });

  it('refuses existing email', async () => {
    const t = makeDeps({ createUser: async () => ({ kind: 'exists' }) });
    const r = await bootstrapFirstAdmin(input(), t.deps);
    expect(r).toMatchObject({ ok: false, reason: 'email_taken' });
    expect(t.called('grantAdminRole')).toHaveLength(0);
  });

  it('reports create failure without auth message', async () => {
    const t = makeDeps({ createUser: async () => ({ kind: 'failed', status: 500, code: 'unexpected_failure' }) });
    const r = await bootstrapFirstAdmin(input(), t.deps);
    expect(r).toMatchObject({ ok: false, reason: 'create_failed' });
    if (!r.ok) {
      expect(r.message).toContain('500');
      expect(r.message).toContain('unexpected_failure');
    }
  });

  it('deletes created user when granting fails', async () => {
    const t = makeDeps({
      grantAdminRole: async () => {
        throw new Error('boom');
      },
    });
    const r = await bootstrapFirstAdmin(input(), t.deps);
    expect(r).toMatchObject({ ok: false, reason: 'grant_failed' });
    expect(t.called('deleteUser')[0][1]).toBe('u1');
    expect(t.audits).toContainEqual(expect.objectContaining({ outcome: 'failure', detail: 'grant_failed', resource_id: 'u1', metadata: { cleanup: 'deleted' } }));
    if (!r.ok) expect(r.message).toContain('消しました');
  });

  it('still reports grant_failed when deleteUser also throws', async () => {
    const t = makeDeps({
      grantAdminRole: async () => {
        throw new Error('boom');
      },
      deleteUser: async () => {
        throw new Error('boom2');
      },
    });
    const r = await bootstrapFirstAdmin(input(), t.deps);
    expect(r).toMatchObject({ ok: false, reason: 'grant_failed' });
    expect(t.audits).toContainEqual(expect.objectContaining({ outcome: 'failure', detail: 'grant_failed', metadata: { cleanup: 'delete_failed' } }));
    if (!r.ok) {
      expect(r.message).toContain('u1');
      expect(r.message).toContain('手で消して');
      expect(r.message).not.toContain('owner@example.com');
      expect(r.message).not.toContain('消しました');
    }
  });

  it('never passes password to audit', async () => {
    const scenarios: Array<Partial<BootstrapDeps>> = [
      {},
      { checkPwned: async () => ({ status: 'unavailable', reason: 'timeout' }) },
      {
        grantAdminRole: async () => {
          throw new Error(`failed ${PASSWORD}`);
        },
      },
      { createUser: async () => ({ kind: 'failed', status: 500, code: 'x' }) },
    ];
    for (const s of scenarios) {
      const t = makeDeps(s);
      await bootstrapFirstAdmin(input(), t.deps);
      expect(JSON.stringify(t.audits)).not.toContain(PASSWORD);
    }
  });
});
