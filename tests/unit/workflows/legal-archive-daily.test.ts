import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

it('defines the daily JST archive workflow contract', () => {
  // Windows のチェックアウトでは CRLF になるため、複数行にまたがる一致が
  // 落ちる。改行を正規化してから比較する。
  const yaml = readFileSync(resolve('.github/workflows/legal-archive-daily.yml'), 'utf8')
    .replace(/\r\n/g, '\n');
  expect(yaml).toContain("cron: '30 17 * * *'");
  expect(yaml).toContain('workflow_dispatch:');
  expect(yaml).toContain('permissions:\n  contents: read');
  expect(yaml).toContain('pg_dump --format=custom');
  expect(yaml).toContain('gzip -9');
  expect(yaml).toContain('npm run archive:legal:daily');
  expect(yaml).not.toContain('upload-artifact');
  expect(yaml).toContain('if: always()');
});
