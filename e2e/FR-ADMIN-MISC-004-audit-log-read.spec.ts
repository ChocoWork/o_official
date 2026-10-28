/**
 * FR-ADMIN-MISC-004 監査ログの閲覧（ADMIN。窓口 GET /api/admin/audit-logs）
 * 対応: FREQ-508-AC-01・AC-02、SEC-ADMIN-011-AC-01、SEC-ADMIN-023-AC-01・AC-02
 *
 * 道: 手元の Supabase の GoTrue が署名した本物の aal2 の access token（共有の道具 e2e/admin-session-test-utils.ts）を
 * Authorization: Bearer で本物の窓口へ送る（Playwright の request）。窓口の認可（署名・セッションの生存・DB の ACL）と
 * 応答の列の絞りは本物が通る。画面の差し替えは使わない。画面を描かない HTTP の試験なので、viewport の繰り返しは無い。
 *
  * FREQ-508-AC-01 は「監査ログの一覧が表示される」と書くが、監査ログを出す画面が無い（TM-ADMIN-02）。
 * そのため窓口（API）が一覧の行を返すところまでを確かめる。画面の表示は確かめていない（画面ができたら画面の確かめを足す）。
 *
 * SEC-ADMIN-023-AC-01 は、問い合わせの詳細と監査ログの読み出しを窓口が記録するようになったので通る（TM-ADMIN-64。この確かめは id とメールだけを見る。読んだ人の IP は SEC-ADMIN-023-AC-02 が見る）。AC の文のとおりに書いてあり、緩めない。
 *
 * 権限の表（role_permissions）は手元の DB の共有の状態で、権限の設定の試験（FR-ADMIN-109・123）が admin.audit.read を一時的に
 * 動かしうる。そのため全部の試験を withPermissionScenario（同じ advisory lock）の中で流し、並行の差し替えを避ける。
 * 窓口は監査の行を新しい順に 100 行だけ返すので、入れる行の created_at は 1 日先にして、並行の試験が足す行で押し出されないようにする。
 * 作った利用者・セッション・監査の行は消さない（e2e-admin-misc- の印。db reset で消える）。問い合わせの行だけ、
 * 問い合わせの一覧を数える別の試験に混ざらないよう、終わりに消す。
 */
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { createAdminSessionActor, type AdminSessionRole } from './admin-session-test-utils';
import { deactivatePermissionActor, withPermissionScenario } from './permission-settings-test-utils';

// アクセストークンを通信記録に残さないため、ファイルの先頭で無効にする。
test.use({ trace: 'off' });
test.describe.configure({ timeout: 90_000 });

const AUDIT_LOGS_PATH = '/api/admin/audit-logs';
const AUDIT_READ_PERMISSION = 'admin.audit.read';
/** 窓口が返す列（src/app/api/admin/audit-logs/route.ts の AUDIT_LOGS_SAFE_COLUMNS と SEC-ADMIN-011 の文） */
const ALLOWED_COLUMNS = ['id', 'created_at', 'action', 'actor_id', 'resource', 'resource_id', 'outcome', 'detail'] as const;
const FORBIDDEN_COLUMNS = ['actor_email', 'ip', 'user_agent', 'metadata'] as const;

type Actor = { id: string; email: string; accessToken: string };
type Claims = { aal?: string; session_id?: string; sub?: string; app_metadata?: { role?: string } };
type AuditRow = Record<string, unknown>;

function claimsOf(accessToken: string): Claims {
  return JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8')) as Claims;
}

/**
 * 実際にログインできる aal2 の利用者を作る（共有の道具）。役割は app_metadata.role と user_roles（active）の両方に付く。
 * 窓口の ACL は user_roles だけを見る。deactivateRole なら、有効な割り当てを外す（app_metadata の役割名は残る）。
 */
async function createActor(
  client: PgClient,
  role: AdminSessionRole,
  options: { deactivateRole?: boolean } = {},
): Promise<Actor> {
  const actor = await createAdminSessionActor(client, role, 'aal2');
  if (options.deactivateRole) await deactivatePermissionActor(client, actor.userId);
  return { id: actor.userId, email: actor.email, accessToken: actor.accessToken };
}

type Actors = { admin: Actor; supporter: Actor; user: Actor; deactivatedAdmin: Actor };

/** GoTrue のログインの回数の制限（5分に30回）を使い切らないよう、worker ごとに1回だけ作って使い回す */
let actorsPromise: Promise<Actors> | null = null;

function getActors(client: PgClient): Promise<Actors> {
  if (!actorsPromise) {
    actorsPromise = (async () => ({
      admin: await createActor(client, 'admin'),
      supporter: await createActor(client, 'supporter'),
      user: await createActor(client, 'user'),
      deactivatedAdmin: await createActor(client, 'admin', { deactivateRole: true }),
    }))();
    actorsPromise.catch(() => {
      actorsPromise = null;
    });
  }
  return actorsPromise;
}

