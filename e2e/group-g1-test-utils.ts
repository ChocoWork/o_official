/**
 * G-1 の E2E の材料の入口（Task 17）。Task 16 の DB の材料（tests/integration/db/helpers/group-g1-fixtures.ts）を、
 * 手元の DB の見張りを付けて E2E の道具へ渡す。
 *
 * - 取引: 呼び手の取引が無ければ BEGIN → 共通の鍵（190521,1）→ 本体 → COMMIT。入れ子は SAVEPOINT で、呼び手を COMMIT しない。
 *   失敗はその取引（入れ子ならその SAVEPOINT）を戻して投げ直す。注文だけを先に COMMIT しない。
 * - 割当: 入金済みの明細は A（kind=paid）、未入金は H（kind=payment_hold）を、注文と同じ取引で作る。台帳の purchase を別に書かない。
 * - 入荷: 本物の入口（public.admin_record_stock_movement。G-1 の鍵・FIFO・履歴を通る）だけ。実行者を受け取らない道具は、
 *   手元の有効な管理者（admin.items.manage を持つ役割 admin）の材料をここで得る。
 * - 発送: 合成の発送（seedGroupG1Shipment）が A を消費する。旧の発送の関数（Task 14 で停止）の成功を装わない。
 *   画面に要る旧の副作用（受付済みの出来事・追跡の登録・最後の1点で注文を発送済みへ・知らせる時の発送のメール）は、合成の材料として明示して足す。
 * - 未入金で終わった注文（放棄・取消）は、H を作ってから同じ取引の本物の解放（private.release_stock_for_unpaid_order）で H を0にし、状態を決める。
 */
import { randomUUID } from 'node:crypto';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import {
  holdsCommonLock,
  seedGroupG1Allocation,
  seedGroupG1Restock,
  seedGroupG1Shipment,
  setOrderStatusForFixture,
  withGroupG1FixtureTransaction,
} from '../tests/integration/db/helpers/group-g1-fixtures';

/** group-g1-fixtures の見張りと同じ住所だけ（接続済みの client の host で見る。URL の文字だけを信用しない） */
const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1']);
const FIXTURE_ADMIN_EMAIL_PREFIX = 'e2e-g1-fixture-admin-';

export type E2eAllocationKind = 'paid' | 'payment_hold';
export type E2eCarrier = 'yamato' | 'sagawa' | 'japanpost';

/** 手元の DB の接続でなければ、何も問い合わせずに止める */
export function assertLocalE2eDb(db: PgClient): void {
  const host = (db as { host?: unknown }).host;
  if (typeof host !== 'string' || !LOCAL_DB_HOSTS.has(host)) throw new Error('GROUP_G_FIXTURE_LOCAL_DB_REQUIRED');
}

/** 注文の状態から割当の種類を決める。入金済みは A、未入金（受付・入金待ち・失敗）は H。ほかの状態では割当を作らない */
export function allocationKindOf(status: string): E2eAllocationKind {
  if (status === 'paid') return 'paid';
  if (status === 'pending' || status === 'payment_in_progress' || status === 'failed') return 'payment_hold';
  throw new Error('GROUP_G_ARGUMENT_INVALID');
}

/** G-1 の材料の取引（手元の DB だけ。手元でなければ拒否の Promise を返す）。入れ子は SAVEPOINT */
export async function withGroupG1Material<T>(db: PgClient, run: () => Promise<T>): Promise<T> {
  assertLocalE2eDb(db);
  return withGroupG1FixtureTransaction(db, run);
}

async function requireCommonLock(db: PgClient): Promise<void> {
  assertLocalE2eDb(db);
  if (!(await holdsCommonLock(db))) throw new Error('GROUP_G_INVENTORY_LOCK_REQUIRED');
}

/**
 * 共通の鍵の後に、色・サイズと注文の対象を本物の順（items → variants → orders → … id 昇順）で先に押さえる。
 * 注文を作る前に、使う色・サイズを全部渡して呼ぶ（注文を作った後に色・サイズの鍵を新しく取りに戻らない）。
 */
export async function lockE2eInventory(db: PgClient, input: { variantIds?: number[]; orderIds?: string[] }): Promise<void> {
  await requireCommonLock(db);
  await db.query('select private.lock_group_g_inventory($1::bigint[], $2::uuid[])', [
    [...new Set(input.variantIds ?? [])].sort((a, b) => a - b),
    [...new Set(input.orderIds ?? [])].sort(),
  ]);
}

/**
 * 手元の有効な管理者（役割 admin・期限なし）の番号。前に作った材料の管理者があれば使い、無ければ作る。
 * 材料の取引の中（共通の鍵の後）でだけ呼ぶ。
 */
