/**
 * 権限の設定（グループ G-0）の E2E の道具。FR-ADMIN-109・FR-ADMIN-123 が使う。
 *
 * 画面 → 窓口の差し替え（bridge）→ 手元の DB の関数、の道で確かめる。本物の窓口（route）は通らない。
 * 本物の管理者のログインには2段階認証が要るので、画面の GET/POST だけを、同じ DB の関数
 * （public.admin_get_permissions・public.admin_set_role_permissions）へ手元の DB の接続から橋渡しする。
 * 窓口の認可・MFA・CSRF・回数の制限・操作の監査は Task 2 の単体、DB の権限（grants）・トリガー・別接続の競合は
 * Task 1 の DB 結合が確かめる（この道具の範囲の外）。
 *
 * 権限の表（role_permissions）と版（roles.permissions_version）は手元の DB の共有の状態なので、
 * withPermissionScenario が advisory lock（190520, 0）で別のプロセス・別のファイルの試験と直列にし、
 * 終わりに 30 コードの中の付与と版を差分で元へ戻す。固定2行と 30 コードの外には触れない。
 * 追記の表（role_permission_events・private.role_permission_requests）は消さずに request_key で絞る（残りは db reset で消える）。
 * 実メール・外部のサービスは呼ばない。
 */
import { randomUUID } from 'node:crypto';
import type { Page, Route } from '@playwright/test';
import type { AppRole, PermissionCode } from '@/lib/auth/admin-rbac';
import { ROLE_PERMISSION_CATALOG } from '@/lib/auth/role-permission-catalog';
import type { PermissionRole, PermissionRoleState, PermissionsMatrix, RolePermissionChange } from '@/lib/auth/role-permission-types';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { mockAdminBackgroundApis } from './admin-test-utils';
import { withLocalDb } from './order-email-test-utils';

/** 権限の設定の場面を直列にする session lock の鍵（保存の関数の 190519 とは別） */
const SCENARIO_LOCK = '190520, 0';
/** 保存の関数と同じ xact lock。元へ戻す間、保存と役割の変更を止める */
const SAVE_LOCK = '190519, 0';

export const MANAGED_PERMISSION_CODES: readonly PermissionCode[] = ROLE_PERMISSION_CATALOG.map((permission) => permission.code);
export const FIXED_PERMISSION_CODES: readonly PermissionCode[] = ['admin.permissions.manage', 'admin.users.manage'];
/** サポーターの最初の 8 コード（Task 1 の表。辞書順） */
export const SUPPORTER_INITIAL_CODES: readonly PermissionCode[] = [
  'admin.contact.manage',
  'admin.contact.read',
  'admin.orders.manage',
  'admin.orders.read',
  'admin.orders.return',
  'admin.shipping.manage',
  'admin.shipping.read',
  'admin.users.read',
];

const ROLE_LABELS: Readonly<Record<PermissionRole, string>> = { admin: '店長', supporter: 'サポーター' };

/** 窓口（route）と同じ拒否の対応（message と SQLSTATE の組 → status・文）。Task 2 の表のとおり */
const REFUSALS: Readonly<Record<string, { sqlstate: string; status: number; error: string }>> = {
  ROLE_PERMISSION_ARGUMENT_INVALID: { sqlstate: '22023', status: 400, error: '入力を確かめてください。' },
  ROLE_PERMISSION_FORBIDDEN: { sqlstate: '42501', status: 403, error: '権限を変更する権限がありません。' },
  ROLE_PERMISSION_FIXED: { sqlstate: '42501', status: 403, error: '権限管理と利用者管理は店長のみ・変更不可です。' },
  ROLE_PERMISSION_VERSION_CONFLICT: {
    sqlstate: 'P0001', status: 409, error: 'ほかの人が権限を変更しました。現在の設定を読み直してください。',
  },
  ROLE_PERMISSION_REQUEST_KEY_CONFLICT: {
    sqlstate: 'P0001', status: 409, error: '同じ要求番号で異なる変更は保存できません。現在の設定を読み直してください。',
  },
};

export type BridgeReply = { status: number; body: unknown };

type RoleRow = { code: PermissionRole; version: string; permissionCodes: PermissionCode[] };

type Snapshot = {
  grants: Array<{ role: string; permission: string }>;
  versions: Array<{ code: string; version: string }>;
};

/** DB の拒否を、窓口と同じ { error, code } と status にする。決まった組でなければ null（生の DB の文は出さない） */
function refusalReply(error: unknown): BridgeReply | null {
  if (!error || typeof error !== 'object') return null;
  const { message, code } = error as { message?: unknown; code?: unknown };
  if (typeof message !== 'string' || !Object.prototype.hasOwnProperty.call(REFUSALS, message)) return null;
  const refusal = REFUSALS[message];
  if (code !== refusal.sqlstate) return null;
  return { status: refusal.status, body: { error: refusal.error, code: message } };
}

function toRoleState(role: RoleRow): PermissionRoleState {
  return { code: role.code, label: ROLE_LABELS[role.code], version: role.version, permissionCodes: [...role.permissionCodes] };
}

