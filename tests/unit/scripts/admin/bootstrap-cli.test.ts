import { runBootstrapCli, type CliIo } from '../../../../scripts/admin/bootstrap';
import type { BootstrapDeps } from '../../../../scripts/admin/bootstrap-core';

const PASSWORD = 'correct-horse-battery-1';

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn(() => ({})) }));
jest.mock('../../../../scripts/admin/bootstrap-deps', () => ({
  createBootstrapDeps: jest.fn(() => ({ countActiveAdmins: async () => 1 })),
}));

import { createClient } from '@supabase/supabase-js';

function setup(opts: { io?: Partial<CliIo>; deps?: Partial<BootstrapDeps>; passwords?: string[] } = {}) {
  const lines: string[] = [];
  const passwords = [...(opts.passwords ?? [PASSWORD, PASSWORD])];
  const readHidden = jest.fn(async () => passwords.shift() ?? '');
  const deps: BootstrapDeps = {
    countActiveAdmins: async () => 0,
    checkPwned: async () => ({ status: 'ok' }),
    createUser: async () => ({ kind: 'created', id: 'new-user-id' }),
    grantAdminRole: async () => {},
    deleteUser: async () => {},
    audit: async () => {},
    ...opts.deps,
  };
  const io: CliIo = {
    env: { NODE_ENV: 'test', SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_SERVICE_ROLE_KEY: 'service-key-xyz' },
    argv: ['--email', 'owner@example.com'],
    isTTY: true,
    readHidden,
    print: (l) => lines.push(l),
    ...opts.io,
  };
  const makeDeps = jest.fn(() => deps);
  return { io, lines, readHidden, makeDeps };
}

describe('runBootstrapCli', () => {
  test('DD-ADMIN-017 refuses without email argument', async () => {
    const t = setup({ io: { argv: [] } });
    expect(await runBootstrapCli(t.io, t.makeDeps)).toBe(1);
    expect(t.readHidden).not.toHaveBeenCalled();
  });

  test('DD-ADMIN-017 refuses without service role env', async () => {
    const t = setup({ io: { env: { NODE_ENV: 'test', SUPABASE_URL: 'http://127.0.0.1:54321' } } });
    expect(await runBootstrapCli(t.io, t.makeDeps)).toBe(1);
    expect(t.readHidden).not.toHaveBeenCalled();
  });

  test('DD-ADMIN-017 falls back to NEXT_PUBLIC_SUPABASE_URL', async () => {
    const t = setup({ io: { isTTY: false, env: { NODE_ENV: 'test', NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_SERVICE_ROLE_KEY: 'k' } } });
    await runBootstrapCli(t.io, t.makeDeps);
    expect(t.lines.some((l) => l.includes('向ける先: 127.0.0.1'))).toBe(true);
  });

  test('DD-ADMIN-017 builds the real deps from a service role client when none are given', async () => {
    const t = setup({ io: { argv: ['--email', 'owner@example.com'] } });
    const code = await runBootstrapCli(t.io);
    expect(createClient).toHaveBeenCalledWith('http://127.0.0.1:54321', 'service-key-xyz', expect.anything());
    expect(code).toBe(1);
    expect(t.lines.some((l) => l.includes('有効な店長がすでにいる'))).toBe(true);
  });

  test('DD-ADMIN-017 prints target host', async () => {
    const t = setup({ io: { isTTY: false } });
    await runBootstrapCli(t.io, t.makeDeps);
    expect(t.lines.some((l) => l.includes('向ける先: 127.0.0.1'))).toBe(true);
  });

  test('DD-ADMIN-017 refuses when stdin is not a TTY', async () => {
    const t = setup({ io: { isTTY: false } });
    expect(await runBootstrapCli(t.io, t.makeDeps)).toBe(1);
    expect(t.readHidden).not.toHaveBeenCalled();
  });

  test('DD-ADMIN-017 does not prompt when an admin exists', async () => {
    const t = setup({ deps: { countActiveAdmins: async () => 1 } });
    expect(await runBootstrapCli(t.io, t.makeDeps)).toBe(1);
    expect(t.readHidden).not.toHaveBeenCalled();
  });

  test('DD-ADMIN-017 creates admin and prints next step', async () => {
    const t = setup();
    expect(await runBootstrapCli(t.io, t.makeDeps)).toBe(0);
    const out = t.lines.join('\n');
    expect(out).toContain('new-user-id');
    expect(out).toContain('TOTP');
    expect(out).not.toContain(PASSWORD);
    expect(out).not.toContain('service-key-xyz');
  });

  test('DD-ADMIN-017 warns when pwned check is unavailable', async () => {
    const t = setup({ deps: { checkPwned: async () => ({ status: 'unavailable', reason: 'timeout' }) } });
    expect(await runBootstrapCli(t.io, t.makeDeps)).toBe(0);
    expect(t.lines.some((l) => l.includes('警告'))).toBe(true);
  });

  test('DD-ADMIN-017 prints failure message without password and returns 1', async () => {
    const t = setup({ passwords: [PASSWORD, 'different-password-123'] });
    expect(await runBootstrapCli(t.io, t.makeDeps)).toBe(1);
    expect(t.lines.join('\n')).not.toContain(PASSWORD);
  });

  test('DD-ADMIN-017 catches a throw from the core without leaking its text', async () => {
    const t = setup({ deps: { audit: async () => { throw new Error('secret-detail ' + PASSWORD); } } });
    expect(await runBootstrapCli(t.io, t.makeDeps)).toBe(1);
    const out = t.lines.join('\n');
    expect(out).not.toContain('secret-detail');
    expect(out).not.toContain(PASSWORD);
    expect(out).toContain('すでに作られていないか');
  });
});
