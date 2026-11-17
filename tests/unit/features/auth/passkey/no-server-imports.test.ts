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
      const specifiers = [...code.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
      for (const specifier of specifiers) {
        expect(specifier).not.toMatch(/^@\/lib\/auth\/passkey-(gotrue|start-config)$|^server-only$|^node:/);
      }
    },
  );
});
