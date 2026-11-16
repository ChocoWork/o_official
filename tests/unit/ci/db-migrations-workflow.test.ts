/**
 * 移行の本番適用を push で動かさず、手動だけにする（パスキー段1a Task 1）。
 * `supabase db push` は未適用の移行を全部流すので、段3まで自動では動かさない。
 * YAML として読むので、引用符付きのキーや job の足し方では抜けられない。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// js-yaml には型の宣言が無い（@types を足さない）ので、必要な形だけ書いて読み込む。
const { load } = require('js-yaml') as { load: (text: string) => unknown };

type Step = { run?: string };
type Job = { if?: string; steps?: Step[] };
type Workflow = { on?: Record<string, unknown>; true?: Record<string, unknown>; jobs: Record<string, Job> };

const doc = load(
  readFileSync(join(process.cwd(), '.github', 'workflows', 'db-migrations.yml'), 'utf8'),
) as Workflow;

// YAML 1.1 では `on` が真偽値 true になる版もあるので両方見る。
const triggers = (doc.on ?? doc.true ?? {}) as Record<string, unknown>;

const runsRealDbPush = (job: Job) =>
  (job.steps ?? []).some((s) => /supabase db push(?![^\n]*--dry-run)/.test(s.run ?? ''));

describe('db-migrations workflow', () => {
  it('DD-AUTH-043 引き金は pull_request と workflow_dispatch だけ（push が無い）', () => {
    expect(Object.keys(triggers).sort()).toEqual(['pull_request', 'workflow_dispatch']);
  });

  it('DD-AUTH-043 pull_request の job は db push --dry-run だけ', () => {
    const plan = doc.jobs.plan;
    expect(plan.if).toBe("github.event_name == 'pull_request'");
    expect(JSON.stringify(plan.steps)).toContain('supabase db push --dry-run');
    expect(runsRealDbPush(plan)).toBe(false);
  });

  it('DD-AUTH-043 実適用の db push を流す job は、全部 workflow_dispatch の時だけ動く', () => {
    const appliers = Object.entries(doc.jobs).filter(([, job]) => runsRealDbPush(job));
    expect(appliers.map(([name]) => name)).toContain('deploy');
    for (const [, job] of appliers) {
      expect(job.if).toBe("github.event_name == 'workflow_dispatch'");
    }
  });
});