export async function localFixtureAdminId(db: PgClient): Promise<string> {
  await requireCommonLock(db);
  const found = (await db.query(
    `select ur.user_id from public.user_roles as ur
       join public.roles as r on r.id = ur.role_id
       join auth.users as u on u.id = ur.user_id
      where r.code = 'admin' and ur.active and ur.expires_at is null and u.email like $1
      order by u.created_at, u.id limit 1`,
    [`${FIXTURE_ADMIN_EMAIL_PREFIX}%`],
  )).rows[0];
  if (found) return found.user_id as string;
  const id = randomUUID();
  await db.query(
    `insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     values ($1::uuid, $2, jsonb_build_object('role', 'admin'), '{}'::jsonb, now(), now())`,
    [id, `${FIXTURE_ADMIN_EMAIL_PREFIX}${id.slice(0, 8)}@example.com`],
  );
  const assigned = await db.query(
    `insert into public.user_roles (user_id, role_id, active, expires_at)
     select $1::uuid, r.id, true, null from public.roles as r where r.code = 'admin'`,
    [id],
  );
  if (assigned.rowCount !== 1) throw new Error('GROUP_G_FIXTURE_ADMIN_UNAVAILABLE');
  return id;
}

/** 入荷（本物の入口。最古の待ちへ FIFO が動く）。実行者を省くと手元の材料の管理者。台帳の番号（10進の文字）を返す */
export function seedE2eRestock(
  db: PgClient,
  input: { itemId: number; variantId: number; quantity: number; actorId?: string; requestKey?: string },
): Promise<string> {
  return withGroupG1Material(db, async () => seedGroupG1Restock(db, {
    itemId: input.itemId,
    variantId: input.variantId,
    quantity: input.quantity,
    actorId: input.actorId ?? (await localFixtureAdminId(db)),
    requestKey: input.requestKey ?? randomUUID(),
  }));
}

/**
 * 明細1行の割当（A か H）。数0は何も作らない（意図した不足・受注生産・色サイズの無い行）。
 * 呼び手が lockE2eInventory で対象を押さえた取引の中で呼ぶ。
 */
export async function seedE2eAllocation(
  db: PgClient,
  input: { orderItemId: string; quantity: number; kind: E2eAllocationKind },
): Promise<string | null> {
  await requireCommonLock(db);
  return seedGroupG1Allocation(db, input);
}

/** 合成の発送（A を消費する。cancelledAt を渡すと最初から取消済みで、消費しない）。注文を押さえてから作る */
export function seedE2eShipment(db: PgClient, input: Parameters<typeof seedGroupG1Shipment>[1]): Promise<string> {
  return withGroupG1Material(db, async () => {
    await lockE2eInventory(db, { orderIds: [input.orderId] });
    return seedGroupG1Shipment(db, input);
  });
}

/** 注文の状態を変える（J-19 が求める変更の理由を付ける）。材料の取引の中で呼ぶ */
export async function setE2eOrderStatus(
  db: PgClient, orderIds: string[], status: string, extra: { paidAmount?: number } = {},
): Promise<void> {
  await requireCommonLock(db);
  await setOrderStatusForFixture(db, orderIds, status, extra);
}

/**
 * 支払い手続き中の注文の H を、本物の解放で0にして放棄・取消へ進める（解放した品は同じ色・サイズの最古の待ちへ FIFO）。
 * 取消は実行者（省くと手元の材料の管理者）と理由（customer_request）を残し、お客様には知らせない。
 */
export async function releaseE2eUnpaidOrder(
  db: PgClient, input: { orderId: string; status: 'abandoned' | 'cancelled'; actorId?: string },
): Promise<void> {
  await requireCommonLock(db);
  const cancelled = input.status === 'cancelled';
  const actorId = cancelled ? (input.actorId ?? (await localFixtureAdminId(db))) : null;
  const row = (await db.query(
    `select released, status::text as status from private.release_stock_for_unpaid_order(
       $1::uuid, 'payment_in_progress'::public.order_status, $2::public.order_status, $3::text, $4::uuid, null, $5::text, null, $6::boolean)`,
    [input.orderId, input.status, cancelled ? 'admin_cancel' : 'stripe_checkout_expired', actorId,
      cancelled ? 'customer_request' : null, cancelled ? false : null],
  )).rows[0];
  if (!row?.released || row.status !== input.status) throw new Error('GROUP_G_FIXTURE_RELEASE_FAILED');
}

export type E2eShipmentResult = { fulfillmentId: string; number: number; completesOrder: boolean; orderStatus: string };

/**
 * 旧の発送の関数（admin_create_fulfillment。Task 14 で停止）の代わりの合成の発送。A を消費し、A が足りなければ材料の失敗
 * （GROUP_G_FIXTURE_ALLOCATION_REQUIRED。入荷や二度目の purchase で補わない）。画面に要る旧の副作用を合成の材料として足す:
 * 受付済みの出来事・追跡がオンなら登録（配達済みの材料には作らない）・未発送が0になれば注文を発送済みへ（変更の理由つき）・
 * 知らせる時は発送のメールの予定。
 */
