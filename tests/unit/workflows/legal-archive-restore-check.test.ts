import { readFileSync } from 'node:fs';

it('defines isolated monthly restore verification', () => {
  const yaml = readFileSync('.github/workflows/legal-archive-restore-check.yml', 'utf8');
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
