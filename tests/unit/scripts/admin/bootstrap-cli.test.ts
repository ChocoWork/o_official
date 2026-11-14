import { runBootstrapCli, type CliIo } from '../../../../scripts/admin/bootstrap';
import type { BootstrapDeps } from '../../../../scripts/admin/bootstrap-core';

const PASSWORD = 'correct-horse-battery-1';

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
  test('refuses without email argument', async () => {
    const t = setup({ io: { argv: [] } });
    expect(await runBootstrapCli(t.io, t.makeDeps)).toBe(1);
    expect(t.readHidden).not.toHaveBeenCalled();
  });

  test('refuses without service role env', async () => {
    const t = setup({ io: { env: { NODE_ENV: 'test', SUPABASE_URL: 'http://127.0.0.1:54321' } } });
    expect(await runBootstrapCli(t.io, t.makeDeps)).toBe(1);
    expect(t.readHidden).not.toHaveBeenCalled();
  });

  test('prints target host', async () => {
    const t = setup({ io: { isTTY: false } });
    await runBootstrapCli(t.io, t.makeDeps);
    expect(t.lines.some((l) => l.includes('向ける先: 127.0.0.1'))).toBe(true);
  });

  test('refuses when stdin is not a TTY', async () => {
    const t = setup({ io: { isTTY: false } });
    expect(await runBootstrapCli(t.io, t.makeDeps)).toBe(1);
    expect(t.readHidden).not.toHaveBeenCalled();
  });

  test('does not prompt when an admin exists', async () => {
    const t = setup({ deps: { countActiveAdmins: async () => 1 } });
    expect(await runBootstrapCli(t.io, t.makeDeps)).toBe(1);
    expect(t.readHidden).not.toHaveBeenCalled();
  });

  test('creates admin and prints next step', async () => {
    const t = setup();
    expect(await runBootstrapCli(t.io, t.makeDeps)).toBe(0);
    const out = t.lines.join('\n');
    expect(out).toContain('new-user-id');
    expect(out).toContain('TOTP');
    expect(out).not.toContain(PASSWORD);
    expect(out).not.toContain('service-key-xyz');
  });

  test('warns when pwned check is unavailable', async () => {
    const t = setup({ deps: { checkPwned: async () => ({ status: 'unavailable', reason: 'timeout' }) } });
    expect(await runBootstrapCli(t.io, t.makeDeps)).toBe(0);
    expect(t.lines.some((l) => l.includes('警告'))).toBe(true);
  });

  test('prints failure message without password and returns 1', async () => {
    const t = setup({ passwords: [PASSWORD, 'different-password-123'] });
    expect(await runBootstrapCli(t.io, t.makeDeps)).toBe(1);
    expect(t.lines.join('\n')).not.toContain(PASSWORD);
  });

  test('catches a throw from the core without leaking its text', async () => {
    const t = setup({ deps: { audit: async () => { throw new Error('secret-detail ' + PASSWORD); } } });
    expect(await runBootstrapCli(t.io, t.makeDeps)).toBe(1);
    const out = t.lines.join('\n');
    expect(out).not.toContain('secret-detail');
    expect(out).not.toContain(PASSWORD);
    expect(out).toContain('すでに作られていないか');
  });
});