export function shipE2eOrder(db: PgClient, input: {
  orderId: string;
  actorId?: string | null;
  lines: Array<{ orderItemId: string; quantity: number }>;
  trackingNumber: string;
  carrier?: E2eCarrier;
  notify?: boolean;
  requestKey?: string;
  /** 省くと今（deliveredAt が過去なら deliveredAt） */
  shippedAt?: string;
  deliveredAt?: string;
}): Promise<E2eShipmentResult> {
  return withGroupG1Material(db, async () => {
    await lockE2eInventory(db, { orderIds: [input.orderId] });
    const carrier = input.carrier ?? 'yamato';
    const notify = input.notify ?? false;
    // 発送した時刻を省くと今。配達済みの材料は「届いた時刻 ≧ 発送した時刻」（表の決まり）なので、過去に届いた時は届いた時刻にそろえる。
    const now = (await db.query('select now() as t')).rows[0].t as Date;
    const shippedAt = input.shippedAt ?? (input.deliveredAt && Date.parse(input.deliveredAt) < now.getTime()
      ? input.deliveredAt : now.toISOString());
    const unshipped = Number((await db.query(
      'select coalesce(sum(unshipped), 0)::integer as n from private.order_line_fulfillment($1::uuid)', [input.orderId],
    )).rows[0].n);
    const requested = input.lines.reduce((sum, line) => sum + line.quantity, 0);
    const completes = unshipped - requested === 0;
    const fulfillmentId = await seedGroupG1Shipment(db, {
      orderId: input.orderId,
      lines: input.lines,
      shippedAt,
      deliveredAt: input.deliveredAt,
      actorId: input.actorId ?? undefined,
      carrier,
      trackingNumber: input.trackingNumber,
      notifyCustomer: notify,
      requestKey: input.requestKey ?? randomUUID(),
      completesOrder: completes,
    });
    await db.query(
      `insert into public.order_fulfillment_events (fulfillment_id, tracking_version, status, happened_at, source)
       values ($1::uuid, 1, 'confirmed', $2::timestamptz, 'shipment')`,
      [fulfillmentId, shippedAt],
    );
    if (!input.deliveredAt) {
      await db.query(
        `insert into private.fulfillment_tracking_registrations (fulfillment_id, tracking_version, carrier, tracking_number, expires_at)
         select $1::uuid, 1, $2::text, upper($3::text), $4::timestamptz + interval '30 days'
         from public.shop_settings where id = 1 and delivery_tracking_enabled`,
        [fulfillmentId, carrier, input.trackingNumber, shippedAt],
      );
    }
    if (completes) await markE2eOrderShipped(db, { ...input, carrier });
    if (notify) await db.query("select private.enqueue_order_email($1::uuid, 'shipped', null, $2::uuid)", [input.orderId, fulfillmentId]);
    const row = (await db.query(
      `select f.number, o.status::text as order_status from public.order_fulfillments as f
       join public.orders as o on o.id = f.order_id where f.id = $1::uuid`,
      [fulfillmentId],
    )).rows[0];
    return { fulfillmentId, number: Number(row.number), completesOrder: completes, orderStatus: row.order_status as string };
  });
}

/** 全部を送った注文の写し（入金済み → 発送済み）。旧の発送と同じ変更の理由を付け、前の理由と実行者を戻す */
async function markE2eOrderShipped(
  db: PgClient, input: { orderId: string; actorId?: string | null; carrier: E2eCarrier; trackingNumber: string },
): Promise<void> {
  const previous = (await db.query(
    `select coalesce(pg_catalog.current_setting('app.order_change_reason', true), '') as reason,
            coalesce(pg_catalog.current_setting('app.order_actor_id', true), '') as actor`,
  )).rows[0] as { reason: string; actor: string };
  await db.query("select pg_catalog.set_config('app.order_change_reason', 'admin_create_fulfillment', true)");
  await db.query("select pg_catalog.set_config('app.order_actor_id', $1, true)", [input.actorId ?? '']);
  await db.query(
    `update public.orders set status = 'shipped', shipped_at = now(), shipping_carrier = $2, tracking_number = $3
     where id = $1::uuid and status = 'paid'`,
    [input.orderId, input.carrier, input.trackingNumber],
  );
  await db.query("select pg_catalog.set_config('app.order_change_reason', $1, true)", [previous.reason]);
  await db.query("select pg_catalog.set_config('app.order_actor_id', $1, true)", [previous.actor]);
}

/** 停止した旧の発送の操作（Task 14 の LEGACY_FULFILLMENT_DISABLED / 55000）。手での操作の成功を装わず、DB に触れずに止める */
export function legacyFulfillmentDisabled(): never {
  throw Object.assign(new Error('LEGACY_FULFILLMENT_DISABLED'), { code: '55000' });
}
