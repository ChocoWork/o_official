import { readFileSync } from 'node:fs';

// TODO(法令対応): 対象のワークフローは 2026-08-31 に削除済みのため保留中。
// 法令対応（電子帳簿保存法まわりの証憑アーカイブと復元検査）はシステム完成後に
// まとめて着手する方針。ワークフローを復活させたら it.skip を it に戻すこと。
// アサーションは復活時の仕様書として意図的に残している。
it.skip('defines isolated monthly restore verification', () => {
  // Windows のチェックアウトでは CRLF になるため、複数行にまたがる一致が
  // 落ちる。改行を正規化してから比較する。
  const yaml = readFileSync('.github/workflows/legal-archive-restore-check.yml', 'utf8')
    .replace(/\r\n/g, '\n');
  expect(yaml).toContain("cron: '0 18 1 * *'");
  expect(yaml).toContain('workflow_dispatch:');
  expect(yaml).toContain('services:\n      postgres:');
  expect(yaml).toContain('$RUNNER_TEMP');
  expect(yaml).toContain('pg_restore --exit-on-error');
  expect(yaml).toContain('npm run archive:legal:verify-restore');
  expect(yaml).toContain('if: failure()');
  expect(yaml).toContain('/api/cron/legal-archive/status');
  expect(yaml).toContain('if: always()');
  expect(yaml).not.toContain('ports:');
});
