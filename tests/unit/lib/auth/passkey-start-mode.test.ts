/** @jest-environment node */
/**
 * DD-AUTH-051 パスキーのログインの始めの設定（src/lib/auth/passkey-start-mode.ts）の単体テスト。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolvePasskeyStartMode } from '@/lib/auth/passkey-start-mode';

describe('DD-AUTH-051 resolvePasskeyStartMode', () => {
  test.each([
    ['server', 'server'],
    ['browser', 'browser'],
    [' BROWSER ', 'browser'],
    ['Browser\n', 'browser'],
    ['', 'server'],
    ['   ', 'server'],
    ['foo', 'server'],
    [undefined, 'server'],
  ])('DD-AUTH-051 %p は %p', (value, expected) => {
    expect(resolvePasskeyStartMode({ NEXT_PUBLIC_PASSKEY_START_MODE: value })).toBe(expected);
  });

  test('DD-AUTH-051 環境を渡さなければ process.env を読む', () => {
    const before = process.env.NEXT_PUBLIC_PASSKEY_START_MODE;
    try {
      process.env.NEXT_PUBLIC_PASSKEY_START_MODE = 'browser';
      expect(resolvePasskeyStartMode()).toBe('browser');
    } finally {
      if (before === undefined) delete process.env.NEXT_PUBLIC_PASSKEY_START_MODE;
      else process.env.NEXT_PUBLIC_PASSKEY_START_MODE = before;
    }
  });

  test('DD-AUTH-051 ブラウザも読むので、ファイルに import が1つも無い', () => {
    const source = readFileSync(resolve(__dirname, '../../../../src/lib/auth/passkey-start-mode.ts'), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\(/);
    expect(source).not.toMatch(/\bimport\(/);
  });
});
