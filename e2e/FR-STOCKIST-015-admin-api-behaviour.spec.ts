/**
 * 管理の取扱店の窓口（GET・POST /api/admin/stockists、GET・PUT・PATCH・DELETE /api/admin/stockists/[id]）の振る舞い（STOCKIST 領域）。
 * 受け入れ条件: SEC-STOCKIST-007-AC-01・AC-02（回数の制限）、009-AC-01（応答の列）、010-AC-01（Cache-Control）、
 * 011-AC-01（制御文字・電話の字）、012-AC-01（監査の ip）、013-AC-01・AC-02（無い店舗・削除の監査）、014-AC-01・AC-02（誤りの応答・JSON でない本文）。
 *
 * 道: 本番ビルドの窓口へ Playwright の request で直に要求する（画面は開かない。画面幅は応答に関係しないので、FR-STOCKIST-014 と同じく幅ごとには繰り返さず、各 AC に1本）。
 * 管理者は手元の Supabase の本物の JWT（店長・aal2。e2e/admin-session-test-utils.ts）を Authorization: Bearer で送る。Cookie を送らないので
 * CSRF の token は要らない。変更の要求には許可のオリジン（Origin）を付ける。店舗の行と監査の行は手元の DB（postgres の接続）で作る・読む。
 *
 * 試験ごとに、新しい店長・新しい店舗の行・試験ごとの送り元（x-forwarded-for）を使う。変更の枠（20回/600秒）を送り元と操作者の
 * 両方で数えるので、他の試験や前の実行と枠を共有しない。ただし 012 は AC が決めた送り元（203.0.113.9）を使う（変更は1回だけ）。
 * 枠は時刻を 600 秒で割った固定の窓で数えるので、21回を同じ窓に収めるよう、窓の終わりが近い時は次の窓まで待ってから送る
 * （待つのは expect.poll で、固定の sleep ではない）。Playwright の再試行は使わない。
 *
 * 現行のコードが満たさない AC（文のとおりに書いてあり、緩めない。コードが直るまで test.fail で印を付ける）:
 * 010-AC-01（管理の応答に Cache-Control が付かない）、012-AC-01（x-forwarded-for をそのまま監査の ip に入れる）。
 * 009・011・013・014 は 2026-10-26 に満たしたので test.fail を外してある。007 は元から満たす。
 *
 * 作った利用者・session・監査の行は消さない（db reset で消える）。店舗の行だけ、公開の取扱店を数える別の試験に混ざらないよう終わりに消す
 * （行は status='private' で作り、公開の画面には出さない。007 の 21回目の PATCH は 'published' を送るが、429 で断られて private のまま）。
 * 手元の DB の権限の表は、権限の設定の試験と同じ lock（withPermissionScenario）の中で読む。lock は他の管理 API の試験も待つので、
 * 窓の終わりを避ける待ち（最長 75 秒）は lock を取る前に済ませ、lock の中では 21 回を送る間だけ持つ。
 */
import { randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { bearerHeaders, createAdminSessionActor, type AdminSessionActor } from './admin-session-test-utils';
import { withPermissionScenario } from './permission-settings-test-utils';

// 管理者の JWT を通信記録に残さないため、ファイルの先頭で無効にする。
test.use({ trace: 'off' });
test.describe.configure({ timeout: 120_000 });

const LIST_PATH = '/api/admin/stockists';
const one = (id: number | string): string => `/api/admin/stockists/${id}`;
/** 必ず無い id（bigint の範囲で、連番がここまで進まない値） */
const MISSING_ID = 9_000_000_000_000;
/** 変更の枠（SEC-STOCKIST-007 の文: 変更は 20回/600秒） */
const MUTATION_LIMIT = 20;
const WINDOW_SECONDS = 600;
/** 21回を送り終えるまで窓が替わらないと見なす、窓の残りの秒数 */
const WINDOW_GUARD_SECONDS = 45;
/** SEC-STOCKIST-012-AC-01 が決めた、偽の送り元 */
const FORGED_IP = '203.0.113.9';
/** SEC-STOCKIST-009 が決めた列（列は案） */
const ADMIN_COLUMNS = ['id', 'name', 'address', 'phone', 'time', 'holiday', 'status', 'updated_at'];

type StockistRow = { id: number; name: string; address: string; phone: string; time: string; holiday: string; status: string };
type AuditRow = { outcome: string; resource_id: string | null; detail: string | null; ip: string | null; metadata: unknown };

type Scenario = {
  db: PgClient;
  request: APIRequestContext;
  actor: AdminSessionActor;
  origin: string;
  /** この試験だけの送り元（x-forwarded-for） */
  ip: string;
  stockist: StockistRow;
  /** 作った行の名前の頭。この頭で始まる行を数えて、増えた・消えたを見る */
  namePrefix: string;
};

function uniqueIp(): string {
  const [a, b, c] = randomBytes(3);
  return `10.${a}.${b}.${c}`;
}

/** 窓（600秒で割った固定の区切り）の終わりまでの秒数 */
function secondsLeftInWindow(): number {
  return WINDOW_SECONDS - ((Date.now() / 1000) % WINDOW_SECONDS);
}

/** 窓の終わりが近ければ、次の窓に入るまで待つ。21回の変更が窓をまたいで枠が戻るのを避ける */
async function enterFreshWindowSpan(): Promise<void> {
  if (secondsLeftInWindow() > WINDOW_GUARD_SECONDS) return;
  await expect
    .poll(secondsLeftInWindow, { timeout: (WINDOW_GUARD_SECONDS + 30) * 1000, intervals: [500] })
    .toBeGreaterThan(WINDOW_GUARD_SECONDS);
}

async function readStockist(db: PgClient, id: number): Promise<StockistRow | null> {
  const res = await db.query(
    'select id, name, address, phone, time, holiday, status from public.stockists where id = $1::bigint',
    [id],
  );
  return (res.rows[0] as StockistRow | undefined) ?? null;
}

async function countByNamePrefix(db: PgClient, namePrefix: string): Promise<number> {
  const res = await db.query('select count(*)::int as n from public.stockists where name like $1', [`${namePrefix}%`]);
  return res.rows[0].n as number;
}

async function auditRows(db: PgClient, actorId: string, action: string): Promise<AuditRow[]> {
  const res = await db.query(
    `select outcome, resource_id, detail, ip, metadata
       from public.audit_logs
      where actor_id = $1::uuid and action = $2
      order by created_at, id`,
    [actorId, action],
  );
  return res.rows as AuditRow[];
}

async function countSuccessAudits(db: PgClient, actorId: string): Promise<number> {
  const res = await db.query(
    `select count(*)::int as n from public.audit_logs
      where actor_id = $1::uuid and resource = 'stockists' and outcome = 'success'`,
    [actorId],
  );
  return res.rows[0].n as number;
}

/** 新しい店長（aal2）・新しい店舗の行（非公開）・試験ごとの送り元で場面を作り、終わりに店舗の行を消す */
async function withScenario(
  request: APIRequestContext,
  baseURL: string | undefined,
  run: (scenario: Scenario) => Promise<void>,
  options: { freshWindow?: boolean } = {},
): Promise<void> {
  if (!baseURL) throw new Error('baseURL が無い（playwright.config.ts）');
  // 窓の終わりが近い時の待ちは、共有の lock を取る前に済ませる（lock を最長 75 秒も持たない）
  if (options.freshWindow) await enterFreshWindowSpan();
  await withPermissionScenario(async (db) => {
    const actor = await createAdminSessionActor(db, 'admin', 'aal2');
    const tag = randomBytes(4).toString('hex');
    const namePrefix = `E2E-STK-015-${tag}`;
    const inserted = await db.query(
      `insert into public.stockists (type, name, address, phone, time, holiday, status)
       values ('STORE', $1, $2, '03-0000-0000', '11:00-18:00', 'Synthetic schedule', 'private')
       returning id, name, address, phone, time, holiday, status`,
      [`${namePrefix} Store`, `E2E-STK-015 Address ${tag}`],
    );
    const stockist = inserted.rows[0] as StockistRow;
    try {
      await run({ db, request, actor, origin: new URL(baseURL).origin, ip: uniqueIp(), stockist, namePrefix });
    } finally {
      await db.query('delete from public.stockists where name like $1', [`${namePrefix}%`]);
    }
  });
}

function readHeaders(s: Scenario, ip: string = s.ip): Record<string, string> {
  return { ...bearerHeaders(s.actor), 'x-forwarded-for': ip };
}

function writeHeaders(s: Scenario, ip: string = s.ip): Record<string, string> {
  return { ...readHeaders(s, ip), origin: s.origin };
}

/**
 * JSON でない本文（content-type は JSON のまま）。
 * 文字列のまま渡すと、Playwright は content-type が JSON で中身が JSON として読めない時に JSON.stringify し直す
 * （"{not json" という正しい JSON の文字列として届く）ので、壊れた本文が窓口に届かない。Buffer なら手を加えずに送る。
 */
function brokenJson(s: Scenario): { headers: Record<string, string>; data: Buffer } {
  return { headers: { ...writeHeaders(s), 'content-type': 'application/json' }, data: Buffer.from('{not json', 'utf8') };
}

/**
 * PATCH を count 回、順に送る。最後の1回だけ status を 'published' にし、枠の外で断られなければ公開に変わる形にする
 * （それ以前は 'private' のまま送るので、公開の画面には出ない）。differentIps なら毎回違う送り元を付ける。
 */
async function sendPatches(s: Scenario, count: number, differentIps: boolean): Promise<APIResponse[]> {
  const responses: APIResponse[] = [];
  for (let i = 1; i <= count; i += 1) {
    responses.push(
      await s.request.patch(one(s.stockist.id), {
        headers: writeHeaders(s, differentIps ? uniqueIp() : s.ip),
        data: { status: i === count ? 'published' : 'private' },
      }),
    );
  }
  return responses;
}

function expectNoStore(response: APIResponse, label: string): void {
  const cacheControl = (response.headers()['cache-control'] ?? '').toLowerCase();
  expect(cacheControl, `${label} の Cache-Control`).toContain('no-store');
  expect(cacheControl, `${label} の Cache-Control`).toContain('private');
}

const validBody = (s: Scenario, overrides: Record<string, string> = {}): Record<string, string> => ({
  name: `${s.namePrefix} Store`,
  address: `E2E-STK-015 Address ${s.namePrefix}`,
  phone: '03-1111-2222',
  time: '11:00-18:00',
  holiday: 'Synthetic schedule',
  status: 'private',
  ...overrides,
});

test.describe('FR-STOCKIST-015 管理の取扱店の窓口の振る舞い', () => {
  test('SEC-STOCKIST-007-AC-01 変更の21回目の PATCH は 429 になり、Retry-After が付き、店舗の公開状態は変わらない', async ({ request, baseURL }) => {
    await withScenario(request, baseURL, async (s) => {
      const responses = await sendPatches(s, MUTATION_LIMIT + 1, false);

      // 同じ600秒の窓の中の、枠いっぱいまでの20回は通る
      expect(responses.slice(0, MUTATION_LIMIT).map((r) => r.status())).toEqual(Array(MUTATION_LIMIT).fill(200));
      const twentyFirst = responses[MUTATION_LIMIT];
      expect(twentyFirst.status()).toBe(429);
      expect(twentyFirst.headers()['retry-after'] ?? '').toMatch(/^\d+$/);
      // 21回目は 'published' を送ったが、断られて公開状態は変わらない
      expect((await readStockist(s.db, s.stockist.id))?.status).toBe('private');
    }, { freshWindow: true });
  });

  test('SEC-STOCKIST-007-AC-02 毎回違う x-forwarded-for を付けても、変更の21回目の PATCH は操作者の枠で 429 になる', async ({ request, baseURL }) => {
    await withScenario(request, baseURL, async (s) => {
      const responses = await sendPatches(s, MUTATION_LIMIT + 1, true);

      expect(responses.slice(0, MUTATION_LIMIT).map((r) => r.status())).toEqual(Array(MUTATION_LIMIT).fill(200));
      expect(responses[MUTATION_LIMIT].status()).toBe(429);
    }, { freshWindow: true });
  });

  test('SEC-STOCKIST-009-AC-01 管理の一覧と1件の取得は、決めた列のほかを返さず、type・created_at を含まない', async ({ request, baseURL }) => {
    await withScenario(request, baseURL, async (s) => {
      const list = await request.get(LIST_PATH, { headers: readHeaders(s) });
      expect(list.status()).toBe(200);
      const listed = ((await list.json()) as { data: Array<Record<string, unknown>> }).data;
      expect(listed.length).toBeGreaterThan(0);
      for (const row of listed) {
        expect(Object.keys(row).sort()).toEqual([...ADMIN_COLUMNS].sort());
        expect(row).not.toHaveProperty('type');
        expect(row).not.toHaveProperty('created_at');
      }

      const single = await request.get(one(s.stockist.id), { headers: readHeaders(s) });
      expect(single.status()).toBe(200);
      const data = ((await single.json()) as { data: Record<string, unknown> }).data;
      expect(Object.keys(data).sort()).toEqual([...ADMIN_COLUMNS].sort());
      expect(data).not.toHaveProperty('type');
      expect(data).not.toHaveProperty('created_at');
    });
  });

  test('SEC-STOCKIST-010-AC-01 一覧・1件・無い id の1件の GET と、21回目の PATCH の 429 の Cache-Control に no-store と private が含まれる', async ({ request, baseURL }) => {
    test.fail(true, 'SEC-STOCKIST-010 今のコードは満たさない（docs/02_Requirements/areas/stockist.md）');
    await withScenario(request, baseURL, async (s) => {
      const list = await request.get(LIST_PATH, { headers: readHeaders(s) });
      expect(list.status()).toBe(200);
      expectNoStore(list, 'GET 一覧');

      const single = await request.get(one(s.stockist.id), { headers: readHeaders(s) });
      expect(single.status()).toBe(200);
      expectNoStore(single, 'GET 1件');

      const missing = await request.get(one(MISSING_ID), { headers: readHeaders(s) });
      expect(missing.status()).toBe(404);
      expectNoStore(missing, 'GET 無い id');

      const patches = await sendPatches(s, MUTATION_LIMIT + 1, false);
      expect(patches[MUTATION_LIMIT].status()).toBe(429);
      expectNoStore(patches[MUTATION_LIMIT], '21回目の PATCH の 429');
    }, { freshWindow: true });
  });

  test('SEC-STOCKIST-011-AC-01 店名に改行を入れた POST と電話に英字を入れた PUT は 400 になり、店舗の行は増えず変わらない', async ({ request, baseURL }) => {
    await withScenario(request, baseURL, async (s) => {
      const before = await readStockist(s.db, s.stockist.id);
      expect(await countByNamePrefix(s.db, s.namePrefix)).toBe(1);

      const created = await request.post(LIST_PATH, {
        headers: writeHeaders(s),
        data: validBody(s, { name: `${s.namePrefix} Newline\nInjected` }),
      });
      expect(created.status()).toBe(400);
      expect(await countByNamePrefix(s.db, s.namePrefix)).toBe(1);

      const updated = await request.put(one(s.stockist.id), {
        headers: writeHeaders(s),
        data: validBody(s, { phone: 'call-me-maybe' }),
      });
      expect(updated.status()).toBe(400);
      expect(await readStockist(s.db, s.stockist.id)).toEqual(before);
    });
  });

  test('SEC-STOCKIST-012-AC-01 x-forwarded-for: 203.0.113.9 を付けた PATCH の監査の行の ip は 203.0.113.9 でない', async ({ request, baseURL }) => {
    test.fail(true, 'SEC-STOCKIST-012 今のコードは満たさない（docs/02_Requirements/areas/stockist.md）');
    await withScenario(request, baseURL, async (s) => {
      const patched = await request.patch(one(s.stockist.id), {
        headers: writeHeaders(s, FORGED_IP),
        data: { status: 'private' },
      });
      expect(patched.status()).toBe(200);

      const rows = await auditRows(s.db, s.actor.userId, 'admin.stockists.patch');
      expect(rows).toHaveLength(1);
      expect(rows[0].outcome).toBe('success');
      expect(rows[0].ip ?? '').not.toContain(FORGED_IP);
    });
  });

  test('SEC-STOCKIST-013-AC-01 無い id への PUT・PATCH・DELETE は 404 になり、outcome=success の監査の行が増えない', async ({ request, baseURL }) => {
    await withScenario(request, baseURL, async (s) => {
      expect(await countSuccessAudits(s.db, s.actor.userId)).toBe(0);

      const put = await request.put(one(MISSING_ID), { headers: writeHeaders(s), data: validBody(s) });
      const patch = await request.patch(one(MISSING_ID), { headers: writeHeaders(s), data: { status: 'private' } });
      const del = await request.delete(one(MISSING_ID), { headers: writeHeaders(s) });

      expect([put.status(), patch.status(), del.status()]).toEqual([404, 404, 404]);
      expect(await countSuccessAudits(s.db, s.actor.userId)).toBe(0);
    });
  });

  test('SEC-STOCKIST-013-AC-02 店舗を1件消すと、削除の成功の監査の行に消した店舗の名前と住所が含まれる', async ({ request, baseURL }) => {
    await withScenario(request, baseURL, async (s) => {
      const deleted = await request.delete(one(s.stockist.id), { headers: writeHeaders(s) });
      expect(deleted.status()).toBe(200);
      expect(await readStockist(s.db, s.stockist.id)).toBeNull();

      const rows = (await auditRows(s.db, s.actor.userId, 'admin.stockists.delete')).filter((row) => row.outcome === 'success');
      expect(rows).toHaveLength(1);
      // 名前と住所は detail か metadata のどちらに残してもよい（AC は「監査の行に含まれる」）
      const recorded = `${rows[0].detail ?? ''} ${JSON.stringify(rows[0].metadata ?? null)}`;
      expect(recorded).toContain(s.stockist.name);
      expect(recorded).toContain(s.stockist.address);
    });
  });

  test('SEC-STOCKIST-014-AC-01 店名を空にした POST は 400 になり、本文に fieldErrors・formErrors が含まれない', async ({ request, baseURL }) => {
    await withScenario(request, baseURL, async (s) => {
      const created = await request.post(LIST_PATH, { headers: writeHeaders(s), data: validBody(s, { name: '' }) });
      expect(created.status()).toBe(400);

      const text = await created.text();
      expect(text).not.toContain('fieldErrors');
      expect(text).not.toContain('formErrors');
    });
  });

  test('SEC-STOCKIST-014-AC-02 JSON でない本文の POST・PUT・PATCH は 400 になり、店舗の行は増えず変わらない', async ({ request, baseURL }) => {
    await withScenario(request, baseURL, async (s) => {
      const before = await readStockist(s.db, s.stockist.id);
      const { headers, data } = brokenJson(s);

      const post = await request.post(LIST_PATH, { headers, data });
      const put = await request.put(one(s.stockist.id), { headers, data });
      const patch = await request.patch(one(s.stockist.id), { headers, data });

      expect([post.status(), put.status(), patch.status()]).toEqual([400, 400, 400]);
      expect(await countByNamePrefix(s.db, s.namePrefix)).toBe(1);
      expect(await readStockist(s.db, s.stockist.id)).toEqual(before);
    });
  });
});
