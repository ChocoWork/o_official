# E2E を手元の Supabase で流す（グループ B・計画1）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** E2E と push の前の検査を、本番の Supabase から手元の Supabase に切り替える。本番につながる設定は見張りで止め、テストのメールは外へ出さない。

**Architecture:** `playwright.config.ts` が起動のたびに `npx supabase status -o json` から手元の住所と鍵を読み、`.env.local` の値を上書きして、アプリとテストの両方に渡す。見張り（純関数）が本番の住所・本番の鍵・外へのメールを拒む。3000番のアプリは、アプリ自身が返す E2E の印と照らして、使い回すかを決める。メールは新しい送り方 `local`（Mailpit の HTTP API）に送り、見本データは `supabase/seed.sql` に架空の値で置く。

**Tech Stack:** Next.js 16 App Router、TypeScript、Playwright 1.58、Jest 29（ts-jest）、Supabase CLI 2.x（Postgres 17、Mailpit 1.30）、tsx 4

**Spec:** [docs/superpowers/specs/2026-10-05-webhook-queue-operations-design.md](../specs/2026-10-05-webhook-queue-operations-design.md)（第7章と 9-2・9-3）

**計画の分け方:** グループ B の設計書は2つの計画で作る。本計画（計画1）は第7章（E2E の切り離し）。キューと定期処理（第3〜6・8・10章）は計画2で、本計画の後に作る（設計書 10-1 の「第7章を先に作る」）。

## Global Constraints

- 本番 Supabase（`pjidrgofvaglnuuznnyj`）に書かない。本番へは、Task 7 の「行が増えていない」を確かめる SELECT だけを流す（Supabase MCP の `execute_sql`）
- 手元の Supabase を使う前に `docker inspect -f '{{.State.Health.Status}}' supabase_db_o_official` が `healthy` であることを確かめる。止まっていれば `npx supabase start`。全件 `ECONNREFUSED` は接続の問題で、実装の不具合ではない
- 依存パッケージを足さない。手元のメール受けへは Mailpit の HTTP API（`POST http://127.0.0.1:54324/api/v1/send`）で送る。TS のスクリプトは既存の `tsx` で動かす
- E2E は本番ビルドで流す。流す前に `Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue` で3000番に何も無いことを確かめる。dev サーバーを動かした後は `.next` を消してからビルドする
- 本番の Supabase の鍵と Resend の鍵を、E2E のアプリにもテストにも渡さない。`.env.local` は読むだけで書き換えない。手元の Supabase の鍵もファイルに書かない（起動のたびに `npx supabase status -o json` から読む）
- 見本データは架空の値だけ。お客様・管理者のアカウント、注文、個人情報を入れない。画像は手元の Storage に置いた仮の画像（12×16 の灰色の PNG）
- E2E の比べ方の「前」は `.superpowers/sdd/2026-10-05-webhook-queue-operations/e2e-baseline-2026-10-05-tests.json`（2,628件。通過2,349・失敗248・飛ばし31。2026-10-05 0:42 開始の全件）。git の管理外のフォルダなので、消さない・上書きしない
- テストを先に書く（Jest）。DB 結合テストはフォルダ全体を `--runInBand` で流す
- 画面・ログ・エラーの文言は日本語（既存のエラー文に合わせて英語のものは英語のまま）
- 作業は master に直接コミットする。`git add` は触ったファイルを名指しする。コミットメッセージは日本語の Conventional Commits、末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。push はしない（ユーザーが行う）
- コミットのたびに graphify の post-commit フックがグラフを作り直すので、手で `graphify update` を流す必要は無い

## Review Focus

本計画のタスクのテストで直接は確かめていないが、使う人が最も踏みやすい入力と状態。各行のテストは括弧内のタスクに足してある。

1. **普段の開発サーバー（`npm run dev`、本番の DB）が3000番で動いたまま E2E を流す**: 使い回さずに、理由を出して止まる（Task 2 の「印を返さないアプリが動いていたら止める」、Task 4 の Step 6）
2. **手元の Supabase（Docker）が止まっている**: 「手元の Supabase を起動して」と分かる言葉で止まり、本番へはつながない（Task 2 の「状態を読めないときは、起動を促して止める」と「値が欠けていたら止める」）
3. **`.env.local` に本番の Supabase の鍵と Resend の鍵が入ったまま**: E2E のアプリとテストには手元の値が入り、Resend の鍵は空になる（Task 2 の「`.env.local` の本番の値を手元の値で上書きする」）
4. **普段の開発で `.env.local` が `MAIL_PROVIDER=resend` のまま**: `next dev` ではメールが手元に届き、外へは出ない（Task 1 の「開発では設定にかかわらず local」）
5. **Playwright の worker が設定を読み直す**: 手元の状態を読み直さず、受け継いだ値を確かめるだけにする（Task 2 の「worker では読み直さない」）

---

## File Structure

| ファイル | 責務 |
|---|---|
| `src/lib/mail/adapters/local.ts`（新規） | 手元のメール受け（Mailpit）へ送る。手元以外の住所は断る |
| `src/lib/mail.ts` | 送り方を決める（`next dev` では `local`） |
| `scripts/e2e/environment.ts`（新規） | E2E の環境づくり・見張り・3000番の使い回しの判断 |
| `src/app/api/e2e/server-info/route.ts`（新規） | E2E 用に起動したアプリだけが印を返す |
| `playwright.config.ts` | 環境づくりを呼び、アプリとテストに渡す。結果を JSON でも残す |
| `scripts/e2e-server.mjs` | ビルドの前にもう一度見張る。使い回すアプリの印を確かめる |
| `supabase/config.toml` | Auth の戻り先を `localhost:3000` にそろえる |
| `supabase/seed.sql`（新規） | 架空の見本データ（表の行と Storage の bucket） |
| `scripts/e2e/seed-storage.ts`（新規） | 見本データが指す仮の画像を、手元の Storage に置く |
| `scripts/e2e/global-setup.ts`（新規） | E2E の前に仮の画像を置く（Playwright の globalSetup） |
| `next.config.ts` | 手元の Supabase につないだビルドだけ、手元の Storage の画像を `next/image` で表示できるようにする |
| `scripts/e2e/compare-baseline.ts`（新規） | 「前」と「後」の結果を比べる |
| `package.json` | `e2e:compare` を足す |
| `e2e/README.md`・`.claude/CLAUDE.md`・`scripts/hooks/pre-push`・`README.md` | 手元の Supabase で流すことを書く |
| `docs/05_Quality/reviews/code/2026-09-25-working-diff-security-review.md` | R-55 の状態を更新する |

| テスト | 確かめること |
|---|---|
| `tests/unit/lib/mail/local-adapter.test.ts`（新規） | Mailpit への送り方、手元以外を断る、失敗の扱い |
| `tests/unit/lib/mail/provider.test.ts`（新規） | 送り方の決め方 |
| `tests/unit/scripts/e2e/environment.test.ts`（新規） | 環境づくり・見張り・使い回しの判断 |
| `tests/unit/api/e2e/server-info-route.test.ts`（新規） | 印を返す条件 |
| `tests/unit/scripts/e2e/seed-storage.test.ts`（新規） | 仮の画像の置き方、手元以外を断る、seed.sql との一致 |
| `tests/unit/scripts/e2e/compare-baseline.test.ts`（新規） | 「前」と「後」の比べ方 |

---

### Task 1: 手元のメール受けへ送る（送り方 `local` と、普段の開発の既定）

設計書 7-5。E2E（本番の作り方で起動）は `MAIL_PROVIDER=local` で、普段の開発（`next dev`）は設定にかかわらず、手元のメール受け（Mailpit）に送る。本番（Vercel）は今どおり。

**Files:**
- Create: `src/lib/mail/adapters/local.ts`
- Modify: `src/lib/mail.ts`（全体）
- Test: `tests/unit/lib/mail/local-adapter.test.ts`、`tests/unit/lib/mail/provider.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `src/lib/mail/adapters/local.ts`: `export function resolveLocalMailUrl(raw: string | undefined): URL`、`export async function sendMail(payload: MailPayload): Promise<{ ID: string }>`（`MailPayload = { to: string; subject: string; text?: string; html?: string; from?: string; replyTo?: string }`）
  - `src/lib/mail.ts`: `export type MailProvider = 'ses' | 'resend' | 'local'`、`export function resolveMailProvider(env?: { NODE_ENV?: string; MAIL_PROVIDER?: string }): MailProvider`、`sendMail` は今と同じ形
  - 環境変数: `MAIL_LOCAL_URL`（手元のメール受けの住所。既定 `http://127.0.0.1:54324`）

- [ ] **Step 1: 手元の送り方のテストを書く**

`tests/unit/lib/mail/local-adapter.test.ts`:

```ts
/** @jest-environment node */
import { resolveLocalMailUrl, sendMail } from '@/lib/mail/adapters/local';

describe('手元のメール受け（Mailpit）への送信', () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env = { ...originalEnv, MAIL_FROM_ADDRESS: 'no-reply@e2e.test' };
    delete process.env.MAIL_LOCAL_URL;
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ID: 'abc' }) });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  it('既定の口（127.0.0.1:54324）の送信 API に、件名・本文・返信先を渡す', async () => {
    await expect(
      sendMail({ to: 'shop@e2e.test', subject: '件名', text: '本文', replyTo: 'reply@e2e.test' }),
    ).resolves.toEqual({ ID: 'abc' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://127.0.0.1:54324/api/v1/send');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({
      From: { Email: 'no-reply@e2e.test' },
      To: [{ Email: 'shop@e2e.test' }],
      Subject: '件名',
      Text: '本文',
      ReplyTo: [{ Email: 'reply@e2e.test' }],
    });
  });

  it('MAIL_LOCAL_URL があればその口に送り、html だけのメールも送れる', async () => {
    process.env.MAIL_LOCAL_URL = 'http://localhost:55555';
    await sendMail({ to: 'a@e2e.test', subject: 's', html: '<p>h</p>' });

    expect(String(fetchMock.mock.calls[0][0])).toBe('http://localhost:55555/api/v1/send');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ HTML: '<p>h</p>' });
    expect(body).not.toHaveProperty('Text');
    expect(body).not.toHaveProperty('ReplyTo');
  });

  it('手元でない住所には送らない（メールを外へ出さない）', async () => {
    process.env.MAIL_LOCAL_URL = 'https://mail.example.com';
    await expect(sendMail({ to: 'a@e2e.test', subject: 's', text: 't' })).rejects.toThrow(
      'MAIL_LOCAL_URL must point to localhost',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('メール受けが 2xx 以外を返したら失敗にする', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({}) });
    await expect(sendMail({ to: 'a@e2e.test', subject: 's', text: 't' })).rejects.toThrow(
      'Local mail send failed: HTTP 400',
    );
  });

  it('本文が無ければ送らない', async () => {
    await expect(sendMail({ to: 'a@e2e.test', subject: 's' })).rejects.toThrow(
      'Either html or text must be provided',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('差出人が無ければ手元用の既定の差出人を使う', async () => {
    delete process.env.MAIL_FROM_ADDRESS;
    await sendMail({ to: 'a@e2e.test', subject: 's', text: 't' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).From).toEqual({ Email: 'no-reply@localhost.test' });
  });

  it('::1 も手元として受け付ける', () => {
    expect(resolveLocalMailUrl('http://[::1]:54324').hostname).toBe('[::1]');
  });
});
```

- [ ] **Step 2: 送り方の決め方のテストを書く**

`tests/unit/lib/mail/provider.test.ts`:

```ts
import { resolveMailProvider } from '@/lib/mail';

describe('メールの送り方の決め方', () => {
  it('普段の開発（next dev）では、MAIL_PROVIDER が resend でも手元のメール受けに送る', () => {
    expect(resolveMailProvider({ NODE_ENV: 'development', MAIL_PROVIDER: 'resend' })).toBe('local');
  });

  it('本番の作り方で起動した E2E は MAIL_PROVIDER=local に従う', () => {
    expect(resolveMailProvider({ NODE_ENV: 'production', MAIL_PROVIDER: 'local' })).toBe('local');
  });

  it('本番は MAIL_PROVIDER に従う', () => {
    expect(resolveMailProvider({ NODE_ENV: 'production', MAIL_PROVIDER: 'resend' })).toBe('resend');
  });

  it('MAIL_PROVIDER が無ければ今までどおり ses', () => {
    expect(resolveMailProvider({ NODE_ENV: 'test' })).toBe('ses');
  });

  it('知らない送り方は断る', () => {
    expect(() => resolveMailProvider({ NODE_ENV: 'production', MAIL_PROVIDER: 'smtp' })).toThrow(
      'Unsupported mail provider: smtp',
    );
  });
});
```

- [ ] **Step 3: テストが落ちることを確かめる**

Run: `npx jest tests/unit/lib/mail`
Expected: FAIL（`Cannot find module '@/lib/mail/adapters/local'`、`resolveMailProvider is not a function`）

- [ ] **Step 4: 手元の送り方を作る**

`src/lib/mail/adapters/local.ts`:

