/** @jest-environment node */
/**
 * DD-AUTH-060 画面の部品（src/features/auth/passkey/**）がサーバー専用の部品を import していないことを、ファイルの文字列を読んで確かめる。
 * `passkey-gotrue` は `server-only` を付けているため、ブラウザの束に入るとビルドが落ちる。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(process.cwd(), 'src', 'features', 'auth', 'passkey');

function listSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return listSources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

/** import・再エクスポート・動的 import・require の行き先を集める。 */
export function collectSpecifiers(code: string): string[] {
  return [...code.matchAll(/(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
}

/** サーバー専用の行き先か。別名（@/）・相対パス・拡張子つきも、最後の部分の名前で見分ける。 */
export function isServerOnlySpecifier(specifier: string): boolean {
  return /(^|\/)passkey-(gotrue|start-config)(\.[cm]?[jt]sx?)?$/.test(specifier) || specifier === 'server-only' || specifier.startsWith('node:');
}

describe('DD-AUTH-060 守りの検出が効く', () => {
  test.each([
    ["import x from '@/lib/auth/passkey-gotrue';"],
    ["import x from '../../../lib/auth/passkey-gotrue';"],
    ["import x from '@/lib/auth/passkey-gotrue.ts';"],
    ["const x = require('@/lib/auth/passkey-start-config');"],
    ["export * from '@/lib/auth/passkey-start-config';"],
    ["await import('@/lib/auth/passkey-gotrue');"],
    ["import 'server-only';"],
    ["import fs from 'node:fs';"],
  ])('DD-AUTH-060 %s を見つける', (code) => {
    expect(collectSpecifiers(code).some(isServerOnlySpecifier)).toBe(true);
  });

  test('DD-AUTH-060 画面の部品どうしの import は見つけない', () => {
    expect(collectSpecifiers("import x from '@/features/auth/passkey/browser-start';").some(isServerOnlySpecifier)).toBe(false);
  });
});

describe('DD-AUTH-060 画面の部品はサーバー専用の部品を読まない', () => {
  const files = listSources(ROOT);

  test('DD-AUTH-060 対象のファイルが1つ以上ある', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test.each(files.map((file) => [file.slice(ROOT.length + 1), file]))(
    'DD-AUTH-060 %s は passkey-gotrue・passkey-start-config・server-only を読まない',
    (_name, file) => {
      // コメントに名前が出てもよいので、import の行き先だけを集める。
      const code = readFileSync(file, 'utf8');
      expect(collectSpecifiers(code).filter(isServerOnlySpecifier)).toEqual([]);
    },
  );
});