async function snapshotOf(client: PgClient): Promise<Snapshot> {
  const grants = await client.query(
    `select r.code as role, p.code as permission
       from public.role_permissions rp
       join public.roles r on r.id = rp.role_id
       join public.permissions p on p.id = rp.permission_id
      where r.code in ('admin', 'supporter') and p.code = any($1::text[])
      order by r.code, p.code`,
    [MANAGED_PERMISSION_CODES],
  );
  const versions = await client.query(
    `select code, permissions_version::text as version from public.roles where code in ('admin', 'supporter') order by code`,
  );
  return { grants: grants.rows, versions: versions.rows };
}

/** 30 コードの中の付与と版だけを、差分で元へ戻す。店長の固定2行は消さない（30 コードの外とほかの役割も触れない） */
async function restoreSnapshot(client: PgClient, snapshot: Snapshot): Promise<void> {
  await client.query('begin');
  try {
    await client.query(`select pg_catalog.pg_advisory_xact_lock(${SAVE_LOCK})`);
    await client.query(
      `delete from public.role_permissions rp
        using public.roles r, public.permissions p
        where rp.role_id = r.id and rp.permission_id = p.id
          and r.code in ('admin', 'supporter') and p.code = any($1::text[])
          and not (r.code = 'admin' and p.code = any($2::text[]))
          and not exists (
            select 1 from jsonb_to_recordset($3::jsonb) as s(role text, permission text)
             where s.role = r.code and s.permission = p.code)`,
      [MANAGED_PERMISSION_CODES, FIXED_PERMISSION_CODES, JSON.stringify(snapshot.grants)],
    );
    await client.query(
      `insert into public.role_permissions (role_id, permission_id)
       select r.id, p.id
         from jsonb_to_recordset($1::jsonb) as s(role text, permission text)
         join public.roles r on r.code = s.role
         join public.permissions p on p.code = s.permission
       on conflict do nothing`,
      [JSON.stringify(snapshot.grants)],
    );
    await client.query(
      `update public.roles r set permissions_version = s.version::bigint
         from jsonb_to_recordset($1::jsonb) as s(code text, version text)
        where r.code = s.code and r.permissions_version is distinct from s.version::bigint`,
      [JSON.stringify(snapshot.versions)],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

/**
 * 権限の設定の場面を、手元の DB の接続1本で行う。
 * 1. session lock（190520, 0）を取ってから、30 コードの中の付与と版を控える
 * 2. run を流す（bridge と試験の DB の読み取りは、この接続を使う）
 * 3. finally で控えへ差分で戻し、さらに内側の finally で lock を外す。接続は withLocalDb が閉じる
 */
export async function withPermissionScenario(run: (client: PgClient) => Promise<void>): Promise<void> {
  await withLocalDb(async (client) => {
    await client.query(`select pg_catalog.pg_advisory_lock(${SCENARIO_LOCK})`);
    let snapshot: Snapshot | null = null;
    try {
      snapshot = await snapshotOf(client);
      await run(client);
    } finally {
      try {
        if (snapshot) await restoreSnapshot(client, snapshot);
      } finally {
        await client.query(`select pg_catalog.pg_advisory_unlock(${SCENARIO_LOCK})`);
      }
    }
  });
}

/**
 * 試験の実行者。auth.users の role（app_metadata）と、有効な user_roles（active・期限なし）を同じ役割で作る。
 * 作った行は消さない（db reset で消える。履歴の actor_id は外部キーを持たない写し）。
 */
export async function createPermissionActor(client: PgClient, role: AppRole): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     values ($1::uuid, $2, jsonb_build_object('role', $3::text), '{}'::jsonb, now(), now())`,
    [id, `e2e-g0-${role}-${id.slice(0, 8)}@example.com`, role],
  );
  const assigned = await client.query(
    `insert into public.user_roles (user_id, role_id, active, expires_at)
     select $1::uuid, r.id, true, null from public.roles r where r.code = $2`,
    [id, role],
  );
  if (assigned.rowCount !== 1) throw new Error(`役割 ${role} の行が手元の DB に無い`);
  return id;
}

/** 実行者の有効な割り当てを全部無効にする（役割名は auth.users に残るが、ACL は無い「権限なし」の人にする） */
export async function deactivatePermissionActor(client: PgClient, actorId: string): Promise<void> {
  await client.query('update public.user_roles set active = false where user_id = $1::uuid', [actorId]);
}

/** GET /api/admin/permissions と同じ答えを、DB の関数 public.admin_get_permissions から作る */
export async function loadPermissionsInDb(client: PgClient, actorId: string): Promise<BridgeReply> {
  try {
    const result = await client.query('select public.admin_get_permissions($1::uuid) as result', [actorId]);
    const raw = result.rows[0].result as { permissionCodes: PermissionCode[]; roles: RoleRow[] };
    const data: PermissionsMatrix = {
      permissions: ROLE_PERMISSION_CATALOG.map((permission) => ({ ...permission, requires: [...permission.requires] })),
      roles: [...raw.roles].sort((a, b) => (a.code === b.code ? 0 : a.code === 'admin' ? -1 : 1)).map(toRoleState),
    };
    return { status: 200, body: { data } };
  } catch (error) {
    const refusal = refusalReply(error);
    if (refusal && (refusal.body as { code: string }).code === 'ROLE_PERMISSION_FORBIDDEN') return refusal;
    return { status: 500, body: { error: '権限を読み込めませんでした。', code: 'PERMISSION_LOAD_FAILED' } };
  }
}

/** POST /api/admin/role-permissions と同じ答えを、DB の関数 public.admin_set_role_permissions から作る（1回呼ぶと DB に保存される） */
export async function saveRolePermissionsInDb(client: PgClient, actorId: string, change: RolePermissionChange): Promise<BridgeReply> {
  try {
    const result = await client.query(
      'select public.admin_set_role_permissions($1::uuid, $2::text, $3::text[], $4::bigint, $5::uuid) as result',
      [actorId, change.roleCode, change.permissionCodes, change.expectedVersion, change.requestKey],
    );
    const raw = result.rows[0].result as { role: RoleRow; changedCount: number };
    return { status: 200, body: { data: { role: toRoleState(raw.role), changedCount: raw.changedCount } } };
  } catch (error) {
    return refusalReply(error)
      ?? { status: 500, body: { error: '権限を保存できませんでした。', code: 'PERMISSION_UPDATE_FAILED' } };
  }
}

async function answer(route: Route, reply: BridgeReply): Promise<void> {
  await route.fulfill({
    status: reply.status,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(reply.body),
  });
}

/**
 * 画面の GET（権限の表）と POST（1役割の保存）を、手元の DB の関数へ橋渡しする。actorId は DB の関数へ渡す実行者。
 * 窓口の認可・CSRF・回数の制限・監査は通らない（この道具の範囲の外）。
 * 後から登録した page.route が先に効くので、試験が答えを止めたり失敗させたりする時は、これより後に登録して route.fallback() で渡す。
 */
export async function mockPermissionUiBridge(page: Page, client: PgClient, actorId: string): Promise<void> {
  await page.route((url) => url.pathname === '/api/admin/permissions', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await answer(route, await loadPermissionsInDb(client, actorId));
  });
  await page.route((url) => url.pathname === '/api/admin/role-permissions', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    const change = route.request().postDataJSON() as RolePermissionChange;
    await answer(route, await saveRolePermissionsInDb(client, actorId, change));
  });
}

/** 画面が送った保存の本文を、送った順に控える（差し替えの前に記録されるので、止めた要求も入る） */
export function recordPermissionPosts(page: Page): RolePermissionChange[] {
  const posts: RolePermissionChange[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/admin/role-permissions') {
      posts.push(request.postDataJSON() as RolePermissionChange);
    }
  });
  return posts;
}

/** 一般利用者（role=user）としてログインした形にする。管理画面が裏で読む窓口も固定する（mockAdminSessionAs と同じやり方） */
export async function mockUserSession(page: Page): Promise<void> {
  await mockAdminBackgroundApis(page);
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authenticated: true,
        user: { id: 'u', email: 'user@example.com', role: 'user', mfaVerified: true },
      }),
    }));
}

export type RolePermissionDbState = { version: string; permissionCodes: PermissionCode[] };

/** その役割の、30 コードの中の付与（JS の sort の順にそろえる。DB の照合順に頼らない）と版 */
export async function readRolePermissionState(client: PgClient, role: PermissionRole | 'user'): Promise<RolePermissionDbState> {
  const result = await client.query(
    `select r.permissions_version::text as version,
            coalesce((select array_agg(p.code order by p.code)
                        from public.role_permissions rp
                        join public.permissions p on p.id = rp.permission_id
                       where rp.role_id = r.id and p.code = any($2::text[])), '{}') as codes
       from public.roles r where r.code = $1`,
    [role, MANAGED_PERMISSION_CODES],
  );
  return { version: result.rows[0].version as string, permissionCodes: [...(result.rows[0].codes as PermissionCode[])].sort() };
}

export type PermissionEventRow = { request_key: string; role: string; permission_code: string; action: string; actor_id: string };

/** その要求の番号の、権限の変更の記録（追記の表）を、書いた順に読む */
export async function readPermissionEvents(client: PgClient, requestKeys: readonly string[]): Promise<PermissionEventRow[]> {
  const result = await client.query(
    `select request_key::text as request_key, role, permission_code, action, actor_id::text as actor_id
       from public.role_permission_events where request_key = any($1::uuid[])
      order by created_at, id`,
    [requestKeys],
  );
  return result.rows as PermissionEventRow[];
}

/** その要求の番号の、受付の記録（private.role_permission_requests）の数 */
export async function countPermissionRequests(client: PgClient, requestKeys: readonly string[]): Promise<number> {
  const result = await client.query(
    'select count(*)::int as n from private.role_permission_requests where request_key = any($1::uuid[])',
    [requestKeys],
  );
  return result.rows[0].n as number;
}

/** 版（bigint の10進の文字）に n を足す */
export function versionPlus(version: string, n: number): string {
  return (BigInt(version) + BigInt(n)).toString();
}