```ts
type MailPayload = {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  from?: string;
  replyTo?: string;
};

const DEFAULT_LOCAL_MAIL_URL = 'http://127.0.0.1:54324';
const DEFAULT_LOCAL_SENDER = 'no-reply@localhost.test';
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * 手元のメール受け（Supabase CLI に付いている Mailpit）の住所。
 * 手元以外の住所は断る。E2E と普段の開発のメールを外へ出さないため（設計書 2026-10-05 グループ B の 7-5）。
 */
export function resolveLocalMailUrl(raw: string | undefined): URL {
  const url = new URL(raw || DEFAULT_LOCAL_MAIL_URL);
  if (!LOCAL_HOSTNAMES.has(url.hostname)) {
    throw new Error(`MAIL_LOCAL_URL must point to localhost (got ${url.hostname})`);
  }
  return url;
}

export async function sendMail({ to, subject, html, text, from, replyTo }: MailPayload) {
  if (!html && !text) throw new Error('Either html or text must be provided');
  const base = resolveLocalMailUrl(process.env.MAIL_LOCAL_URL);
  const sender = from || process.env.MAIL_FROM_ADDRESS || DEFAULT_LOCAL_SENDER;

  // Mailpit の送信 API（POST /api/v1/send）。SMTP を開けずに、既存の画面の口で受け取れる。
  const response = await fetch(new URL('/api/v1/send', base), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      From: { Email: sender },
      To: [{ Email: to }],
      Subject: subject,
      ...(text ? { Text: text } : {}),
      ...(html ? { HTML: html } : {}),
      ...(replyTo ? { ReplyTo: [{ Email: replyTo }] } : {}),
    }),
  });

  if (!response.ok) throw new Error(`Local mail send failed: HTTP ${response.status}`);
  return (await response.json()) as { ID: string };
}

export default sendMail;
```

- [ ] **Step 5: 送り方の決め方を足す**

`src/lib/mail.ts` を次の内容に置き換える:

```ts
type MailPayload = {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  from?: string;
  replyTo?: string;
};

export type MailProvider = 'ses' | 'resend' | 'local';

/**
 * どの送り方を使うかを決める。
 * 普段の開発（next dev）は、設定にかかわらず手元のメール受け（Mailpit）に送る。
 * E2E は起動の仕組みが MAIL_PROVIDER=local を渡す。本番は MAIL_PROVIDER に従う（設計書 2026-10-05 グループ B の 7-5）。
 */
export function resolveMailProvider(
  env: { NODE_ENV?: string; MAIL_PROVIDER?: string } = process.env,
): MailProvider {
  if (env.NODE_ENV === 'development') return 'local';
  const provider = env.MAIL_PROVIDER || 'ses';
  if (provider === 'ses' || provider === 'resend' || provider === 'local') return provider;
  throw new Error(`Unsupported mail provider: ${provider}`);
}

export async function sendMail(payload: MailPayload) {
  switch (resolveMailProvider()) {
    case 'ses': {
      const adapter = await import('./mail/adapters/ses');
      return adapter.sendMail(payload);
    }
    case 'resend': {
      const adapter = await import('./mail/adapters/resend');
      return adapter.sendMail(payload);
    }
    case 'local': {
      const adapter = await import('./mail/adapters/local');
      return adapter.sendMail(payload);
    }
  }
}

export default sendMail;
```

- [ ] **Step 6: テストが通ることを確かめる**

Run: `npx jest tests/unit/lib/mail`
Expected: PASS（12件）

Run: `npx jest tests/unit/api/contact tests/unit/lib/orders`
Expected: PASS（`sendMail` をモックしている既存のテストが今までどおり通る）

Run: `npm run typecheck`
Expected: エラー0

- [ ] **Step 7: コミット**

```bash
git add src/lib/mail/adapters/local.ts src/lib/mail.ts tests/unit/lib/mail/local-adapter.test.ts tests/unit/lib/mail/provider.test.ts
git commit -m "$(cat <<'EOF'
feat(mail): 手元のメール受け（Mailpit）への送り方を足し、普段の開発では外へ出さない

E2E は MAIL_PROVIDER=local、next dev は設定にかかわらず手元に送る。手元以外の
住所は断る。Mailpit の HTTP API を使うので依存パッケージは増やさない。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: E2E の環境づくりと見張り

設計書 7-3。手元の Supabase の住所と鍵で `.env.local` の値を上書きし、本番につながる設定を拒み、3000番の使い回しを決める。判断はすべて純関数にし、外を触るのは `npx supabase status` を読む関数と3000番を確かめる関数だけにする。

**Files:**
- Create: `scripts/e2e/environment.ts`
- Test: `tests/unit/scripts/e2e/environment.test.ts`

**Interfaces:**
- Consumes: なし（Task 3 の入口 `GET /api/e2e/server-info` が返す `{ fingerprint: string }` を前提に、3000番を確かめる）
- Produces（`scripts/e2e/environment.ts`）:
  - `export type EnvRecord = Record<string, string | undefined>`
  - `export type E2EServerMode = 'start' | 'dev'`
  - `export type LocalSupabaseStatus = { apiUrl: string; anonKey: string; serviceRoleKey: string; jwtSecret: string; mailpitUrl: string }`
  - `export type ServerProbe = { kind: 'down' } | { kind: 'up'; fingerprint: string | null }`
  - `export const E2E_FIXED_ENV: Readonly<Record<string, string>>`
  - `export function isLocalUrl(raw: string | undefined): boolean`
  - `export function parseSupabaseStatus(json: string): LocalSupabaseStatus`
  - `export function buildE2EOverrides(status: LocalSupabaseStatus): Record<string, string>`
  - `export function findUnsafeE2ESettings(env: EnvRecord): string[]`
  - `export function assertSafeE2EEnv(env: EnvRecord): void`
  - `export function computeServerFingerprint(env: EnvRecord, mode: E2EServerMode): string`（16進32文字）
  - `export function decideServerReuse(probe: ServerProbe, expectedFingerprint: string, strict: boolean): boolean`
  - `export function readLocalSupabaseStatus(run?: () => string): LocalSupabaseStatus`（`run` の既定は `npx supabase status -o json` を動かす関数。テストでは差し替える）
  - `export function probeServer(baseUrl: string): ServerProbe`
  - `export function prepareE2EEnvironment(options: { baseEnv: EnvRecord; mode: E2EServerMode; strict: boolean; isWorker: boolean; baseUrl: string; readStatus?: () => LocalSupabaseStatus; probe?: (baseUrl: string) => ServerProbe }): { env: Record<string, string>; reuseExistingServer: boolean }`

- [ ] **Step 1: テストを書く**

`tests/unit/scripts/e2e/environment.test.ts`:

```ts
/** @jest-environment node */
import {
  E2E_FIXED_ENV,
  buildE2EOverrides,
  computeServerFingerprint,
  decideServerReuse,
  findUnsafeE2ESettings,
  isLocalUrl,
  parseSupabaseStatus,
  prepareE2EEnvironment,
  readLocalSupabaseStatus,
  type LocalSupabaseStatus,
  type ServerProbe,
} from '@/../scripts/e2e/environment';

const status: LocalSupabaseStatus = {
  apiUrl: 'http://127.0.0.1:54321',
  anonKey: 'local-anon-key',
  serviceRoleKey: 'local-service-role-key',
  jwtSecret: 'local-jwt-secret-0123456789abcdef0123456789',
  mailpitUrl: 'http://127.0.0.1:54324',
};

// .env.local に近い値（本番の Supabase・Resend の鍵が入っている）
const dotEnvLocal = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://prodproject.supabase.co',
  SUPABASE_URL: 'https://prodproject.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'prod-anon',
  SUPABASE_SERVICE_ROLE_KEY: 'prod-service',
  MAIL_PROVIDER: 'resend',
  RESEND_API_KEY: 're_prod_key',
  STRIPE_SECRET_KEY: 'sk_test_abc',
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_abc',
};

const safeEnv = { ...dotEnvLocal, ...buildE2EOverrides(status) };

describe('isLocalUrl', () => {
  it.each(['http://127.0.0.1:54321', 'http://localhost:3000', 'http://[::1]:54321'])('%s は手元', (url) => {
    expect(isLocalUrl(url)).toBe(true);
  });
  it.each(['https://prodproject.supabase.co', 'not a url', undefined, ''])('%s は手元ではない', (url) => {
    expect(isLocalUrl(url)).toBe(false);
  });
});

describe('parseSupabaseStatus', () => {
  it('npx supabase status -o json の出力から E2E に要る値を取り出す', () => {
    const json = JSON.stringify({
      API_URL: status.apiUrl,
      ANON_KEY: status.anonKey,
      SERVICE_ROLE_KEY: status.serviceRoleKey,
      JWT_SECRET: status.jwtSecret,
      MAILPIT_URL: status.mailpitUrl,
      DB_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
    });
    expect(parseSupabaseStatus(json)).toEqual(status);
  });

  it('値が欠けていたら、手元の Supabase を起動するよう言って止める', () => {
    expect(() => parseSupabaseStatus(JSON.stringify({ API_URL: status.apiUrl }))).toThrow('npx supabase start');
  });
});

describe('readLocalSupabaseStatus', () => {
  it('状態を読めない（Docker や手元の Supabase が止まっている）ときは、起動を促して止める', () => {
    const run = () => {
      throw new Error('supabase start is not running');
    };
    expect(() => readLocalSupabaseStatus(run)).toThrow('npx supabase start で手元の Supabase を起動してください');
  });

  it('読めたら E2E に要る値を返す', () => {
    const run = () =>
      JSON.stringify({
        API_URL: status.apiUrl,
        ANON_KEY: status.anonKey,
        SERVICE_ROLE_KEY: status.serviceRoleKey,
        JWT_SECRET: status.jwtSecret,
        MAILPIT_URL: status.mailpitUrl,
      });
    expect(readLocalSupabaseStatus(run)).toEqual(status);
  });
});

describe('buildE2EOverrides', () => {
  it('手元の住所と鍵・E2E の固定値を返し、Resend の鍵は空にする', () => {
    const overrides = buildE2EOverrides(status);
    expect(overrides).toMatchObject({
      NEXT_PUBLIC_SUPABASE_URL: status.apiUrl,
      SUPABASE_URL: status.apiUrl,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: status.anonKey,
      SUPABASE_SERVICE_ROLE_KEY: status.serviceRoleKey,
      JWT_SECRET: status.jwtSecret,
      MAIL_LOCAL_URL: status.mailpitUrl,
      MAIL_PROVIDER: 'local',
      RESEND_API_KEY: '',
    });
    expect(overrides).toMatchObject(E2E_FIXED_ENV);
  });

  it('E2E の定期処理の合言葉は32文字以上', () => {
    expect(E2E_FIXED_ENV.CRON_SECRET.length).toBeGreaterThanOrEqual(32);
  });
});

