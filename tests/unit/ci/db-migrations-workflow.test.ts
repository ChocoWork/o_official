/**
 * 移行の本番適用を push で動かさず、手動だけにする（パスキー段1a Task 1）。
 * `supabase db push` は未適用の移行を全部流すので、段3まで自動では動かさない。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const workflow = readFileSync(
  join(process.cwd(), '.github', 'workflows', 'db-migrations.yml'),
  'utf8',
);

/** `on:` から `permissions:` の手前までを取り出す。 */
function onBlock(): string {
  const start = workflow.indexOf('\non:');
  const end = workflow.indexOf('\npermissions:');
  return workflow.slice(start, end);
}

/** job の本文（次の job か末尾まで）を取り出す。 */
function jobBlock(name: string): string {
  const start = workflow.indexOf(`\n  ${name}:`);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z_-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe('db-migrations workflow', () => {
  it('on: に push: が無い', () => {
    expect(onBlock()).not.toMatch(/^ {2}push:/m);
  });

  it('workflow_dispatch と pull_request は残る', () => {
    expect(onBlock()).toMatch(/^ {2}workflow_dispatch:/m);
    expect(onBlock()).toMatch(/^ {2}pull_request:/m);
  });

  it('pull_request の job は db push --dry-run だけ', () => {
    const plan = jobBlock('plan');
    expect(plan).toContain("github.event_name == 'pull_request'");
    expect(plan).toContain('supabase db push --dry-run');
    expect(plan).not.toMatch(/supabase db push\s*$/m);
  });

  it('実適用の deploy は workflow_dispatch の時だけ動く', () => {
    const deploy = jobBlock('deploy');
    expect(deploy).toMatch(/if:\s*github\.event_name == 'workflow_dispatch'/);
    expect(deploy).not.toContain("!= 'pull_request'");
    expect(deploy).toMatch(/supabase db push\s*$/m);
  });
});