const bearer = (actor: Actor): Record<string, string> => ({ authorization: `Bearer ${actor.accessToken}` });

type SeedAuditRow = {
  action: string;
  actorId?: string | null;
  actorEmail?: string | null;
  resource?: string | null;
  resourceId?: string | null;
  detail?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown> | null;
};


async function seedAuditRow(client: PgClient, row: SeedAuditRow): Promise<string> {
  const result = await client.query(
    `insert into public.audit_logs (action, actor_id, actor_email, resource, resource_id, outcome, detail, ip, user_agent, metadata, created_at)
     values ($1, $2::uuid, $3, $4, $5, 'success', $6, $7, $8, $9::jsonb, now() + interval '1 day') returning id::text as id`,
    [
      row.action,
      row.actorId ?? null,
      row.actorEmail ?? null,
      row.resource ?? null,
      row.resourceId ?? null,
      row.detail ?? null,
      row.ip ?? null,
      row.userAgent ?? null,
      row.metadata ? JSON.stringify(row.metadata) : null,
    ],
  );
  return result.rows[0].id as string;
}

/** admin.audit.read を持つ役割の名前（権限の表そのもの） */
async function rolesWithAuditRead(client: PgClient): Promise<string[]> {
  const result = await client.query(
    `select r.code
       from public.role_permissions rp
       join public.roles r on r.id = rp.role_id
       join public.permissions p on p.id = rp.permission_id
      where p.code = $1
      order by r.code`,
    [AUDIT_READ_PERMISSION],
  );
  return result.rows.map((row) => row.code as string);
}

async function activeRoleCount(client: PgClient, actor: Actor): Promise<number> {
  const result = await client.query(
    `select count(*)::int as n from public.user_roles
      where user_id = $1::uuid and active and (expires_at is null or expires_at > now())`,
    [actor.id],
  );
  return result.rows[0].n as number;
}