describe('findUnsafeE2ESettings', () => {
  it('手元の設定なら止める理由は無い', () => {
    expect(findUnsafeE2ESettings(safeEnv)).toEqual([]);
  });

  it.each([
    ['NEXT_PUBLIC_SUPABASE_URL', 'https://prodproject.supabase.co'],
    ['SUPABASE_URL', 'https://prodproject.supabase.co'],
    ['STRIPE_SECRET_KEY', 'sk_live_abc'],
    ['NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'pk_live_abc'],
    ['MAIL_PROVIDER', 'resend'],
    ['MAIL_LOCAL_URL', 'https://mail.example.com'],
    ['RESEND_API_KEY', 're_prod_key'],
  ])('%s が %s なら止める理由に挙げる', (key, value) => {
    expect(findUnsafeE2ESettings({ ...safeEnv, [key]: value }).join('\n')).toContain(key);
  });

  it('制限付きのテスト用の鍵（rk_test_）は受け付ける', () => {
    expect(findUnsafeE2ESettings({ ...safeEnv, STRIPE_SECRET_KEY: 'rk_test_abc' })).toEqual([]);
  });
});

describe('computeServerFingerprint', () => {
  it('同じ設定なら同じ値（16進32文字）', () => {
    const a = computeServerFingerprint(safeEnv, 'start');
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(computeServerFingerprint({ ...safeEnv }, 'start')).toBe(a);
  });

  it('起動のしかた（本番ビルド・開発サーバー）で変わる', () => {
    expect(computeServerFingerprint(safeEnv, 'dev')).not.toBe(computeServerFingerprint(safeEnv, 'start'));
  });

  it('Supabase の住所で変わる', () => {
    expect(computeServerFingerprint({ ...safeEnv, NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321' }, 'start')).not.toBe(
      computeServerFingerprint(safeEnv, 'start'),
    );
  });
});

describe('decideServerReuse', () => {
  it('3000番が空いていれば起動する（使い回さない）', () => {
    expect(decideServerReuse({ kind: 'down' }, 'fp', false)).toBe(false);
  });

  it('同じ印のアプリなら使い回す', () => {
    expect(decideServerReuse({ kind: 'up', fingerprint: 'fp' }, 'fp', false)).toBe(true);
  });

  it('印を返さないアプリ（普段の開発サーバーなど）が動いていたら止める', () => {
    expect(() => decideServerReuse({ kind: 'up', fingerprint: null }, 'fp', false)).toThrow('止めてから流してください');
  });

  it('印が違うアプリが動いていたら止める', () => {
    expect(() => decideServerReuse({ kind: 'up', fingerprint: 'other' }, 'fp', false)).toThrow('止めてから流してください');
  });

  it('E2E_STRICT=1 では同じ印でも使い回さずに止める', () => {
    expect(() => decideServerReuse({ kind: 'up', fingerprint: 'fp' }, 'fp', true)).toThrow('E2E_STRICT=1');
  });
});

describe('prepareE2EEnvironment', () => {
  const baseUrl = 'http://localhost:3000';

  it('.env.local の本番の値を手元の値で上書きし、印を付ける', () => {
    const readStatus = jest.fn(() => status);
    const probe = jest.fn((): ServerProbe => ({ kind: 'down' }));

    const result = prepareE2EEnvironment({
      baseEnv: dotEnvLocal, mode: 'start', strict: false, isWorker: false, baseUrl, readStatus, probe,
    });

    expect(result.reuseExistingServer).toBe(false);
    expect(result.env.NEXT_PUBLIC_SUPABASE_URL).toBe(status.apiUrl);
    expect(result.env.SUPABASE_SERVICE_ROLE_KEY).toBe(status.serviceRoleKey);
    expect(result.env.RESEND_API_KEY).toBe('');
    expect(result.env.E2E_SERVER_FINGERPRINT).toBe(computeServerFingerprint(safeEnv, 'start'));
    expect(readStatus).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(baseUrl);
  });

  it('同じ印のアプリが動いていれば使い回す', () => {
    const fingerprint = computeServerFingerprint(safeEnv, 'start');
    const result = prepareE2EEnvironment({
      baseEnv: dotEnvLocal, mode: 'start', strict: false, isWorker: false, baseUrl,
      readStatus: () => status, probe: () => ({ kind: 'up', fingerprint }),
    });
    expect(result.reuseExistingServer).toBe(true);
  });

  it('Stripe の鍵が本番用なら止める', () => {
    expect(() =>
      prepareE2EEnvironment({
        baseEnv: { ...dotEnvLocal, STRIPE_SECRET_KEY: 'sk_live_abc' }, mode: 'start', strict: false, isWorker: false,
        baseUrl, readStatus: () => status, probe: () => ({ kind: 'down' }),
      }),
    ).toThrow('STRIPE_SECRET_KEY');
  });

  it('worker では手元の状態を読み直さず、受け継いだ値を確かめるだけ', () => {
    const readStatus = jest.fn(() => status);
    const probe = jest.fn((): ServerProbe => ({ kind: 'down' }));
    expect(
      prepareE2EEnvironment({ baseEnv: safeEnv, mode: 'start', strict: false, isWorker: true, baseUrl, readStatus, probe }),
    ).toEqual({ env: {}, reuseExistingServer: false });
    expect(readStatus).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it('worker が本番の値を受け継いでいたら止める', () => {
    expect(() =>
      prepareE2EEnvironment({ baseEnv: dotEnvLocal, mode: 'start', strict: false, isWorker: true, baseUrl }),
    ).toThrow('E2E の見張り');
  });
});
```

- [ ] **Step 2: テストが落ちることを確かめる**

Run: `npx jest tests/unit/scripts/e2e/environment.test.ts`
Expected: FAIL（`Cannot find module '@/../scripts/e2e/environment'`）

- [ ] **Step 3: 環境づくりと見張りを作る**

`scripts/e2e/environment.ts`:

```ts
/**
 * E2E を手元の Supabase で流すための環境づくりと見張り（設計書 2026-10-05 グループ B の 7-3）。
 *
 * - 手元の Supabase の住所と鍵は、起動のたびに `npx supabase status -o json` から読む（ファイルに書かない）。
 * - `.env.local` の本番の Supabase の鍵と Resend の鍵は、E2E のアプリにもテストにも渡さない。
 * - 本番につながるおそれのある設定なら、理由を出して止める。
 * - 3000番のアプリは、この仕組みが同じ設定で起動したもの（同じ印を返すもの）だけ使い回す。
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export type EnvRecord = Record<string, string | undefined>;

export type E2EServerMode = 'start' | 'dev';

export type LocalSupabaseStatus = {
  apiUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  jwtSecret: string;
  mailpitUrl: string;
};

export type ServerProbe = { kind: 'down' } | { kind: 'up'; fingerprint: string | null };

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** E2E だけで使う固定の値。本番の値ではない。 */
export const E2E_FIXED_ENV: Readonly<Record<string, string>> = {
  MAIL_PROVIDER: 'local',
  MAIL_FROM_ADDRESS: 'no-reply@e2e.test',
  CONTACT_TO_EMAIL: 'shop@e2e.test',
  SHOP_ALERT_EMAIL: 'shop-alert@e2e.test',
  CONTACT_INBOUND_DOMAIN: 'inbound.e2e.test',
  CONTACT_REPLY_SECRET: 'e2e-local-contact-reply-secret-0123456789',
  RESEND_API_KEY: '',
  STRIPE_WEBHOOK_SECRET: 'whsec_e2e_local_only',
  CRON_SECRET: 'e2e-local-cron-secret-0123456789abcdef',
};

export function isLocalUrl(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    return LOCAL_HOSTNAMES.has(new URL(raw).hostname);
  } catch {
    return false;
  }
}

/** `npx supabase status -o json` の出力から、E2E に要る値だけを取り出す。 */
export function parseSupabaseStatus(json: string): LocalSupabaseStatus {
  const raw = JSON.parse(json) as Record<string, unknown>;
  const pick = (key: string): string => {
    const value = raw[key];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(
        `E2E の見張り: 手元の Supabase の状態に ${key} がありません。Docker を起動し、npx supabase start で手元の Supabase を起動してください。`,
      );
    }
    return value;
  };
  return {
    apiUrl: pick('API_URL'),
    anonKey: pick('ANON_KEY'),
    serviceRoleKey: pick('SERVICE_ROLE_KEY'),
    jwtSecret: pick('JWT_SECRET'),
    mailpitUrl: pick('MAILPIT_URL'),
  };
}

/** E2E のアプリとテストに渡す値。`.env.local` の同じ名前の値を上書きする。 */
export function buildE2EOverrides(status: LocalSupabaseStatus): Record<string, string> {
  return {
    NEXT_PUBLIC_SUPABASE_URL: status.apiUrl,
    SUPABASE_URL: status.apiUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: status.anonKey,
    SUPABASE_SERVICE_ROLE_KEY: status.serviceRoleKey,
    JWT_SECRET: status.jwtSecret,
    MAIL_LOCAL_URL: status.mailpitUrl,
    ...E2E_FIXED_ENV,
  };
}

/** 本番につながるおそれのある設定を挙げる。空なら安全。 */
export function findUnsafeE2ESettings(env: EnvRecord): string[] {
  const problems: string[] = [];
  for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_URL']) {
    if (!isLocalUrl(env[key])) problems.push(`${key} が手元（localhost）ではない`);
  }
  if (!/^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY ?? '')) {
    problems.push('STRIPE_SECRET_KEY がテスト用（sk_test_ / rk_test_）ではない');
  }
  if (!(env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '').startsWith('pk_test_')) {
    problems.push('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY がテスト用（pk_test_）ではない');
  }
  if (env.MAIL_PROVIDER !== 'local') problems.push('MAIL_PROVIDER が local ではない');
  if (!isLocalUrl(env.MAIL_LOCAL_URL)) problems.push('MAIL_LOCAL_URL が手元（localhost）ではない');
  if (env.RESEND_API_KEY) problems.push('RESEND_API_KEY が空ではない');
  return problems;
}

export function assertSafeE2EEnv(env: EnvRecord): void {
  const problems = findUnsafeE2ESettings(env);
  if (problems.length > 0) {
    throw new Error(`E2E の見張り: 本番につながるおそれがあるので止めました。\n- ${problems.join('\n- ')}`);
  }
}

/** 3000番のアプリが「この設定で起動した E2E 用のもの」かを見分ける印。秘密は含めない。 */
export function computeServerFingerprint(env: EnvRecord, mode: E2EServerMode): string {
  const material = JSON.stringify({
    v: 1,
    mode,
    supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL ?? '',
    mailProvider: env.MAIL_PROVIDER ?? '',
    mailUrl: env.MAIL_LOCAL_URL ?? '',
    stripeKeyPrefix: (env.STRIPE_SECRET_KEY ?? '').slice(0, 8),
  });
  return createHash('sha256').update(material).digest('hex').slice(0, 32);
}

/** 3000番を使い回すか。使い回せないアプリが動いていれば止める。 */
export function decideServerReuse(probe: ServerProbe, expectedFingerprint: string, strict: boolean): boolean {
  if (probe.kind === 'down') return false;
  if (probe.fingerprint !== expectedFingerprint) {
    throw new Error(
      'E2E の見張り: 3000番で、この E2E が手元の設定で起動したものではないアプリが動いています（普段の開発サーバーなど）。止めてから流してください。',
    );
  }
  if (strict) {
    throw new Error(
      'E2E の見張り: E2E_STRICT=1 では起動済みのアプリを使い回しません。3000番のアプリを止めてから流してください。',
    );
  }
  return true;
}

function runSupabaseStatus(): string {
  return execFileSync('npx', ['supabase', 'status', '-o', 'json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: process.platform === 'win32',
    timeout: 60_000,
  });
}

/** 手元の Supabase の状態を読む。読めなければ（Docker や Supabase が止まっている）、起動を促して止める。 */
export function readLocalSupabaseStatus(run: () => string = runSupabaseStatus): LocalSupabaseStatus {
  let output: string;
  try {
    output = run();
  } catch {
    throw new Error(
      'E2E の見張り: 手元の Supabase の状態を読めません。Docker を起動し、npx supabase start で手元の Supabase を起動してください。',
    );
  }
  return parseSupabaseStatus(output);
}

// 設定の読み込みは同期なので、別の node で3000番の印を読む。
const PROBE_SCRIPT = [
  'fetch(process.argv[1], { signal: AbortSignal.timeout(3000) })',
  '  .then(async (res) => {',
  '    const body = res.ok ? await res.json().catch(() => ({})) : {};',
  "    const fingerprint = typeof body.fingerprint === 'string' ? body.fingerprint : null;",
  "    process.stdout.write(JSON.stringify({ kind: 'up', fingerprint }));",
  '  })',
  "  .catch(() => process.stdout.write(JSON.stringify({ kind: 'down' })));",
].join('\n');

export function probeServer(baseUrl: string): ServerProbe {
  const target = new URL('/api/e2e/server-info', baseUrl).toString();
  const output = execFileSync(process.execPath, ['-e', PROBE_SCRIPT, target], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  return JSON.parse(output) as ServerProbe;
}

export function prepareE2EEnvironment(options: {
  baseEnv: EnvRecord;
  mode: E2EServerMode;
  strict: boolean;
  isWorker: boolean;
  baseUrl: string;
  readStatus?: () => LocalSupabaseStatus;
  probe?: (baseUrl: string) => ServerProbe;
}): { env: Record<string, string>; reuseExistingServer: boolean } {
  if (options.isWorker) {
    // Playwright の worker は設定を読み直す。本体のプロセスが上書きした値を受け継いでいるので、確かめるだけにする。
    assertSafeE2EEnv(options.baseEnv);
    return { env: {}, reuseExistingServer: false };
  }

  const overrides = buildE2EOverrides((options.readStatus ?? readLocalSupabaseStatus)());
  const merged: EnvRecord = { ...options.baseEnv, ...overrides };
  assertSafeE2EEnv(merged);

  const fingerprint = computeServerFingerprint(merged, options.mode);
  const probe = (options.probe ?? probeServer)(options.baseUrl);
  return {
    env: { ...overrides, E2E_SERVER_FINGERPRINT: fingerprint },
    reuseExistingServer: decideServerReuse(probe, fingerprint, options.strict),
  };
}
```

- [ ] **Step 4: テストが通ることを確かめる**

Run: `npx jest tests/unit/scripts/e2e/environment.test.ts`
Expected: PASS（35件）

Run: `npm run typecheck`
Expected: エラー0

- [ ] **Step 5: コミット**

```bash
git add scripts/e2e/environment.ts tests/unit/scripts/e2e/environment.test.ts
git commit -m "$(cat <<'EOF'
feat(e2e): 手元の Supabase で流すための環境づくりと見張りを足す

npx supabase status から手元の住所と鍵を読み、.env.local の本番の Supabase・
Resend の鍵を上書きする。本番の住所・本番の鍵・外へのメールなら止め、3000番の
アプリは同じ印を返すものだけ使い回す。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: E2E 用に起動したアプリだけが印を返す入口

設計書 7-3 の「印で確かめる」。`E2E_SERVER_FINGERPRINT` を持つ起動（E2E 用）だけが印を返す。本番と普段の開発では 404 を返し、何も明かさない。

**Files:**
- Create: `src/app/api/e2e/server-info/route.ts`
- Test: `tests/unit/api/e2e/server-info-route.test.ts`

**Interfaces:**
- Consumes: 環境変数 `E2E_SERVER_FINGERPRINT`（Task 2 の `prepareE2EEnvironment` が作る）
- Produces: `GET /api/e2e/server-info` → 200 `{ fingerprint: string }`（`Cache-Control: no-store`）または 404 `{ error: 'Not found' }`

- [ ] **Step 1: テストを書く**

`tests/unit/api/e2e/server-info-route.test.ts`:

```ts
jest.mock('next/server', () => {
  const actual = jest.requireActual('next/server');
  return {
    ...actual,
    NextResponse: {
      json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
        status: init?.status ?? 200,
        body,
        headers: init?.headers ?? {},
      }),
    },
  };
});

import { GET } from '@/app/api/e2e/server-info/route';

describe('GET /api/e2e/server-info', () => {
  const original = process.env.E2E_SERVER_FINGERPRINT;

  afterEach(() => {
    if (original === undefined) delete process.env.E2E_SERVER_FINGERPRINT;
    else process.env.E2E_SERVER_FINGERPRINT = original;
  });

  it('E2E 用の印が無い起動（本番・普段の開発）では 404 を返し、何も明かさない', () => {
    delete process.env.E2E_SERVER_FINGERPRINT;
    expect(GET()).toEqual({ status: 404, body: { error: 'Not found' }, headers: {} });
  });

  it('E2E 用に起動したアプリは印を返し、保存させない', () => {
    process.env.E2E_SERVER_FINGERPRINT = 'abc123';
    expect(GET()).toEqual({
      status: 200,
      body: { fingerprint: 'abc123' },
      headers: { 'Cache-Control': 'no-store' },
    });
  });
});
```

- [ ] **Step 2: テストが落ちることを確かめる**

Run: `npx jest tests/unit/api/e2e/server-info-route.test.ts`
Expected: FAIL（`Cannot find module '@/app/api/e2e/server-info/route'`）

- [ ] **Step 3: 入口を作る**

`src/app/api/e2e/server-info/route.ts`:

```ts
import { NextResponse } from 'next/server';

// 起動時の環境変数を毎回読む（ビルド時に固めない）。
export const dynamic = 'force-dynamic';

/**
 * E2E の見張りが、3000番のアプリが E2E 用の設定で起動したものかを確かめる（設計書 2026-10-05 グループ B の 7-3）。
 * E2E_SERVER_FINGERPRINT が無い起動（本番・普段の開発）では 404 を返し、何も明かさない。
 * 印は設定から作ったハッシュで、秘密は含まない。
 */
export function GET() {
  const fingerprint = process.env.E2E_SERVER_FINGERPRINT;
  if (!fingerprint) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  return NextResponse.json({ fingerprint }, { headers: { 'Cache-Control': 'no-store' } });
}
```

- [ ] **Step 4: テストが通ることを確かめる**

Run: `npx jest tests/unit/api/e2e/server-info-route.test.ts`
Expected: PASS（2件）

Run: `npm run typecheck && npx eslint src/app/api/e2e`
Expected: エラー0

- [ ] **Step 5: コミット**

```bash
git add src/app/api/e2e/server-info/route.ts tests/unit/api/e2e/server-info-route.test.ts
git commit -m "$(cat <<'EOF'
feat(e2e): E2E 用に起動したアプリだけが印を返す入口を足す

E2E_SERVER_FINGERPRINT を持つ起動だけが印を返し、本番と普段の開発では 404。
見張りが3000番のアプリを使い回してよいかを確かめるのに使う。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Playwright の設定と起動スクリプトをつなぐ

設計書 7-2・7-3。設定の読み込みで環境づくりを呼び、手元の値をアプリとテストの両方に渡す。起動スクリプトはビルドの前にもう一度見張り、使い回すアプリの印を確かめる。結果は「前」と比べられるよう JSON でも残す（Task 6 が読む）。

**Files:**
- Modify: `playwright.config.ts`（import・環境づくり・`reporter`・`webServer`）
- Modify: `scripts/e2e-server.mjs`（冒頭の説明・見張り・使い回しの確かめ）

**Interfaces:**
- Consumes: Task 2 の `prepareE2EEnvironment`、Task 3 の `GET /api/e2e/server-info`
- Produces: E2E の実行のたびに `test-results/e2e-results.json`（Playwright の JSON レポート）。webServer と各 worker の環境変数に、手元の値と `E2E_SERVER_FINGERPRINT`

- [ ] **Step 1: 設定を書き換える**

`playwright.config.ts` の先頭（import から `const resolvedBaseUrl` まで）を次に置き換える:

```ts
import { defineConfig, devices } from '@playwright/test';
import { loadEnvConfig } from '@next/env';
import { prepareE2EEnvironment } from './scripts/e2e/environment';

// アプリと同じ .env 解決規則（.env.local > .env）でテストプロセスにも環境変数を読み込む。
// これが無いと spec 側の process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY が undefined になり、
// Turnstile トークンの注入が丸ごとスキップされて送信がクライアント側で止まる。
loadEnvConfig(process.cwd());

const resolvedBaseUrl = 'http://localhost:3000';

/*
 * E2E は手元の Supabase に対して流す（設計書 2026-10-05 グループ B の第7章）。
 * 手元の Supabase の住所と鍵で .env.local の値を上書きし、本番の Supabase の鍵と Resend の鍵は
 * アプリにもテストにも渡さない。本番につながるおそれのある設定や、確かめられない3000番のアプリが
 * あれば、ここで理由を出して止まる。worker は本体が上書きした値を受け継ぐので、確かめるだけにする。
 */
const e2e = prepareE2EEnvironment({
  baseEnv: process.env,
  mode: process.env.E2E_DEV_SERVER === '1' ? 'dev' : 'start',
  strict: process.env.E2E_STRICT === '1',
  isWorker: process.env.TEST_WORKER_INDEX !== undefined,
  baseUrl: resolvedBaseUrl,
});
Object.assign(process.env, e2e.env);
```

同じファイルの `reporter: 'html',` を次に置き換える:

```ts
  /*
   * html は今までどおり。json は切り替えの前後を比べるため（npm run e2e:compare が読む）。
   * test-results は実行のたびに消えるので、最後の実行の結果だけが残る。
   */
  reporter: [['html'], ['json', { outputFile: 'test-results/e2e-results.json' }]],
```

同じファイルの `webServer` の塊（説明のコメントを含む）を次に置き換える:

```ts
  /*
   * E2E は本番ビルドに対して実行する。scripts/e2e-server.mjs が build して起動し、
   * 起動したサーバーはテスト終了後も動いたまま残る。
   * 3000番で動いているアプリは、見張りが「この設定で起動した E2E 用のもの」と確かめたときだけ使い回す。
   * ゲート実行（pre-push）では E2E_STRICT=1 を立て、使い回さずに必ずビルドから起動する。
   * dev サーバーで動かすデバッグ用途のみ E2E_DEV_SERVER=1 を付ける。
   */
  webServer: {
    command: 'node scripts/e2e-server.mjs',
    url: resolvedBaseUrl,
    reuseExistingServer: e2e.reuseExistingServer,
    env: e2e.env,
    /* next build を含むので長めに取る。 */
    timeout: 600_000,
    stdout: 'pipe',
  },
```

- [ ] **Step 2: 起動スクリプトに見張りを足す**

`scripts/e2e-server.mjs` の冒頭の説明コメントの最後の段落（「起動済みのサーバーを使い回す場合は、…」の4行）を次に置き換える:

```js
 * 3000番で動いているアプリを使い回すのは、/api/e2e/server-info が返す印が
 * playwright.config.ts の作った印（E2E_SERVER_FINGERPRINT）と同じときだけ。
 * 印を返さないアプリ（普段の開発サーバーなど）や違う印のアプリなら、止めて理由を出す。
```

同じファイルの `const SERVER_ENV = …;` の行の直後に、次を足す:

```js
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isLocalUrl(raw) {
  try {
    return LOCAL_HOSTNAMES.has(new URL(raw).hostname);
  } catch {
    return false;
  }
}

/**
 * 見張り（設計書 2026-10-05 グループ B の 7-3）。playwright.config.ts と同じ条件のうち、
 * 本番の DB・外へのメールにつながるものを、ビルドの前にもう一度確かめる。
 * playwright.config.ts を通さずにこのスクリプトを直接動かしたときの守りでもある。
 */
function findUnsafeSettings(env) {
  const problems = [];
  if (!isLocalUrl(env.NEXT_PUBLIC_SUPABASE_URL)) problems.push("NEXT_PUBLIC_SUPABASE_URL が手元（localhost）ではない");
  if (!isLocalUrl(env.SUPABASE_URL)) problems.push("SUPABASE_URL が手元（localhost）ではない");
  if (!/^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY ?? "")) problems.push("STRIPE_SECRET_KEY がテスト用（sk_test_ / rk_test_）ではない");
  if (env.MAIL_PROVIDER !== "local") problems.push("MAIL_PROVIDER が local ではない");
  if (!isLocalUrl(env.MAIL_LOCAL_URL)) problems.push("MAIL_LOCAL_URL が手元（localhost）ではない");
  if (env.RESEND_API_KEY) problems.push("RESEND_API_KEY が空ではない");
  if (!env.E2E_SERVER_FINGERPRINT) problems.push("E2E_SERVER_FINGERPRINT が無い（playwright.config.ts を通さずに起動した）");
  return problems;
}

const problems = findUnsafeSettings(process.env);
if (problems.length > 0) {
  console.error(`[e2e-server] 見張り: 本番につながるおそれがあるので起動しない。\n- ${problems.join("\n- ")}`);
  process.exit(1);
}

/** 3000番のアプリが返す印。印を返さないアプリなら null。 */
async function runningFingerprint() {
  try {
    const res = await fetch(`${BASE_URL}/api/e2e/server-info`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body.fingerprint === "string" ? body.fingerprint : null;
  } catch {
    return null;
  }
}
```

同じファイルの次の3行:

```js
if (await isUp()) {
  console.log(`${BASE_URL} は起動済み。そのまま使う。`);
} else {
```

を次に置き換える:

```js
if (await isUp()) {
  if ((await runningFingerprint()) !== process.env.E2E_SERVER_FINGERPRINT) {
    console.error(
      `[e2e-server] 見張り: ${BASE_URL} で、この E2E が手元の設定で起動したものではないアプリが動いている。止めてから流して。`,
    );
    process.exit(1);
  }
  console.log(`${BASE_URL} は E2E 用に起動済み。そのまま使う。`);
} else {
```

- [ ] **Step 3: 型と lint を確かめる**

Run: `npm run typecheck && npx eslint playwright.config.ts scripts/e2e-server.mjs scripts/e2e`
Expected: エラー0

- [ ] **Step 4: 手元の Supabase で1件流す**

先に3000番が空いていることと、手元の Supabase が動いていることを確かめる:

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
docker inspect -f '{{.State.Health.Status}}' supabase_db_o_official
```

Expected: 1行目は何も出ない。2行目は `healthy`。

Run: `E2E_STRICT=1 npx playwright test e2e/FR-ABOUT-001-brand-philosophy-section.spec.ts`
Expected: ビルドの後に PASS。`test-results/e2e-results.json` ができている。

- [ ] **Step 5: 起動したアプリが手元につながり、印を返すことを確かめる**

```bash
curl -s http://localhost:3000/api/e2e/server-info
```

Expected: `{"fingerprint":"<16進32文字>"}`

```bash
node -e "const j=require('./test-results/e2e-results.json'); console.log(j.stats)"
```

Expected: `expected: 3`（3つの画面幅）、`unexpected: 0`

- [ ] **Step 6: 使い回しと見張りを確かめる**

起動したアプリが動いたままで、もう一度流す（使い回すはず）:

Run: `npx playwright test e2e/FR-ABOUT-001-brand-philosophy-section.spec.ts`
Expected: ビルドせずに PASS（ログにビルドが出ない）

E2E_STRICT=1 では使い回さずに止まることを確かめる:

Run: `E2E_STRICT=1 npx playwright test e2e/FR-ABOUT-001-brand-philosophy-section.spec.ts`
Expected: `E2E の見張り: E2E_STRICT=1 では起動済みのアプリを使い回しません。` で止まる

3000番のアプリを止める（E2E が起動したものだけ。PID は表示されたものを使う）:

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen | Select-Object -ExpandProperty OwningProcess
Stop-Process -Id <上で表示された PID>
```

起動スクリプトを直接、本番の住所で動かすと止まることを確かめる（ビルドの前に止まる）:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co SUPABASE_URL=https://example.supabase.co \
MAIL_PROVIDER=local MAIL_LOCAL_URL=http://127.0.0.1:54324 STRIPE_SECRET_KEY=sk_test_x \
E2E_SERVER_FINGERPRINT=x node scripts/e2e-server.mjs; echo "exit=$?"
```

Expected: `[e2e-server] 見張り: 本番につながるおそれがあるので起動しない。` と `NEXT_PUBLIC_SUPABASE_URL が手元（localhost）ではない` が出て `exit=1`

手元の Supabase が止まっているときの文言は Task 2 のテスト（`readLocalSupabaseStatus` の「状態を読めない」）で確かめた。DB 結合テストなどで使っている手元の Supabase は止めない。

- [ ] **Step 7: コミット**

```bash
git add playwright.config.ts scripts/e2e-server.mjs
git commit -m "$(cat <<'EOF'
feat(e2e): Playwright と起動スクリプトを手元の Supabase につなぎ、見張りを入れる

設定の読み込みで手元の住所と鍵を読み、アプリとテストに渡す。起動スクリプトは
ビルドの前にもう一度見張り、使い回すアプリの印を確かめる。前後を比べるため
結果を test-results/e2e-results.json にも残す。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: 見本データ（架空の商品・ルック・ニュース・取扱店と、手元の仮の画像）

設計書 7-4・7-7。形（件数・分類・状態・つながり）は 2026-10-05 時点の本番の公開データに合わせ、中身はすべて架空にする。根拠は `.superpowers/sdd/2026-10-05-webhook-queue-operations/seed-requirements.md`（「前」に通っていたテストが DB の何を前提にしているかの調べ）。要点:

- 検索のテストは、一覧の先頭の商品名の最初の語で検索する。先頭（いちばん新しい商品）を「Aoi Linen Tunic」にし、ルック1とニュース1にも「Aoi」を入れる
- 取扱店の地域のテストは、住所の頭の都府県と「Aoyama」の名前を見る
- `FR-SEARCH-007`（「前」に通過）は、検索結果の画像が Storage の署名つき URL で、実際に表示されることを確かめる。だから画像は `placehold.co` ではなく、手元の Storage に置いた仮の画像にする（Storage の API でしか置けないので、E2E の前に置く）
- Next.js 16 は手元の住所の画像の最適化を既定で止めるので、手元の Supabase につないだビルドのときだけ許す

**Files:**
- Create: `supabase/seed.sql`
- Create: `scripts/e2e/seed-storage.ts`、`scripts/e2e/global-setup.ts`
- Modify: `playwright.config.ts`（`globalSetup`）
- Modify: `next.config.ts`（手元の Storage の画像）
- Modify: `supabase/config.toml`（Auth の戻り先）
- Test: `tests/unit/scripts/e2e/seed-storage.test.ts`

**Interfaces:**
- Consumes: Task 2 の `isLocalUrl`・`EnvRecord`、Task 4 の `playwright.config.ts`
- Produces（`scripts/e2e/seed-storage.ts`）:
  - `export const SEED_IMAGE_PNG_BASE64: string`（12×16 の薄い灰色の PNG）
  - `export const SEED_STORAGE_OBJECTS: ReadonlyArray<{ bucket: string; path: string }>`（40件）
  - `export type StorageClient = { storage: { from(bucket: string): { upload(path: string, body: Buffer, options: { contentType: string; upsert: boolean }): Promise<{ error: { message: string } | null }> } } }`
  - `export async function seedLocalStorage(env: EnvRecord, makeClient?: (url: string, key: string) => StorageClient): Promise<number>`

- [ ] **Step 1: 仮の画像を置く仕組みのテストを書く**

`tests/unit/scripts/e2e/seed-storage.test.ts`:

```ts
/** @jest-environment node */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SEED_IMAGE_PNG_BASE64,
  SEED_STORAGE_OBJECTS,
  seedLocalStorage,
  type StorageClient,
} from '@/../scripts/e2e/seed-storage';

const localEnv = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_SERVICE_ROLE_KEY: 'local-service-role-key',
};

function fakeClient(result: { error: { message: string } | null } = { error: null }) {
  const upload = jest.fn().mockResolvedValue(result);
  const from = jest.fn(() => ({ upload }));
  const client: StorageClient = { storage: { from } };
  return { client, from, upload };
}

describe('seedLocalStorage', () => {
  it('見本データが指す40件の画像を、上書きで置く', async () => {
    const { client, from, upload } = fakeClient();
    const makeClient = jest.fn(() => client);

    await expect(seedLocalStorage(localEnv, makeClient)).resolves.toBe(40);

    expect(makeClient).toHaveBeenCalledWith('http://127.0.0.1:54321', 'local-service-role-key');
    expect(upload).toHaveBeenCalledTimes(40);
    expect(from).toHaveBeenCalledWith('item-images');
    expect(from).toHaveBeenCalledWith('look-images');
    expect(from).toHaveBeenCalledWith('news-images');
    const [path, body, options] = upload.mock.calls[0];
    expect(path).toBe('e2e/item-1-1.png');
    expect(Buffer.compare(body, Buffer.from(SEED_IMAGE_PNG_BASE64, 'base64'))).toBe(0);
    expect(options).toEqual({ contentType: 'image/png', upsert: true });
  });

  it('手元でない Supabase には置かない', async () => {
    const { client } = fakeClient();
    const makeClient = jest.fn(() => client);
    await expect(
      seedLocalStorage({ ...localEnv, NEXT_PUBLIC_SUPABASE_URL: 'https://prodproject.supabase.co' }, makeClient),
    ).rejects.toThrow('手元の Supabase 以外には見本の画像を置きません');
    expect(makeClient).not.toHaveBeenCalled();
  });

  it('置けなかったら、どの画像かを言って止める', async () => {
    const { client } = fakeClient({ error: { message: 'Bucket not found' } });
    await expect(seedLocalStorage(localEnv, () => client)).rejects.toThrow(
      'item-images/e2e/item-1-1.png（Bucket not found）',
    );
  });

  it('PNG の頭（署名）を持つ', () => {
    expect(Buffer.from(SEED_IMAGE_PNG_BASE64, 'base64').subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it('seed.sql が指す画像と、置く画像の一覧が一致する', () => {
    const seed = readFileSync(join(process.cwd(), 'supabase', 'seed.sql'), 'utf8');
    const referenced = new Set(seed.match(/e2e\/(?:item|look|news)-[0-9-]+\.png/g) ?? []);
    const placed = new Set(SEED_STORAGE_OBJECTS.map((object) => object.path));
    expect([...referenced].sort()).toEqual([...placed].sort());
    for (const object of SEED_STORAGE_OBJECTS) {
      const kind = object.path.slice('e2e/'.length).split('-')[0];
      expect(object.bucket).toBe(`${kind}-images`);
    }
  });
});
```

- [ ] **Step 2: テストが落ちることを確かめる**

Run: `npx jest tests/unit/scripts/e2e/seed-storage.test.ts`
Expected: FAIL（`Cannot find module '@/../scripts/e2e/seed-storage'`）

- [ ] **Step 3: 仮の画像を置く仕組みを作る**

`scripts/e2e/seed-storage.ts`:

```ts
/**
 * 手元の Supabase の Storage に、見本データ（supabase/seed.sql）が指す仮の画像を置く（設計書 2026-10-05 グループ B の 7-4）。
 * seed.sql は表の行と bucket を作るが、画像の中身（ファイル）は Storage の API でしか置けないので、E2E の前にここで置く。
 * 何度動かしても同じ結果になる（upsert）。手元以外の住所なら置かずに止める。
 */
import { createClient } from '@supabase/supabase-js';
import { isLocalUrl, type EnvRecord } from './environment';

/** 12×16 の薄い灰色の PNG（架空の画像） */
export const SEED_IMAGE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAwAAAAQCAIAAACtAwlQAAAAFUlEQVR42mO4dvkMQcQwqmhUEXGKAJ+/19DGXw+VAAAAAElFTkSuQmCC';

const ITEM_IDS = [1, 3, 4, 5, 6, 7, 8, 9, 10];
const LOOK_IDS = [1, 2, 3, 4, 5, 6, 7];
const NEWS_IDS = [1, 2, 3, 4, 5, 6, 7, 8];

/** seed.sql の行が指す画像（bucket ごとの相対パス）。seed.sql を変えたら、ここも変える（テストが食い違いを止める）。 */
export const SEED_STORAGE_OBJECTS: ReadonlyArray<{ bucket: string; path: string }> = [
  ...ITEM_IDS.flatMap((id) => [1, 2].map((n) => ({ bucket: 'item-images', path: `e2e/item-${id}-${n}.png` }))),
  ...LOOK_IDS.flatMap((id) => [1, 2].map((n) => ({ bucket: 'look-images', path: `e2e/look-${id}-${n}.png` }))),
  ...NEWS_IDS.map((id) => ({ bucket: 'news-images', path: `e2e/news-${id}.png` })),
];

export type StorageClient = {
  storage: {
    from(bucket: string): {
      upload(
        path: string,
        body: Buffer,
        options: { contentType: string; upsert: boolean },
      ): Promise<{ error: { message: string } | null }>;
    };
  };
};

function createStorageClient(url: string, key: string): StorageClient {
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as StorageClient;
}

export async function seedLocalStorage(
  env: EnvRecord,
  makeClient: (url: string, key: string) => StorageClient = createStorageClient,
): Promise<number> {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !isLocalUrl(url)) {
    throw new Error('E2E の見張り: 手元の Supabase 以外には見本の画像を置きません。');
  }

  const client = makeClient(url, key);
  const body = Buffer.from(SEED_IMAGE_PNG_BASE64, 'base64');
  for (const object of SEED_STORAGE_OBJECTS) {
    const { error } = await client.storage
      .from(object.bucket)
      .upload(object.path, body, { contentType: 'image/png', upsert: true });
    if (error) {
      throw new Error(`見本の画像を置けませんでした: ${object.bucket}/${object.path}（${error.message}）`);
    }
  }
  return SEED_STORAGE_OBJECTS.length;
}
```

`scripts/e2e/global-setup.ts`:

```ts
import { seedLocalStorage } from './seed-storage';

/** E2E の前に、手元の Storage に見本の画像を置く。npx supabase db reset で消えるので毎回置き直す。 */
export default async function globalSetup(): Promise<void> {
  const count = await seedLocalStorage(process.env);
  console.log(`[e2e] 手元の Storage に見本の画像を ${count} 件置いた`);
}
```

- [ ] **Step 4: 見本データを書く**

`supabase/seed.sql`:

```sql
-- 手元の Supabase の見本データ（設計書 2026-10-05 グループ B の 7-4）。
-- npx supabase db reset のたびに、移行の後に入る。すべて架空の値で、お客様・管理者のアカウント、
-- 注文、個人情報は入れない。形（件数・分類・状態・つながり）は 2026-10-05 時点の本番の公開データに合わせた。
-- 画像の中身は scripts/e2e/seed-storage.ts が E2E の前に Storage へ置く（ここでは bucket と行だけ作る）。
-- 画像のパスを変えたら、scripts/e2e/seed-storage.ts の一覧も変える（tests/unit/scripts/e2e/seed-storage.test.ts が食い違いを止める）。

INSERT INTO storage.buckets (id, name, public) VALUES
  ('item-images', 'item-images', false),
  ('look-images', 'look-images', false),
  ('news-images', 'news-images', false)
ON CONFLICT (id) DO NOTHING;

-- 商品: 9件（公開7・非公開2）。番号と価格と分類は本番の形に合わせる。
-- 検索のテストは一覧の先頭（いちばん新しい商品）の名前の最初の語で検索するので、商品1の名前を「Aoi」で始める。
INSERT INTO public.items (
  id, name, description, price, category, image_url, image_urls, colors, sizes,
  product_details, status, created_at, updated_at, made_to_order_lead_days
) VALUES
  (1, 'Aoi Linen Tunic', 'Aoi sample linen tunic for local E2E.', 89000, 'TOPS',
   'e2e/item-1-1.png', ARRAY['e2e/item-1-1.png', 'e2e/item-1-2.png'],
   '[{"name":"Natural","hex":"#d8d0c5"}]'::jsonb, ARRAY['FREE', 'M'],
   'Synthetic linen sample. No real material or vendor claim.', 'published',
   '2026-06-07T12:00:00Z', '2026-06-07T12:00:00Z', NULL),
  (3, 'Mizu Wide Trousers', 'Synthetic wide trousers for local E2E.', 20999, 'BOTTOMS',
   'e2e/item-3-1.png', ARRAY['e2e/item-3-1.png', 'e2e/item-3-2.png'],
   '[{"name":"Navy","hex":"#34465e"}]'::jsonb, ARRAY['1'],
   'Synthetic product details.', 'published',
   '2026-06-06T12:00:00Z', '2026-06-06T12:00:00Z', NULL),
  (4, 'Nagi Cotton Shirt', 'Synthetic cotton shirt for local E2E.', 24800, 'TOPS',
   'e2e/item-4-1.png', ARRAY['e2e/item-4-1.png', 'e2e/item-4-2.png'],
   '[{"name":"Clay","hex":"#b87961"}]'::jsonb, ARRAY['1'],
   'Synthetic product details.', 'published',
   '2026-06-05T12:00:00Z', '2026-06-05T12:00:00Z', NULL),
  (5, 'Sora Relaxed Pants', 'Synthetic relaxed pants for local E2E.', 34800, 'BOTTOMS',
   'e2e/item-5-1.png', ARRAY['e2e/item-5-1.png', 'e2e/item-5-2.png'],
   '[{"name":"Charcoal","hex":"#424242"}]'::jsonb, ARRAY['2'],
   'Synthetic product details.', 'published',
   '2026-06-04T12:00:00Z', '2026-06-04T12:00:00Z', NULL),
  (6, 'Kiri Wool Coat', 'Synthetic wool coat for local E2E.', 49800, 'OUTERWEAR',
   'e2e/item-6-1.png', ARRAY['e2e/item-6-1.png', 'e2e/item-6-2.png'],
   '[{"name":"Moss","hex":"#59634f"},{"name":"Stone","hex":"#928b7d"}]'::jsonb, ARRAY['1'],
   'Synthetic product details.', 'published',
   '2026-06-03T12:00:00Z', '2026-06-03T12:00:00Z', NULL),
  (7, 'Tsubame Brass Brooch', 'Synthetic brass-tone brooch for local E2E.', 10000, 'ACCESSORIES',
   'e2e/item-7-1.png', ARRAY['e2e/item-7-1.png', 'e2e/item-7-2.png'],
   '[{"name":"Brass","hex":"#a77c40"}]'::jsonb, ARRAY['FREE'],
   'Synthetic product details.', 'published',
   '2026-06-02T12:00:00Z', '2026-06-02T12:00:00Z', NULL),
  (8, 'Yoru Private Tee', 'Synthetic unpublished sample.', 1, 'TOPS',
   'e2e/item-8-1.png', ARRAY['e2e/item-8-1.png', 'e2e/item-8-2.png'],
   '[{"name":"Sage","hex":"#697765"}]'::jsonb, ARRAY['FREE'],
   'Synthetic private product details.', 'private',
   '2026-05-29T12:00:00Z', '2026-05-29T12:00:00Z', NULL),
  (9, 'Aoi Sample Top', 'Synthetic low-price sample for sorting and search UI.', 2, 'TOPS',
   'e2e/item-9-1.png', ARRAY['e2e/item-9-1.png', 'e2e/item-9-2.png'],
   '[{"name":"Ink","hex":"#30343b"},{"name":"Sand","hex":"#cbbba3"},{"name":"Olive","hex":"#66704d"},{"name":"Cloud","hex":"#d6d6d2"}]'::jsonb,
   ARRAY['S', 'M', 'L'],
   'Synthetic sample details.', 'published',
   '2026-06-01T12:00:00Z', '2026-06-01T12:00:00Z', NULL),
  (10, 'Kohaku Private Dress', 'Synthetic unpublished sample.', 22222, 'TOPS',
   'e2e/item-10-1.png', ARRAY['e2e/item-10-1.png', 'e2e/item-10-2.png'],
   '[{"name":"Black","hex":"#242424"}]'::jsonb, ARRAY[]::text[],
   'Synthetic private product details.', 'private',
   '2026-05-28T12:00:00Z', '2026-05-28T12:00:00Z', NULL);

-- 色13・サイズ11・バリアント21（商品1は2、商品9は4色×3サイズの12、ほかは1）。在庫は本番の形どおりすべて0
-- （バリアントは在庫0でしか作れない。在庫は台帳でしか動かさない）。
INSERT INTO public.item_colors (id, item_id, name, hex, position) VALUES
  (1, 1, 'Natural', '#d8d0c5', 0), (2, 3, 'Navy', '#34465e', 0),
  (3, 4, 'Clay', '#b87961', 0), (4, 5, 'Charcoal', '#424242', 0),
  (5, 6, 'Moss', '#59634f', 0), (6, 6, 'Stone', '#928b7d', 1),
  (7, 7, 'Brass', '#a77c40', 0), (8, 8, 'Sage', '#697765', 0),
  (9, 9, 'Ink', '#30343b', 0), (10, 9, 'Sand', '#cbbba3', 1),
  (11, 9, 'Olive', '#66704d', 2), (12, 9, 'Cloud', '#d6d6d2', 3),
  (13, 10, 'Black', '#242424', 0);

INSERT INTO public.item_sizes (id, item_id, label, position) VALUES
  (1, 1, 'FREE', 0), (2, 1, 'M', 1), (3, 3, '1', 0), (4, 4, '1', 0),
  (5, 5, '2', 0), (6, 6, '1', 0), (7, 7, 'FREE', 0), (8, 8, 'FREE', 0),
  (9, 9, 'S', 0), (10, 9, 'M', 1), (11, 9, 'L', 2);

INSERT INTO public.item_variants (id, item_id, color_id, size_id, sku, stock_quantity, is_active) VALUES
  (1, 1, 1, 1, 'E2E-ITEM-1-NAT-FREE', 0, true),
  (2, 1, 1, 2, 'E2E-ITEM-1-NAT-M', 0, true),
  (3, 3, 2, 3, 'E2E-ITEM-3-NAVY-1', 0, true),
  (4, 4, 3, 4, 'E2E-ITEM-4-CLAY-1', 0, true),
  (5, 5, 4, 5, 'E2E-ITEM-5-CHARCOAL-2', 0, true),
  (6, 6, 5, 6, 'E2E-ITEM-6-MOSS-1', 0, true),
  (7, 7, 7, 7, 'E2E-ITEM-7-BRASS-FREE', 0, true),
  (8, 8, 8, 8, 'E2E-ITEM-8-SAGE-FREE', 0, true),
  (9, 9, 9, 9, 'E2E-ITEM-9-INK-S', 0, true),
  (10, 9, 9, 10, 'E2E-ITEM-9-INK-M', 0, true),
  (11, 9, 9, 11, 'E2E-ITEM-9-INK-L', 0, true),
  (12, 9, 10, 9, 'E2E-ITEM-9-SAND-S', 0, true),
  (13, 9, 10, 10, 'E2E-ITEM-9-SAND-M', 0, true),
  (14, 9, 10, 11, 'E2E-ITEM-9-SAND-L', 0, true),
  (15, 9, 11, 9, 'E2E-ITEM-9-OLIVE-S', 0, true),
  (16, 9, 11, 10, 'E2E-ITEM-9-OLIVE-M', 0, true),
  (17, 9, 11, 11, 'E2E-ITEM-9-OLIVE-L', 0, true),
  (18, 9, 12, 9, 'E2E-ITEM-9-CLOUD-S', 0, true),
  (19, 9, 12, 10, 'E2E-ITEM-9-CLOUD-M', 0, true),
  (20, 9, 12, 11, 'E2E-ITEM-9-CLOUD-L', 0, true),
  (21, 10, 13, NULL, 'E2E-ITEM-10-BLACK-NOSIZE', 0, true);

-- ルック: 7件（すべて公開）と、商品とのつながり9件。ルック1に「Aoi」を入れる（検索のテスト）。
INSERT INTO public.looks (
  id, season_year, season_type, theme, theme_description, image_urls, status, created_at, updated_at
) VALUES
  (1, 2026, 'SS', 'Aoi Weekend Layers', 'Aoi synthetic styling with linen layers.',
   ARRAY['e2e/look-1-1.png', 'e2e/look-1-2.png'], 'published', '2026-06-07T12:00:00Z', '2026-06-07T12:00:00Z'),
  (2, 2026, 'AW', 'Soft Winter Lines', 'Synthetic winter styling.',
   ARRAY['e2e/look-2-1.png', 'e2e/look-2-2.png'], 'published', '2026-06-06T12:00:00Z', '2026-06-06T12:00:00Z'),
  (3, 2027, 'SS', 'Quiet Morning Form', 'Synthetic spring styling.',
   ARRAY['e2e/look-3-1.png', 'e2e/look-3-2.png'], 'published', '2026-06-05T12:00:00Z', '2026-06-05T12:00:00Z'),
  (4, 2027, 'AW', 'Stone and Thread', 'Synthetic autumn styling.',
   ARRAY['e2e/look-4-1.png', 'e2e/look-4-2.png'], 'published', '2026-06-04T12:00:00Z', '2026-06-04T12:00:00Z'),
  (5, 2028, 'SS', 'Light Between Leaves', 'Synthetic spring styling.',
   ARRAY['e2e/look-5-1.png', 'e2e/look-5-2.png'], 'published', '2026-06-03T12:00:00Z', '2026-06-03T12:00:00Z'),
  (6, 2028, 'AW', 'Evening Haze', 'Synthetic winter styling.',
   ARRAY['e2e/look-6-1.png', 'e2e/look-6-2.png'], 'published', '2026-06-02T12:00:00Z', '2026-06-02T12:00:00Z'),
  (7, 2028, 'AW', 'Paper Moon', 'Synthetic winter styling.',
   ARRAY['e2e/look-7-1.png', 'e2e/look-7-2.png'], 'published', '2026-06-01T12:00:00Z', '2026-06-01T12:00:00Z');

INSERT INTO public.look_items (look_id, item_id) VALUES
  (1, 1), (1, 3), (2, 1), (3, 1), (4, 1), (5, 7), (5, 10), (6, 10), (7, 8);

-- ニュース: 8件（すべて公開）。分類は COLLECTION×4・EVENT・COLLABORATION・SUSTAINABILITY・STORE、日付はすべて違う。
INSERT INTO public.news_articles (
  id, title, category, published_date, image_url, content, detailed_content, status, created_at, updated_at
) VALUES
  (1, 'Aoi Textile Studio Collection', 'COLLECTION', '2026-05-14', 'e2e/news-1.png',
   'Aoi is a synthetic collection story for local search.', 'Synthetic article body. No real event or person.',
   'published', '2026-05-14T12:00:00Z', '2026-05-14T12:00:00Z'),
  (2, 'Synthetic Collection Note', 'COLLECTION', '2026-04-22', 'e2e/news-2.png',
   'A fictional collection note.', 'Synthetic article body.',
   'published', '2026-04-22T12:00:00Z', '2026-04-22T12:00:00Z'),
  (3, 'Synthetic Event Notice', 'EVENT', '2026-03-08', 'e2e/news-3.png',
   'Fictional event text.', 'Synthetic event detail.',
   'published', '2026-03-08T12:00:00Z', '2026-03-08T12:00:00Z'),
  (4, 'Synthetic Collaboration Story', 'COLLABORATION', '2026-01-11', 'e2e/news-4.png',
   'Fictional collaboration text.', 'Synthetic collaboration detail.',
   'published', '2026-01-11T12:00:00Z', '2026-01-11T12:00:00Z'),
  (5, 'Synthetic Sustainability Note', 'SUSTAINABILITY', '2025-11-03', 'e2e/news-5.png',
   'Fictional sustainability text.', 'Synthetic sustainability detail.',
   'published', '2025-11-03T12:00:00Z', '2025-11-03T12:00:00Z'),
  (6, 'Synthetic Store Letter', 'STORE', '2025-08-20', 'e2e/news-6.png',
   'Fictional store text.', 'Synthetic store detail.',
   'published', '2025-08-20T12:00:00Z', '2025-08-20T12:00:00Z'),
  (7, 'Synthetic Collection Journal', 'COLLECTION', '2025-04-10', 'e2e/news-7.png',
   'Fictional journal text.', 'Synthetic journal detail.',
   'published', '2025-04-10T12:00:00Z', '2025-04-10T12:00:00Z'),
  (8, 'Synthetic Collection Archive', 'COLLECTION', '2025-01-15', 'e2e/news-8.png',
   'Fictional archive text.', 'Synthetic archive detail.',
   'published', '2025-01-15T12:00:00Z', '2025-01-15T12:00:00Z');

-- 取扱店: 6件（すべて公開）。種類は SELECT SHOP×3・STORE×2・FLAGSHIP STORE×1。
-- 地域のテストは住所の頭の都府県と「Aoyama」の名前を見る。電話番号は架空の 000-0000-0000。
INSERT INTO public.stockists (id, type, name, address, phone, time, holiday, status) VALUES
  (1, 'SELECT SHOP', 'Aoyama Sample Select', '東京都港区南青山0-0-1', '000-0000-0000', '11:00-18:00', 'Synthetic schedule', 'published'),
  (2, 'SELECT SHOP', 'Osaka Sample Select', '大阪府大阪市中央区0-0-1', '000-0000-0000', '11:00-18:00', 'Synthetic schedule', 'published'),
  (3, 'SELECT SHOP', 'Kyoto Sample Select', '京都府京都市中京区0-0-1', '000-0000-0000', '11:00-18:00', 'Synthetic schedule', 'published'),
  (4, 'STORE', 'Ginza Sample Store', '東京都中央区銀座0-0-1', '000-0000-0000', '11:00-18:00', 'Synthetic schedule', 'published'),
  (5, 'STORE', 'Kobe Sample Store', '兵庫県神戸市中央区0-0-1', '000-0000-0000', '11:00-18:00', 'Synthetic schedule', 'published'),
  (6, 'FLAGSHIP STORE', 'Tokyo Synthetic Flagship', '東京都渋谷区0-0-1', '000-0000-0000', '11:00-18:00', 'Synthetic schedule', 'published');

-- 番号を明示して入れたので、次に作る行の番号が重ならないよう進める（DB 結合テストが番号を決め打ちせずに作るため）。
SELECT setval(pg_get_serial_sequence('public.items', 'id'), (SELECT max(id) FROM public.items), true);
SELECT setval(pg_get_serial_sequence('public.item_colors', 'id'), (SELECT max(id) FROM public.item_colors), true);
SELECT setval(pg_get_serial_sequence('public.item_sizes', 'id'), (SELECT max(id) FROM public.item_sizes), true);
SELECT setval(pg_get_serial_sequence('public.item_variants', 'id'), (SELECT max(id) FROM public.item_variants), true);
SELECT setval(pg_get_serial_sequence('public.looks', 'id'), (SELECT max(id) FROM public.looks), true);
SELECT setval(pg_get_serial_sequence('public.news_articles', 'id'), (SELECT max(id) FROM public.news_articles), true);
SELECT setval(pg_get_serial_sequence('public.stockists', 'id'), (SELECT max(id) FROM public.stockists), true);
```

- [ ] **Step 5: テストが通ることを確かめる**

Run: `npx jest tests/unit/scripts/e2e/seed-storage.test.ts`
Expected: PASS（5件。最後のテストが seed.sql と一覧の一致を確かめる）

- [ ] **Step 6: 手元の Storage の画像を、手元の Supabase につないだビルドだけで許す**

`next.config.ts` の `const skipBuildChecks = …;` の行の直後に足す:

```ts

/*
 * 手元の Supabase につないだビルド（E2E）だけ、手元の Storage の画像を next/image で表示できるようにする
 * （設計書 2026-10-05 グループ B の 7-4）。Next.js 16 は手元の住所（127.0.0.1 など）の画像の最適化を既定で止めるので、
 * そのときだけ dangerouslyAllowLocalIP を立てる。本番（*.supabase.co）のビルドでは何も変わらない。
 */
const localSupabaseStorage = (() => {
  try {
    const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '');
    return ['localhost', '127.0.0.1'].includes(url.hostname) ? url : null;
  } catch {
    return null;
  }
})();
```

同じファイルの `images: {` の直後の `remotePatterns: [` を、次のように変える（`dangerouslyAllowLocalIP` の行を足す）:

```ts
  images: {
    ...(localSupabaseStorage ? { dangerouslyAllowLocalIP: true } : {}),
    remotePatterns: [
```

同じ `remotePatterns` の配列の最後の要素（`pathname: '/storage/v1/object/authenticated/**'` の塊）の閉じ `},` の後、配列を閉じる `],` の前に足す:

```ts
      ...(localSupabaseStorage
        ? [
            {
              protocol: localSupabaseStorage.protocol === 'https:' ? ('https' as const) : ('http' as const),
              hostname: localSupabaseStorage.hostname,
              port: localSupabaseStorage.port,
              pathname: '/storage/v1/object/**',
            },
          ]
        : []),
```

- [ ] **Step 7: E2E の前に画像を置くようにし、Auth の戻り先をそろえる**

`playwright.config.ts` の `testDir: './e2e',` の次の行に足す:

```ts
  /* 手元の Storage に見本の画像を置く（npx supabase db reset で消えるので毎回置き直す）。 */
  globalSetup: './scripts/e2e/global-setup.ts',
```

`supabase/config.toml` の `[auth]` の2行:

```toml
site_url = "http://127.0.0.1:3000"
```

```toml
additional_redirect_urls = ["https://127.0.0.1:3000"]
```

を、それぞれ次に置き換える:

```toml
site_url = "http://localhost:3000"
```

```toml
additional_redirect_urls = ["http://localhost:3000", "http://127.0.0.1:3000"]
```

- [ ] **Step 8: 手元の Supabase に設定と見本データを入れ直し、件数を確かめる**

Auth の設定を読み直させるため、手元の Supabase を起動し直してから入れ直す（手元の DB は作り直しになる）:

```bash
npx supabase stop
npx supabase start
npx supabase db reset
node -e "
const { Client } = require('pg');
const c = new Client({ connectionString: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' });
c.connect().then(async () => {
  const r = await c.query(\`select 'items' t, count(*)::int n from public.items
    union all select 'published_items', count(*)::int from public.items where status = 'published'
    union all select 'item_colors', count(*)::int from public.item_colors
    union all select 'item_sizes', count(*)::int from public.item_sizes
    union all select 'item_variants', count(*)::int from public.item_variants
    union all select 'looks', count(*)::int from public.looks
    union all select 'look_items', count(*)::int from public.look_items
    union all select 'news_articles', count(*)::int from public.news_articles
    union all select 'stockists', count(*)::int from public.stockists
    union all select 'buckets', count(*)::int from storage.buckets where id in ('item-images','look-images','news-images')\`);
  console.table(r.rows);
  await c.end();
});
"
```

Expected: items 9、published_items 7、item_colors 13、item_sizes 11、item_variants 21、looks 7、look_items 9、news_articles 8、stockists 6、buckets 3

- [ ] **Step 9: 見本データを使うテストを流す**

3000番が空いていることを確かめてから（Task 4 の Step 4 と同じ）:

Run: `E2E_STRICT=1 npx playwright test e2e/FR-SEARCH-007-thumbnail-signed-urls.spec.ts e2e/FR-HOME-013-section-display-limits.spec.ts e2e/FR-STOCKIST-010-region-prefecture-filter.spec.ts e2e/FR-NEWS-ALL-001-published-news-order.spec.ts e2e/FR-LOOK-ALL-003-look-list-render-capacity.spec.ts e2e/FR-ITEM-ALL-009-items-api-filter-sort.spec.ts e2e/FR-CHECKOUT-028-confirm-disabled-until-ready.spec.ts`
Expected: ログに `[e2e] 手元の Storage に見本の画像を 40 件置いた` が出て、「前」に通っていたテスト（`FR-CHECKOUT-028` は3つの画面幅、ほかは全件）が通る。落ちたら Task 7 の Step 5 の決まりで見本データを直す。

- [ ] **Step 10: DB 結合テストが見本データと共存することを確かめる**

```bash
eval "$(npx supabase status -o env | grep -E '^(API_URL|SERVICE_ROLE_KEY)=')"
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
LOCAL_SUPABASE_URL="$API_URL" LOCAL_SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
  npx jest tests/integration/db --runInBand
```

Expected: 全件 PASS（スキップ無し）。見本データの行（番号1〜10）が原因で落ちたら、そのテストが「表の行は自分で作ったものだけ」を前提にしている箇所を、自分の作った行に絞るよう直し、理由をコミットに書く。

- [ ] **Step 11: 型と lint を確かめてコミットする**

Run: `npm run typecheck && npx eslint next.config.ts playwright.config.ts scripts/e2e tests/unit/scripts/e2e`
Expected: エラー0

```bash
git add supabase/seed.sql scripts/e2e/seed-storage.ts scripts/e2e/global-setup.ts tests/unit/scripts/e2e/seed-storage.test.ts playwright.config.ts next.config.ts supabase/config.toml
git commit -m "$(cat <<'EOF'
feat(e2e): 手元の Supabase に架空の見本データと仮の画像を入れる

seed.sql に本番の公開データと同じ形の架空の商品・ルック・ニュース・取扱店を置き、
E2E の前に手元の Storage へ仮の画像を置く。手元の Supabase につないだビルドだけ
手元の画像を next/image で表示できるようにし、Auth の戻り先を localhost:3000 にした。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: 「前」と「後」の結果を比べる仕組み

設計書 9-2。「前」（本番の DB での全件、2026-10-05 0:42 開始）に通っていて、「後」（手元の DB）で通らないテストを並べる。

**Files:**
- Create: `scripts/e2e/compare-baseline.ts`
- Modify: `package.json`（`scripts` に `e2e:compare`）
- Test: `tests/unit/scripts/e2e/compare-baseline.test.ts`

**Interfaces:**
- Consumes: 「前」の一覧（`{ tests: TestOutcome[] }`）、Task 4 の `test-results/e2e-results.json`（Playwright の JSON レポート）
- Produces（`scripts/e2e/compare-baseline.ts`）:
  - `export type Outcome = 'expected' | 'unexpected' | 'flaky' | 'skipped'`
  - `export type TestOutcome = { testId: string; file: string; title: string; project: string; outcome: Outcome }`
  - `export type PlaywrightJsonReport = { suites: JsonSuite[] }`
  - `export type Comparison = { regressions: TestOutcome[]; fixed: TestOutcome[]; missing: TestOutcome[]; added: TestOutcome[] }`
  - `export function flattenPlaywrightJson(report: PlaywrightJsonReport): TestOutcome[]`
  - `export function compareRuns(baseline: TestOutcome[], current: TestOutcome[]): Comparison`
  - CLI: `npm run e2e:compare -- [前の一覧] [後の JSON]`。前に通っていて後で通らないテストが1件でもあれば終了コード1

- [ ] **Step 1: テストを書く**

`tests/unit/scripts/e2e/compare-baseline.test.ts`:

```ts
/** @jest-environment node */
import {
  compareRuns,
  flattenPlaywrightJson,
  type PlaywrightJsonReport,
  type TestOutcome,
} from '@/../scripts/e2e/compare-baseline';

const row = (testId: string, outcome: TestOutcome['outcome'], title = `t-${testId}`): TestOutcome => ({
  testId, file: 'FR-X-001.spec.ts', title, project: 'chromium', outcome,
});

describe('flattenPlaywrightJson', () => {
  it('ファイルの下の describe を「 > 」でつなぎ、ファイル名は名前に含めない', () => {
    const report: PlaywrightJsonReport = {
      suites: [
        {
          title: 'FR-X-001.spec.ts',
          file: 'FR-X-001.spec.ts',
          specs: [{ id: 'a', title: 'top', file: 'FR-X-001.spec.ts', tests: [{ projectName: 'chromium', status: 'expected' }] }],
          suites: [
            {
              title: 'FR-X-001 画面',
              file: 'FR-X-001.spec.ts',
              specs: [{ id: 'b', title: 'mobile（390px）出る', file: 'FR-X-001.spec.ts', tests: [{ projectName: 'chromium', status: 'unexpected' }] }],
            },
          ],
        },
      ],
    };
    expect(flattenPlaywrightJson(report)).toEqual([
      { testId: 'a', file: 'FR-X-001.spec.ts', title: 'top', project: 'chromium', outcome: 'expected' },
      { testId: 'b', file: 'FR-X-001.spec.ts', title: 'FR-X-001 画面 > mobile（390px）出る', project: 'chromium', outcome: 'unexpected' },
    ]);
  });
});

describe('compareRuns', () => {
  it('前に通っていて後で落ちた・飛ばされたテストを挙げる', () => {
    const result = compareRuns(
      [row('a', 'expected'), row('b', 'expected'), row('c', 'expected')],
      [row('a', 'expected'), row('b', 'unexpected'), row('c', 'skipped')],
    );
    expect(result.regressions.map((t) => t.testId)).toEqual(['b', 'c']);
  });

  it('前に落ちていたテストは、後で落ちても挙げない。後で通れば「直った」に挙げる', () => {
    const result = compareRuns(
      [row('a', 'unexpected'), row('b', 'unexpected')],
      [row('a', 'unexpected'), row('b', 'expected')],
    );
    expect(result.regressions).toEqual([]);
    expect(result.fixed.map((t) => t.testId)).toEqual(['b']);
  });

  it('不安定（flaky）は通ったものとして扱う', () => {
    expect(compareRuns([row('a', 'flaky')], [row('a', 'flaky')]).regressions).toEqual([]);
  });

  it('番号が変わっても、ファイル・名前・プロジェクトが同じなら同じテストとして比べる', () => {
    const result = compareRuns([row('old-id', 'expected', 'same')], [row('new-id', 'unexpected', 'same')]);
    expect(result.regressions.map((t) => t.testId)).toEqual(['new-id']);
    expect(result.missing).toEqual([]);
  });

  it('前にだけある・後にだけあるテストを分けて挙げる', () => {
    const result = compareRuns([row('a', 'expected')], [row('b', 'expected')]);
    expect(result.missing.map((t) => t.testId)).toEqual(['a']);
    expect(result.added.map((t) => t.testId)).toEqual(['b']);
  });
});
```

- [ ] **Step 2: テストが落ちることを確かめる**

Run: `npx jest tests/unit/scripts/e2e/compare-baseline.test.ts`
Expected: FAIL（`Cannot find module '@/../scripts/e2e/compare-baseline'`）

- [ ] **Step 3: 比べる仕組みを作る**

`scripts/e2e/compare-baseline.ts`:

```ts
/**
 * E2E の切り替えの前後を比べる（設計書 2026-10-05 グループ B の 9-2）。
 *
 * 使い方: npm run e2e:compare -- [前の一覧] [後の Playwright JSON]
 * 既定の「前」: 2026-10-05 0:42 開始の全件（本番の DB）。既定の「後」: 最後の実行の test-results/e2e-results.json。
 * 前に通っていて後で通らないテストが1件でもあれば、終了コード1で終わる。
 */
import { readFileSync } from 'node:fs';

export type Outcome = 'expected' | 'unexpected' | 'flaky' | 'skipped';

export type TestOutcome = { testId: string; file: string; title: string; project: string; outcome: Outcome };

type JsonTest = { projectName: string; status: Outcome };
type JsonSpec = { id: string; title: string; file: string; tests: JsonTest[] };
type JsonSuite = { title: string; file?: string; specs?: JsonSpec[]; suites?: JsonSuite[] };

export type PlaywrightJsonReport = { suites: JsonSuite[] };

export type Comparison = {
  /** 前は通過、後は失敗・飛ばし */
  regressions: TestOutcome[];
  /** 前は失敗、後は通過 */
  fixed: TestOutcome[];
  /** 前にあり、後に無い */
  missing: TestOutcome[];
  /** 後にだけある */
  added: TestOutcome[];
};

const DEFAULT_BASELINE = '.superpowers/sdd/2026-10-05-webhook-queue-operations/e2e-baseline-2026-10-05-tests.json';
const DEFAULT_CURRENT = 'test-results/e2e-results.json';
const PASSED: ReadonlySet<Outcome> = new Set<Outcome>(['expected', 'flaky']);

const nameKey = (test: TestOutcome) => `${test.project}|${test.file}|${test.title}`;

export function flattenPlaywrightJson(report: PlaywrightJsonReport): TestOutcome[] {
  const rows: TestOutcome[] = [];
  const walk = (suite: JsonSuite, describePath: string[]) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        rows.push({
          testId: spec.id,
          file: spec.file,
          title: [...describePath, spec.title].join(' > '),
          project: test.projectName,
          outcome: test.status,
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, [...describePath, child.title]);
  };
  // 一番外の suite はファイル。名前には含めない（前の一覧と同じ形）。
  for (const fileSuite of report.suites) walk(fileSuite, []);
  return rows;
}

export function compareRuns(baseline: TestOutcome[], current: TestOutcome[]): Comparison {
  const byId = new Map(current.map((test) => [test.testId, test]));
  const byName = new Map(current.map((test) => [nameKey(test), test]));
  const matched = new Set<TestOutcome>();
  const result: Comparison = { regressions: [], fixed: [], missing: [], added: [] };

  for (const before of baseline) {
    const after = byId.get(before.testId) ?? byName.get(nameKey(before));
    if (!after) {
      result.missing.push(before);
      continue;
    }
    matched.add(after);
    if (PASSED.has(before.outcome) && !PASSED.has(after.outcome)) result.regressions.push(after);
    if (before.outcome === 'unexpected' && PASSED.has(after.outcome)) result.fixed.push(after);
  }
  result.added = current.filter((test) => !matched.has(test));
  return result;
}

function main(argv: string[]): number {
  const baselinePath = argv[0] ?? DEFAULT_BASELINE;
  const currentPath = argv[1] ?? DEFAULT_CURRENT;
  const baseline = (JSON.parse(readFileSync(baselinePath, 'utf8')) as { tests: TestOutcome[] }).tests;
  const current = flattenPlaywrightJson(JSON.parse(readFileSync(currentPath, 'utf8')) as PlaywrightJsonReport);
  const result = compareRuns(baseline, current);

  console.log(`前: ${baseline.length}件 / 後: ${current.length}件`);
  console.log(`前に通っていて後で通らない: ${result.regressions.length}件`);
  for (const test of result.regressions) console.log(`  - [${test.outcome}] ${test.file} :: ${test.title}`);
  console.log(`前は失敗で後は通過: ${result.fixed.length}件`);
  console.log(`前にあり後に無い: ${result.missing.length}件`);
  for (const test of result.missing) console.log(`  - ${test.file} :: ${test.title}`);
  console.log(`後にだけある: ${result.added.length}件`);
  return result.regressions.length > 0 ? 1 : 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
```

`package.json` の `scripts` の `"test:e2e:debug": "playwright test --debug",` の次の行に足す:

```json
    "e2e:compare": "tsx scripts/e2e/compare-baseline.ts",
```

- [ ] **Step 4: テストが通ることを確かめる**

Run: `npx jest tests/unit/scripts/e2e/compare-baseline.test.ts`
Expected: PASS（6件）

Task 4 の Step 4 で作った `test-results/e2e-results.json`（FR-ABOUT-001 の3件）で動かす:

Run: `npm run e2e:compare`
Expected: `後: 3件`、`前に通っていて後で通らない: 0件`、`前にあり後に無い: 2625件` 前後（1ファイルしか流していないため）。終了コード0

Run: `npm run typecheck && npx eslint scripts/e2e`
Expected: エラー0

- [ ] **Step 5: コミット**

```bash
git add scripts/e2e/compare-baseline.ts tests/unit/scripts/e2e/compare-baseline.test.ts package.json
git commit -m "$(cat <<'EOF'
feat(e2e): 切り替えの前後の E2E の結果を比べる仕組みを足す

前（本番の DB での全件）に通っていて後で通らないテストを挙げ、1件でもあれば
終了コード1で終わる。npm run e2e:compare で動かす。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: 全件を手元で流し、「前」と比べて直す

設計書 9-2・9-3。手元の DB で全件を流し、「前」に通っていたテストがすべて通るまで、見本データを足して直す。あわせて、本番の DB の行が増えないことと、メールが手元に届くことを確かめる。

**Files:**
- Modify: `supabase/seed.sql`（足りないデータを足す）
- Modify（Step 5 の決まりに当たるときだけ）: `e2e/*.spec.ts`

**Interfaces:**
- Consumes: Task 4（手元につながる E2E）、Task 5（見本データ）、Task 6（`npm run e2e:compare`）
- Produces: 「前に通っていて後で通らない: 0件」の状態。計画2はこの状態の E2E を使う

- [ ] **Step 1: 本番の行数を記録する（読むだけ）**

Supabase MCP の `execute_sql`（project_id `pjidrgofvaglnuuznnyj`）で流し、結果を作業の報告に残す:

```sql
select 'carts' as t, count(*) as n from public.carts
union all select 'checkout_drafts', count(*) from public.checkout_drafts
union all select 'contact_inquiries', count(*) from public.contact_inquiries
union all select 'contact_messages', count(*) from public.contact_messages
union all select 'wishlist', count(*) from public.wishlist
union all select 'orders', count(*) from public.orders
union all select 'audit_logs', count(*) from public.audit_logs
union all select 'stripe_webhook_events', count(*) from public.stripe_webhook_events;
```

- [ ] **Step 2: 手元を準備し、メール受けの件数を記録する**

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
docker inspect -f '{{.State.Health.Status}}' supabase_db_o_official
```

Expected: 1行目は何も出ない（出たら、その3000番のアプリを止める）。2行目は `healthy`。

```bash
npx supabase db reset
curl -s "http://127.0.0.1:54324/api/v1/messages?limit=1" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log('mailpit total', JSON.parse(s).total))"
```

Expected: db reset が `Finished supabase db reset` で終わる。メール受けの件数を記録する。

- [ ] **Step 3: 全件を流す**

Run: `E2E_STRICT=1 npm run test:e2e`
Expected: 20〜25分で終わる。失敗があってもよい（次の Step で比べる）。

- [ ] **Step 4: 「前」と比べる**

Run: `npm run e2e:compare`
Expected: 「前に通っていて後で通らない」の一覧が出る。0件なら Step 7 へ。

- [ ] **Step 5: 1件ずつ原因を分け、決まりに従って直す**

| 原因 | 直し方 |
|---|---|
| 見本データが足りない（件数・分類・状態・つながり・並び） | `supabase/seed.sql` に架空の値で足す |
| テストが本番の商品の名前や文章など、本番の中身そのものを確かめている | テストを、見本データにある値か、形（件数・並び・表示の有無）を確かめるように直す。直した理由をコミットに書く |
| 手元の環境の違い（Storage の画像、郵便番号の表など） | 見本データか E2E の環境（`scripts/e2e/environment.ts` の固定値）で手当てする |
| 単体で流すと通る（実行の混み合い） | CLAUDE.md の「失敗したときの切り分け」の順で確かめ、記録する。`retries` は上げない |
| 実装の不具合（手元の DB で初めて表に出た） | 直さずに止めて報告する（この計画の範囲外） |

見本データを直したら、入れ直して、落ちたテストのファイルだけを流す（起動済みの E2E 用のアプリを使い回してよい）:

```bash
npx supabase db reset
npx playwright test <落ちたテストのファイル名をスペース区切りで>
```

Expected: 流したファイルのテストが通る。

- [ ] **Step 6: もう一度全件を流して比べる**

3000番の E2E 用のアプリを止めてから（`E2E_STRICT=1` は使い回さない）:

```bash
npx supabase db reset
E2E_STRICT=1 npm run test:e2e
npm run e2e:compare
```

Expected: `前に通っていて後で通らない: 0件`、終了コード0。0件でなければ Step 5 に戻る。

見本データを直したときは、DB 結合テストも通ることを確かめる:

```bash
eval "$(npx supabase status -o env | grep -E '^(API_URL|SERVICE_ROLE_KEY)=')"
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
LOCAL_SUPABASE_URL="$API_URL" LOCAL_SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
  npx jest tests/integration/db --runInBand
```

Expected: 全件 PASS（スキップ無し）

- [ ] **Step 7: 本番の行が増えていないことを確かめる**

Step 1 と同じ SQL を流す。
Expected: どの表も Step 1 から増えていない。

- [ ] **Step 8: メールが手元に届いたことを確かめる**

```bash
curl -s "http://127.0.0.1:54324/api/v1/messages?limit=1" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log('mailpit total', JSON.parse(s).total))"
curl -s "http://127.0.0.1:54324/api/v1/search?query=to%3Ashop%40e2e.test&limit=1" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log('to shop@e2e.test', JSON.parse(s).messages_count))"
```

Expected: 1行目は Step 2 の件数より多い。2行目は1以上（お問い合わせのテストの、お店への通知が手元に届いた）。

- [ ] **Step 9: コミット**

見本データやテストを直したときだけコミットする（直しが無ければこの Step は飛ばす）:

```bash
git add supabase/seed.sql <直したテストのファイル>
git commit -m "$(cat <<'EOF'
test(e2e): 手元の DB で「前」に通っていたテストが通るよう見本データを足す

<足したデータと、テストを直した場合はその理由を1行ずつ>

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: 文書（E2E は手元の Supabase で流す）

設計書 7-1〜7-7 の運用を、読む人が迷わないように書く。

**Files:**
- Modify: `e2e/README.md`（「前提条件」と「注意事項」）
- Modify: `README.md`（「ローカル DB（Supabase CLI）」の節）
- Modify: `.claude/CLAUDE.md`（「E2E 実行ルール」）
- Modify: `scripts/hooks/pre-push`（Docker が無いときのメッセージ）
- Modify: `docs/05_Quality/reviews/code/2026-09-25-working-diff-security-review.md`（R-55）

**Interfaces:**
- Consumes: Task 1〜7 の結果
- Produces: なし

- [ ] **Step 1: E2E の README を直す**

`e2e/README.md` の「### 前提条件」の下の、次の部分:

````markdown
開発サーバーが起動している必要があります：

```bash
npm run dev
```

別のターミナルでテストを実行：
````

を次に置き換える:

```markdown
E2E は本番ビルド（`next build` と `next start`）を手元の Supabase につないで流す。`playwright.config.ts` がアプリを起動するので、開発サーバーは要らない（3000番で動いていると、見張りが止める）。

1. Docker Desktop を起動し、手元の Supabase を起動する（`npm run db:start`）
2. 見本データを入れ直す（`npm run db:reset`。`supabase/seed.sql` が入る）
3. テストを流す（下のコマンド）

見張り（`scripts/e2e/environment.ts`）は、次のときに理由を出して止まる。

- Supabase の住所が手元（localhost）ではない、Stripe の鍵がテスト用ではない、メールの送り先が手元ではない
- 3000番で、E2E が手元の設定で起動したものではないアプリ（開発サーバーなど）が動いている
- 手元の Supabase の状態を読めない
```

同じファイルの「## 注意事項」の箇条書き（3行）を次に置き換える:

```markdown
- E2E は手元の Supabase だけを使う。本番の Supabase の鍵と Resend の鍵は、アプリにもテストにも渡さない
- 見本データは `supabase/seed.sql` の架空の値。お客様・管理者のアカウントや注文は入っていない（ログインは偽の応答で行う）
- アプリのメールは手元のメール受け（Mailpit、http://127.0.0.1:54324）に届き、外へは出ない
- Stripe はテストモード。E2E は Stripe の知らせ（Webhook）を手元へつながない
- テストが作ったカートやお問い合わせは手元の DB に残る。`npm run db:reset` で消える
- 切り替えの前後を比べるときは `npm run e2e:compare`（最後の実行の `test-results/e2e-results.json` を読む）
```

- [ ] **Step 2: README のローカル DB の節に足す**

`README.md` の「### ローカル DB（Supabase CLI）」の節で、`npx jest tests/integration/db --runInBand` を含むコードブロックの直後に、次を足す:

```markdown
E2E（`npm run test:e2e`）も手元の Supabase につなぐ。`playwright.config.ts` が起動のたびに `npx supabase status` から住所と鍵を読み、`.env.local` の本番の値を上書きする。見本データは `supabase/seed.sql`（架空の値）で、`npm run db:reset` のたびに入る。

普段の開発（`npm run dev`）のメールは、設定にかかわらず手元のメール受け（Mailpit、http://127.0.0.1:54324）に届く。手元の Supabase が止まっているとメールの送信は失敗する（外へは出ない）。
```

- [ ] **Step 3: CLAUDE.md の E2E 実行ルールを直す**

`.claude/CLAUDE.md` の次の段落:

```markdown
**注意（必読）:** `reuseExistingServer: true` のため、**`npm run dev` が :3000 で動いたままだと Playwright はそれを再利用し、黙って dev サーバーに対してテストしてしまう**。E2E を回す前に dev サーバーを止めること。
```

を次に置き換える:

```markdown
**手元の Supabase で流す（必読）:** E2E は手元の Supabase（`npm run db:start`・`npm run db:reset`）に対して流す。`playwright.config.ts` の見張り（`scripts/e2e/environment.ts`）が、本番の Supabase の住所・本番の Stripe の鍵・外へのメールを拒み、3000番で E2E 用でないアプリ（`npm run dev` など）が動いていれば止まる。止まったら、3000番のアプリを止めてから流すこと。
```

- [ ] **Step 4: push の前の検査のメッセージを直す**

`scripts/hooks/pre-push` の次の2行:

```sh
  echo "[pre-push] docker が見つからないため E2E をスキップします。"
  echo "[pre-push] ローカル Supabase の導入が済むまでの暫定動作です。"
```

を次に置き換える:

```sh
  echo "[pre-push] docker が見つからないため E2E をスキップします。"
  echo "[pre-push] E2E は手元の Supabase（Docker）に対して流すため、Docker が要ります。"
```

- [ ] **Step 5: レビュー台帳の R-55 を更新する**

`docs/05_Quality/reviews/code/2026-09-25-working-diff-security-review.md` の一覧の行:

```markdown
| R-55 | P3・条件付き | 未修正 | E2E が実際に決済を確定し、テストWebhookを登録すると本番DBに注文を作る |
```

を次に置き換える:

```markdown
| R-55 | P3・条件付き | 一部対応（E2E を手元の Supabase に切り替え。受け取り口のモードの確かめは計画2） | E2E が実際に決済を確定し、テストWebhookを登録すると本番DBに注文を作る |
```

同じファイルの「### R-55」の節の最後（「2026-09-27 追記（pre-push の E2E）」の箇条の次）に、次を足す。見出しの日付はコミットする日にする:

```markdown
- **2026-10-05 追記（グループ B 計画1）**: E2E と pre-push を手元の Supabase に切り替え、見張りが本番の住所・本番の鍵・外へのメール・確かめられない3000番のアプリを拒むようにした（[計画1](../../../superpowers/plans/2026-10-05-e2e-local-supabase.md)）。アプリのメールは手元の Mailpit に届く。受け取り口で `livemode` を確かめるのは計画2。
```

- [ ] **Step 6: 全体を確かめ、文書を検査してコミットする**

Run: `npm run lint && npm run typecheck && npm test -- --silent`
Expected: lint のエラー0、型のエラー0、単体テスト全件 PASS

Run: `npm run validate-docs`
Expected: `Documentation validation passed`

```bash
git add e2e/README.md README.md .claude/CLAUDE.md scripts/hooks/pre-push docs/05_Quality/reviews/code/2026-09-25-working-diff-security-review.md
git commit -m "$(cat <<'EOF'
docs(e2e): E2E を手元の Supabase で流すことと見張りを文書に書く

E2E の README・README・CLAUDE.md の E2E 実行ルール・pre-push のメッセージを
直し、レビュー台帳の R-55 を一部対応にした。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```
