/**
 * 管理 API の認可の門（ADMIN 領域。ユーザー作成・強制失効・MFA のリセット・監査ログ・問い合わせ・色見本）。
 * SEC-ADMIN-001-AC-01〜03（JWT の無い要求・aal1・サポーター）と SEC-ADMIN-005-AC-01〜02（Origin の検査）を確かめる。
 *
 * 全部 HTTP の層で、画面は開かない。本番ビルドの窓口へ Playwright の request で直に要求するので、viewport は関係しない
 * （3つの viewport の繰り返しは無い）。管理者の JWT は手元の Supabase で作る（e2e/admin-session-test-utils.ts）。
 * 断られた要求の後で、利用者・session・2要素の登録・色見本・問い合わせ・テンプレートが変わっていないことを DB で数える。
 * 要求の本文は、通ってしまえば実際に書き換わる正しい形にしてある（本文の誤りで 400 になって断られた形にしない）。
 * 手元の DB の権限の表は、権限の設定の試験と同じ lock（withPermissionScenario）で直列にして読む。
 */
import { randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import {
  bearerHeaders,
  createAdminSessionActor,
  seedAppSession,
  seedVerifiedMfaFactor,
  type AdminSessionActor,
} from './admin-session-test-utils';
import { withLocalDb } from './order-email-test-utils';
import { withPermissionScenario } from './permission-settings-test-utils';

// JWT が Authorization ヘッダーに載るので、通信記録（trace）に残さない。
test.use({ trace: 'off' });

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type Endpoint = { method: Method; path: string; data?: unknown };

type Fixture = {
  tag: string;
  createEmail: string;
  victim: AdminSessionActor;
  inquiryId: string;
  templateId: string;
  presetId: string;
};

const WRITE_METHODS: ReadonlySet<Method> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const FOREIGN_ORIGIN = 'https://attacker.example';

function label(endpoint: Endpoint): string {
  return `${endpoint.method} ${endpoint.path}`;
}

/** 範囲の管理 API の全部の（メソッド, 道）。本文は通れば本当に書き換わる正しい形 */
function rangeEndpoints(f: Fixture): Endpoint[] {
  return [
    { method: 'POST', path: '/api/admin/create-user', data: { email: f.createEmail, password: `E2e-${f.tag}-0123456789`, display_name: f.tag } },
    { method: 'POST', path: '/api/admin/revoke-user-sessions', data: { user_id: f.victim.userId } },
    {
      method: 'POST',
      path: '/api/admin/users/mfa/reset',
      data: { userId: f.victim.userId, reason: `${f.tag} reason for the e2e check`, confirm: 'RESET_MFA' },
    },
    { method: 'GET', path: '/api/admin/audit-logs' },
    { method: 'GET', path: '/api/admin/contact' },
    { method: 'GET', path: `/api/admin/contact/${f.inquiryId}` },
    { method: 'PATCH', path: `/api/admin/contact/${f.inquiryId}`, data: { status: 'closed' } },
    { method: 'POST', path: `/api/admin/contact/${f.inquiryId}/reply`, data: { body: `${f.tag} reply body` } },
    { method: 'GET', path: '/api/admin/contact/templates' },
    { method: 'POST', path: '/api/admin/contact/templates', data: { title: `${f.tag}-new`, category: 'other', body: `${f.tag} body` } },
    { method: 'PUT', path: `/api/admin/contact/templates/${f.templateId}`, data: { title: `${f.tag}-changed`, category: 'other', body: `${f.tag} changed body` } },
    { method: 'DELETE', path: `/api/admin/contact/templates/${f.templateId}` },
    { method: 'GET', path: '/api/admin/item-color-presets' },
    { method: 'POST', path: '/api/admin/item-color-presets', data: { name: `${f.tag}-new`, hex: '#abcdef' } },
    { method: 'DELETE', path: `/api/admin/item-color-presets/${f.presetId}` },
  ];
}

function newTag(): string {
  return `e2e-misc-${randomBytes(4).toString('hex')}`;
}

/** 断られる要求が狙う行を用意する。名前・題は tag で始め、他の試験の行と混ざらないようにする */
async function seedFixture(db: PgClient): Promise<Fixture> {
  const tag = newTag();
  const victim = await createAdminSessionActor(db, 'supporter', 'aal1');
  await seedVerifiedMfaFactor(db, victim.userId);
  await seedAppSession(db, victim.userId);
  const inquiry = await db.query(
    `insert into public.contact_inquiries (name, email, inquiry_type, subject, message)
     values ($1, $2, 'other', $3, $4) returning id::text as id`,
    [tag, `${tag}@example.com`, `${tag} subject`, `${tag} message`],
  );
  const template = await db.query(
    `insert into public.contact_reply_templates (title, category, body, sort_order)
     values ($1, 'other', $2, 7) returning id::text as id`,
    [`${tag}-seed`, `${tag} seed body`],
  );
  const preset = await db.query(
    `insert into public.item_color_presets (name, hex) values ($1, '#123456') returning id::text as id`,
    [`${tag}-seed`],
  );
  return {
    tag,
    createEmail: `${tag}-created@example.com`,
    victim,
    inquiryId: inquiry.rows[0].id,
    templateId: template.rows[0].id,
    presetId: preset.rows[0].id,
  };
}

/** 試験の行を片づける（問い合わせのやり取りは外部キーで一緒に消える）。色見本とテンプレートは他の試験の一覧に混ざるので残さない */
async function cleanupFixture(db: PgClient, f: Fixture): Promise<void> {
  await db.query('delete from public.item_color_presets where starts_with(name, $1)', [f.tag]);
  await db.query('delete from public.contact_reply_templates where starts_with(title, $1)', [f.tag]);
  await db.query('delete from public.contact_inquiries where starts_with(name, $1)', [f.tag]);
}

/** 断られた要求が変えてはならない行の写し。作られうる行は tag の前置きで拾う */
async function snapshot(db: PgClient, f: Fixture): Promise<unknown> {
  const counts = await db.query(
    `select
       (select count(*)::int from auth.users where email = $1) as created_users,
       (select count(*)::int from auth.users where id = $2::uuid) as victim_users,
       (select count(*)::int from auth.sessions where user_id = $2::uuid) as victim_auth_sessions,
       (select count(*)::int from public.sessions where user_id = $2::uuid and revoked_at is null) as victim_live_app_sessions,
       (select count(*)::int from auth.mfa_factors where user_id = $2::uuid) as victim_mfa_factors`,
    [f.createEmail, f.victim.userId],
  );
  const presets = await db.query(
    `select id::text as id, name, hex from public.item_color_presets where starts_with(name, $1) order by id`,
    [f.tag],
  );
  const templates = await db.query(
    `select id::text as id, title, category, body, sort_order, updated_at::text as updated_at
       from public.contact_reply_templates where starts_with(title, $1) order by id`,
    [f.tag],
  );
  const inquiries = await db.query(
    `select i.id::text as id, i.status, i.updated_at::text as updated_at, i.last_message_at::text as last_message_at,
            (select count(*)::int from public.contact_messages m where m.inquiry_id = i.id) as messages
       from public.contact_inquiries i where starts_with(i.name, $1) order by i.id`,
    [f.tag],
  );
  return { counts: counts.rows[0], presets: presets.rows, templates: templates.rows, inquiries: inquiries.rows };
}

/** 窓口へ1件要求し、状態・拒否の理由・必要な権限を写す */
async function probe(api: APIRequestContext, endpoint: Endpoint, headers: Record<string, string>) {
  const res = await api.fetch(endpoint.path, {
    method: endpoint.method,
    headers,
    ...(endpoint.data === undefined ? {} : { data: endpoint.data }),
    maxRedirects: 0,
  });
  const body = (await res.json().catch(() => null)) as { error?: string; reason?: string; permission?: string } | null;
  return {
    request: label(endpoint),
    status: res.status(),
    error: body?.error,
    reason: body?.reason,
    permission: body?.permission,
  };
}

function originOf(baseURL: string | undefined): string {
  expect(baseURL, 'baseURL').toBeTruthy();
  return new URL(baseURL as string).origin;
}

test('SEC-ADMIN-001-AC-01 JWT の無い要求を 401 で断る', async ({ playwright, baseURL }) => {
  const origin = originOf(baseURL);
  // 許可の Origin を付け、Origin の検査ではなく JWT の検査で断られることを確かめる（Cookie も持たない新しい文脈）
  const api = await playwright.request.newContext({ baseURL: baseURL as string });
  try {
    await withLocalDb(async (db) => {
      const fixture = await seedFixture(db);
      try {
        const endpoints = rangeEndpoints(fixture);
        const before = await snapshot(db, fixture);

        const results = [];
        for (const endpoint of endpoints) {
          results.push(await probe(api, endpoint, WRITE_METHODS.has(endpoint.method) ? { origin } : {}));
        }

        expect(results).toEqual(
          endpoints.map((endpoint) => ({
            request: label(endpoint),
            status: 401,
            error: 'Unauthorized',
            reason: undefined,
            permission: undefined,
          })),
        );
        expect(await snapshot(db, fixture)).toEqual(before);
      } finally {
        await cleanupFixture(db, fixture);
      }
    });
  } finally {
    await api.dispose();
  }
});

test('SEC-ADMIN-001-AC-02 2要素を済ませていない session の JWT を 403 で断る', async ({ playwright, baseURL }) => {
  const origin = originOf(baseURL);
  const api = await playwright.request.newContext({ baseURL: baseURL as string });
  try {
    await withPermissionScenario(async (db) => {
      const fixture = await seedFixture(db);
      try {
        const admin = await createAdminSessionActor(db, 'admin', 'aal1');
        const endpoints = rangeEndpoints(fixture);
        const before = await snapshot(db, fixture);

        const results = [];
        for (const endpoint of endpoints) {
          results.push(await probe(api, endpoint, { ...bearerHeaders(admin), ...(WRITE_METHODS.has(endpoint.method) ? { origin } : {}) }));
        }

        // 権限は足りる店長なので、断る理由は MFA だけ（permission は、その窓口が要る先頭の権限）
        expect(results.map(({ request, status, error, reason }) => ({ request, status, error, reason }))).toEqual(
          endpoints.map((endpoint) => ({ request: label(endpoint), status: 403, error: 'Forbidden', reason: 'MFA required' })),
        );
        expect(await snapshot(db, fixture)).toEqual(before);
      } finally {
        await cleanupFixture(db, fixture);
      }
    });
  } finally {
    await api.dispose();
  }
});

test('SEC-ADMIN-001-AC-03 サポーターは店長だけの窓口を使えない', async ({ playwright, baseURL }) => {
  const origin = originOf(baseURL);
  const api = await playwright.request.newContext({ baseURL: baseURL as string });
  try {
    await withPermissionScenario(async (db) => {
      const fixture = await seedFixture(db);
      try {
        const supporter = await createAdminSessionActor(db, 'supporter', 'aal2');
        const [createUser, revokeSessions, resetMfa] = rangeEndpoints(fixture);
        const adminOnly: Array<{ endpoint: Endpoint; permission: string }> = [
          { endpoint: createUser, permission: 'admin.users.manage' },
          { endpoint: revokeSessions, permission: 'admin.users.manage' },
          { endpoint: resetMfa, permission: 'admin.users.manage' },
          { endpoint: { method: 'GET', path: '/api/admin/audit-logs' }, permission: 'admin.audit.read' },
          { endpoint: { method: 'GET', path: '/api/admin/item-color-presets' }, permission: 'admin.items.read' },
          {
            endpoint: { method: 'POST', path: '/api/admin/item-color-presets', data: { name: `${fixture.tag}-new`, hex: '#abcdef' } },
            permission: 'admin.items.manage',
          },
          { endpoint: { method: 'DELETE', path: `/api/admin/item-color-presets/${fixture.presetId}` }, permission: 'admin.items.manage' },
        ];
        const before = await snapshot(db, fixture);

        const results = [];
        for (const { endpoint } of adminOnly) {
          results.push(await probe(api, endpoint, { ...bearerHeaders(supporter), ...(WRITE_METHODS.has(endpoint.method) ? { origin } : {}) }));
        }

        // aal2 の JWT なので MFA の理由は付かず、足りない権限の名前で断られる
        expect(results).toEqual(
          adminOnly.map(({ endpoint, permission }) => ({
            request: label(endpoint),
            status: 403,
            error: 'Forbidden',
            reason: undefined,
            permission,
          })),
        );
        expect(await snapshot(db, fixture)).toEqual(before);
      } finally {
        await cleanupFixture(db, fixture);
      }
    });
  } finally {
    await api.dispose();
  }
});

/**
 * 店長の aal2 の JWT で、Origin の付け方だけを変えて範囲の書き込み API（POST・PUT・PATCH・DELETE）を全部要求する。
 * 先に、許可の Origin を付けた無害な要求（空の本文のテンプレート作成）が 400 になる＝ JWT と権限が通ることを確かめる。
 */
async function expectWritesRefusedByOrigin(
  api: APIRequestContext,
  baseURL: string | undefined,
  originHeaders: Array<Record<string, string>>,
): Promise<void> {
  const allowedOrigin = originOf(baseURL);
  await withPermissionScenario(async (db) => {
    const fixture = await seedFixture(db);
    try {
      const admin = await createAdminSessionActor(db, 'admin', 'aal2');
      const writes = rangeEndpoints(fixture).filter((endpoint) => WRITE_METHODS.has(endpoint.method));
      expect(writes.map(label)).toHaveLength(10);

      const control = await probe(
        api,
        { method: 'POST', path: '/api/admin/contact/templates', data: {} },
        { ...bearerHeaders(admin), origin: allowedOrigin },
      );
      expect(control.status, '許可の Origin なら Origin の検査を通り、本文の検査で 400 になる').toBe(400);

      const before = await snapshot(db, fixture);
      const results = [];
      for (const headers of originHeaders) {
        for (const endpoint of writes) {
          results.push(await probe(api, endpoint, { ...bearerHeaders(admin), ...headers }));
        }
      }

      expect(results).toEqual(
        originHeaders.flatMap(() =>
          writes.map((endpoint) => ({
            request: label(endpoint),
            status: 403,
            error: 'Forbidden origin',
            reason: undefined,
            permission: undefined,
          })),
        ),
      );
      expect(await snapshot(db, fixture)).toEqual(before);
    } finally {
      await cleanupFixture(db, fixture);
    }
  });
}

test('SEC-ADMIN-005-AC-01 Origin も Referer も無い書き込みを 403 で断る', async ({ playwright, baseURL }) => {
  const api = await playwright.request.newContext({ baseURL: baseURL as string });
  try {
    // Origin も Referer も付けない（Playwright の request は既定でどちらも足さない）
    await expectWritesRefusedByOrigin(api, baseURL, [{}]);
  } finally {
    await api.dispose();
  }
});

test('SEC-ADMIN-005-AC-02 別のオリジンからの書き込みを 403 で断る', async ({ playwright, baseURL }) => {
  const allowedOrigin = originOf(baseURL);
  const api = await playwright.request.newContext({ baseURL: baseURL as string });
  try {
    // 許可の一覧に無い Origin と、許可の Origin を前に含むだけの別のオリジン
    await expectWritesRefusedByOrigin(api, baseURL, [
      { origin: FOREIGN_ORIGIN },
      { origin: `${allowedOrigin}.attacker.example` },
    ]);
  } finally {
    await api.dispose();
  }
});