test.describe('FR-ADMIN-MISC-004 監査ログの閲覧', () => {
  test(`FREQ-508-AC-01 閲覧の権限は店長だけに付き、権限のある店長の aal2 の要求に監査ログの一覧が返る（API。画面は無い）`, async ({ request }) => {
    await withPermissionScenario(async (client) => {
      const { admin } = await getActors(client);

      // 店長（admin）だけに新たに監査ログの閲覧権限が付く
      expect(await rolesWithAuditRead(client)).toEqual(['admin']);

      const marker = `e2e-admin-misc-audit-read-${randomUUID()}`;
      const seededActorId = randomUUID();
      const seededId = await seedAuditRow(client, {
        action: marker,
        actorId: seededActorId,
        resource: 'e2e-admin-misc',
        resourceId: marker,
        detail: marker,
      });

      // 権限のある店長（aal2）には監査ログの一覧が表示される。画面が無いので窓口の応答の行で確かめる
      const response = await request.get(AUDIT_LOGS_PATH, { headers: bearer(admin), maxRedirects: 0 });
      expect(response.status()).toBe(200);
      const body = (await response.json()) as { data?: AuditRow[] };
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data!.length).toBeGreaterThan(0);
      const seeded = body.data!.find((row) => row.id === seededId);
      expect(seeded).toMatchObject({
        id: seededId,
        action: marker,
        actor_id: seededActorId,
        resource: 'e2e-admin-misc',
        resource_id: marker,
        outcome: 'success',
        detail: marker,
      });
    });
  });

  test(`FREQ-508-AC-02 supporter・user に付与が無く、権限が無ければ店長の役割でも 403 で、監査ログの行が1つも返らない`, async ({ request }) => {
    await withPermissionScenario(async (client) => {
      const { admin, supporter, user, deactivatedAdmin } = await getActors(client);

      // supporter・user に新しい付与が無い
      const holders = await rolesWithAuditRead(client);
      expect(holders).not.toContain('supporter');
      expect(holders).not.toContain('user');
      expect(holders).toEqual(['admin']);

      // 前提: 3人とも aal2 で、役割の名前（店長）だけでは通らないことを見せるため、無効な店長の app_metadata は admin のまま
      for (const actor of [supporter, user, deactivatedAdmin]) {
        expect(claimsOf(actor.accessToken).aal).toBe('aal2');
      }
      expect(claimsOf(deactivatedAdmin.accessToken).app_metadata?.role).toBe('admin');
      expect(await activeRoleCount(client, deactivatedAdmin)).toBe(0);
      expect(await activeRoleCount(client, admin)).toBeGreaterThan(0);

      const marker = `e2e-admin-misc-audit-denied-${randomUUID()}`;
      await seedAuditRow(client, { action: marker, resource: 'e2e-admin-misc', resourceId: marker, detail: marker });

      for (const actor of [supporter, user, deactivatedAdmin]) {
        const response = await request.get(AUDIT_LOGS_PATH, { headers: bearer(actor), maxRedirects: 0 });
        expect(response.status()).toBe(403);
        const text = await response.text();
        const body = JSON.parse(text) as { error?: string; permission?: string; data?: unknown };
        expect(body.error).toBe('Forbidden');
        expect(body.permission).toBe(AUDIT_READ_PERMISSION);
        // 監査ログを取得しない: 行の入れ物が無く、入れた行の印も出ない
        expect(body).not.toHaveProperty('data');
        expect(text).not.toContain(marker);
      }
    });
  });

  test(`SEC-ADMIN-011-AC-01 店長の aal2 の応答は 200 で、どの行にも actor_email・ip・user_agent・metadata の項目が無い`, async ({ request }) => {
    await withPermissionScenario(async (client) => {
      const { admin } = await getActors(client);

      // 4つの項目を全部埋めた行を入れて、絞りが実際の応答で効くことを見せる
      const marker = randomUUID();
      const secretEmail = `e2e-admin-misc-secret-${marker}@example.com`;
      const secretIp = '203.0.113.77';
      const secretAgent = `e2e-admin-misc-agent-${marker}`;
      const secretMetadata = `e2e-admin-misc-metadata-${marker}`;
      const seededId = await seedAuditRow(client, {
        action: `e2e-admin-misc-audit-columns-${marker}`,
        actorId: randomUUID(),
        actorEmail: secretEmail,
        resource: 'e2e-admin-misc',
        resourceId: marker,
        detail: marker,
        ip: secretIp,
        userAgent: secretAgent,
        metadata: { note: secretMetadata },
      });

      const response = await request.get(AUDIT_LOGS_PATH, { headers: bearer(admin), maxRedirects: 0 });
      expect(response.status()).toBe(200);
      const text = await response.text();
      const body = JSON.parse(text) as { data?: AuditRow[] };
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data!.some((row) => row.id === seededId)).toBe(true);

      for (const row of body.data!) {
        for (const column of FORBIDDEN_COLUMNS) {
          expect(row, `行 ${String(row.id)} に ${column} がある`).not.toHaveProperty(column);
        }
        for (const key of Object.keys(row)) {
          expect(ALLOWED_COLUMNS as readonly string[], `想定外の項目 ${key}`).toContain(key);
        }
      }
      for (const secret of [secretEmail, secretIp, secretAgent, secretMetadata]) {
        expect(text).not.toContain(secret);
      }
    });
  });

  test(`SEC-ADMIN-023-AC-01 問い合わせの詳細と監査ログを読むと、読んだ店長の id とメールが入り、問い合わせの名前・メール・本文が入らない記録が2つ増える`, async ({ request }) => {
    await withPermissionScenario(async (client) => {
      const { admin } = await getActors(client);

      const marker = randomUUID();
      const inquiryName = `E2E氏名${marker.slice(0, 8)}`;
      const inquiryEmail = `e2e-admin-misc-inquirer-${marker}@example.com`;
      const inquirySubject = `E2E件名${marker.slice(0, 8)}`;
      const inquiryBody = `E2E本文-${marker}`;
      const inserted = await client.query(
        `insert into public.contact_inquiries (name, email, inquiry_type, subject, message, status)
         values ($1, $2, 'other', $3, $4, 'open') returning id::text as id`,
        [inquiryName, inquiryEmail, inquirySubject, inquiryBody],
      );
      const inquiryId = inserted.rows[0].id as string;

      try {
        const knownRows = await client.query('select id::text as id from public.audit_logs where actor_id = $1::uuid', [admin.id]);
        const knownIds = new Set(knownRows.rows.map((row) => row.id as string));
        const newRowsOfAdmin = async (): Promise<Array<Record<string, string | null>>> => {
          const result = await client.query(
            `select id::text as id, action, resource, resource_id, outcome, detail,
                    actor_id::text as actor_id, actor_email, ip, user_agent, metadata::text as metadata
               from public.audit_logs where actor_id = $1::uuid order by created_at, id`,
            [admin.id],
          );
          return (result.rows as Array<Record<string, string | null>>).filter((row) => !knownIds.has(row.id as string));
        };
        const text = (row: Record<string, string | null>, keys: string[]): string => keys.map((key) => row[key] ?? '').join(' ');
        const isContactRead = (row: Record<string, string | null>): boolean =>
          /contact/i.test(text(row, ['action', 'resource'])) && text(row, ['resource_id', 'detail', 'metadata']).includes(inquiryId);
        const isAuditLogsRead = (row: Record<string, string | null>): boolean => /audit/i.test(text(row, ['action', 'resource']));

        // 問い合わせの詳細と監査ログを1回ずつ読む
        const detail = await request.get(`/api/admin/contact/${inquiryId}`, { headers: bearer(admin), maxRedirects: 0 });
        expect(detail.status()).toBe(200);
        expect(((await detail.json()) as { data?: { name?: string } }).data?.name).toBe(inquiryName);
        const audit = await request.get(AUDIT_LOGS_PATH, { headers: bearer(admin), maxRedirects: 0 });
        expect(audit.status()).toBe(200);

        // 監査ログにその2つの読み出しの行がある
        await expect.poll(async () => {
          const rows = await newRowsOfAdmin();
          return { contactRead: rows.some(isContactRead), auditLogsRead: rows.some(isAuditLogsRead) };
        }, { timeout: 5_000 }).toEqual({ contactRead: true, auditLogsRead: true });

        const rows = await newRowsOfAdmin();
        const contactRead = rows.find(isContactRead)!;
        const auditLogsRead = rows.find(isAuditLogsRead)!;
        // どちらにもその店長の id とメールが入る
        for (const row of [contactRead, auditLogsRead]) {
          expect(row.actor_id).toBe(admin.id);
          expect(row.actor_email).toBe(admin.email);
        }
        // 問い合わせの名前・メール・本文が入らない（その店長が増やした行は全部、全ての項目を見る）
        for (const row of rows) {
          const serialized = JSON.stringify(row);
          expect(serialized).not.toContain(inquiryName);
          expect(serialized).not.toContain(inquiryEmail);
          expect(serialized).not.toContain(inquiryBody);
        }
      } finally {
        await client.query('delete from public.contact_inquiries where id = $1::uuid', [inquiryId]).catch(() => undefined);
      }
    });
  });

  test(`SEC-ADMIN-023-AC-02 問い合わせの詳細と監査ログを読むと、読んだ人の IP（x-real-ip の値）とブラウザの名乗りが記録に入り、偽の x-forwarded-for は入らない`, async ({ request }) => {
    await withPermissionScenario(async (client) => {
      const { admin } = await getActors(client);

      const marker = randomUUID();
      const inquiryEmail = `e2e-admin-misc-reader-${marker}@example.com`;
      const inserted = await client.query(
        `insert into public.contact_inquiries (name, email, inquiry_type, subject, message, status)
         values ($1, $2, 'other', $3, $4, 'open') returning id::text as id`,
        [`E2E氏名${marker.slice(0, 8)}`, inquiryEmail, `E2E件名${marker.slice(0, 8)}`, `E2E本文-${marker}`],
      );
      const inquiryId = inserted.rows[0].id as string;
      // 試験ごとに別の送り元（手元の E2E の固定の環境が x-real-ip を信頼する）と、この試験だけのブラウザの名乗り
      const octets = marker.replace(/-/g, '');
      const realIp = `198.18.${parseInt(octets.slice(0, 2), 16)}.${(parseInt(octets.slice(2, 4), 16) % 253) + 1}`;
      const spoofedIp = '203.0.113.99';
      const userAgent = `e2e-sec-admin-023-${marker}`;

      try {
        const knownRows = await client.query('select id::text as id from public.audit_logs where actor_id = $1::uuid', [admin.id]);
        const knownIds = new Set(knownRows.rows.map((row) => row.id as string));
        const headers = { ...bearer(admin), 'x-real-ip': realIp, 'x-forwarded-for': `${spoofedIp}, 10.0.0.1`, 'user-agent': userAgent };

        const detail = await request.get(`/api/admin/contact/${inquiryId}`, { headers, maxRedirects: 0 });
        expect(detail.status()).toBe(200);
        const audit = await request.get(AUDIT_LOGS_PATH, { headers, maxRedirects: 0 });
        expect(audit.status()).toBe(200);

        const readRows = async (): Promise<Array<Record<string, string | null>>> => {
          const result = await client.query(
            `select id::text as id, action, ip, user_agent from public.audit_logs
              where actor_id = $1::uuid and action = any($2::text[]) order by created_at, id`,
            [admin.id, ['admin.contact.read', 'admin.audit_logs.read']],
          );
          return (result.rows as Array<Record<string, string | null>>).filter((row) => !knownIds.has(row.id as string));
        };
        await expect.poll(async () => (await readRows()).length, { timeout: 5_000 }).toBe(2);

        const rows = await readRows();
        expect(rows.map((row) => row.action).sort()).toEqual(['admin.audit_logs.read', 'admin.contact.read']);
        for (const row of rows) {
          expect(row.ip, `${row.action} の ip が x-real-ip の値でない`).toBe(realIp);
          expect(row.user_agent, `${row.action} の user_agent`).toBe(userAgent);
          expect(JSON.stringify(row)).not.toContain(spoofedIp);
        }
      } finally {
        await client.query('delete from public.contact_inquiries where id = $1::uuid', [inquiryId]).catch(() => undefined);
      }
    });
  });
});
