import fs from 'node:fs';
import path from 'node:path';
import type { PgClient } from './local-db';
import { isInTransaction } from './group-g1-fixtures';

/**
 * G-3 Task 4: 書き手の閉じた一覧（private.group_g_writer_allowlist()）を、取引の中で決めた一覧へ入れ替える共有の道具。
 *
 * 移行の末尾の確かめ（G2B_FINAL_ASSERT など）は「その移行を当てた時点の一覧」を固定で持つ。G-3 で一覧が65本を超えたので、
 * G-2 の確かめを今の DB で流す試験は、流す前にこの道具で一覧を G-2 の65本へ入れ替える。入れ替えは呼び出し元の取引の中だけで、
 * 戻すのは呼び出し元の rollback（savepoint への rollback を含む）。
 */

const MIGRATION_DIRECTORY = path.join(process.cwd(), 'supabase/migrations');

/** G3A の理由 CHECK は、その移行時点の17値へ戻してから再実行する。 */
export const G3A_REASON_CODES: readonly string[] = Object.freeze([
  'fifo', 'checkout', 'stripe_payment_paid', 'stock_adjustment', 'refund_restock', 'refund_release',
  'stripe_checkout_expired', 'stripe_voucher_expired', 'admin_cancel', 'admin_cancel_failed_order',
  'resolve_payment_exception', 'status_change', 'fixture_allocation', 'fixture_release', 'fixture_shipment',
  'shipment_confirm', 'shipment_cancel',
]);

/**
 * CHECK の集合を再現する。変更は呼出し元の rollback で戻す（取引の外では最初の文が断る）。
 *
 * commit 済みの本物の行（別の試験が commit した割当の入替の reason='allocation_swap' など）が、再現する集合の外の理由を持つと、
 * 検証付きの ADD CONSTRAINT が「行が違反」で落ちる。そこで、この取引の中だけで追記専用の更新ガードを一時に外し、集合の外の
 * 理由を NULL にしてガードを戻してから CHECK を付け替える。ガードは assert が流れる前に必ず有効に戻り、行は消さず、
 * 取引全体は呼出し元が rollback するので commit 済みの実データは変わらない。
 *
 * 更新が遅延の数の確かめ（group_g_allocation_bounds）の待ちイベントを作ると、その表への ALTER が
 * 「pending trigger events」で落ちる。そこで確かめを一時に即時にして、待ちを先に流してから更新・付け替えを行い、
 * 最後に初期の遅延へ戻す。呼出し元はこの制約を IMMEDIATE にしてから呼んではならず、初期の遅延の状態で呼ぶこと。
 * 更新するのは reason だけで、確かめは割当の整合を見るので通る。
 */
export function replaceReasonCheckSql(reasons: readonly string[]): string {
  const set = reasons.map((reason) => `'${reason.replaceAll("'", "''")}'`).join(', ');
  return `do $reason_guard$ begin
      if pg_catalog.statement_timestamp() = pg_catalog.transaction_timestamp() then
        raise exception 'GROUP_G_REASONS_TRANSACTION_REQUIRED' using errcode = '55000';
      end if;
    end $reason_guard$;
    set constraints public.group_g_allocation_bounds immediate;
    alter table public.order_item_allocation_events disable trigger order_item_allocation_events_no_update;
    update public.order_item_allocation_events set reason = null where reason is not null and reason <> all(array[${set}]::text[]);
    alter table public.order_item_allocation_events enable trigger order_item_allocation_events_no_update;
    alter table public.order_item_allocation_events drop constraint order_item_allocation_events_reason_check;
    alter table public.order_item_allocation_events add constraint order_item_allocation_events_reason_check CHECK (
      reason IS NULL OR reason IN (${set}));
    set constraints public.group_g_allocation_bounds deferred`;
}

/** 呼出し元の取引内で当時の理由集合を復元してから assert を流す。 */
export async function runWithReasonCodes(client: PgClient, reasons: readonly string[], assertSql: string): Promise<void> {
  if (!(await isInTransaction(client))) throw new Error('GROUP_G_REASONS_TRANSACTION_REQUIRED');
  await client.query(replaceReasonCheckSql(reasons));
  await client.query(assertSql);
}

/** 'private.name(args)' の形の行を並びのまま集める */
function signaturesIn(text: string): string[] {
  return [...text.matchAll(/^\s*'((?:private|public)\.[a-z_0-9]+\([^']*\))',?\s*$/gm)].map((match) => match[1]);
}

/** G2B の移行ファイルの末尾の確かめが持つ v_writers の配列リテラルから、G-2 の65本を並びのまま読み取って固定する */
function readG2Allowlist(): readonly string[] {
  const file = fs.readdirSync(MIGRATION_DIRECTORY).filter((name) => name.endsWith('_group_g2_purchasing_writers.sql'));
  if (file.length !== 1) throw new Error('GROUP_G_G2B_MIGRATION_MISSING');
  const sql = fs.readFileSync(path.join(MIGRATION_DIRECTORY, file[0]), 'utf8');
  const start = sql.indexOf('v_writers text[] := ARRAY[');
  const end = start < 0 ? -1 : sql.indexOf('];', start);
  if (start < 0 || end < 0) throw new Error('GROUP_G_G2B_WRITERS_MISSING');
  const entries = signaturesIn(sql.slice(start, end));
  if (entries.length !== 65 || new Set(entries).size !== 65) throw new Error('GROUP_G_G2B_WRITERS_NOT_65');
  return Object.freeze(entries);
}

/** G-2 の書き手の閉じた一覧（G-1 の56本 + 発注書の9本 = 65本） */
export const G2_ALLOWLIST: readonly string[] = readG2Allowlist();

/**
 * G-3 の移行 group_g3_shipping_slips（G3C）が、その時点までに存在する書き手だけで持つ一覧。
 * Task 4: 下書きの保存・破棄の2本で67本。Task 5 で確定の書き手を足して70本、Task 6 で戻し・取消を足して72本、…（まだ存在しない関数の署名を
 * ::regprocedure に通さない）。この定数で G3C の末尾の確かめを流すのは Task 10。
 */
export const G3C_ALLOWLIST: readonly string[] = Object.freeze([
  ...G2_ALLOWLIST,
  'private.admin_save_shipment_slip_draft(uuid,integer,jsonb,uuid,uuid)',
  'private.admin_discard_shipment_slip_draft(uuid,integer,uuid,uuid)',
  'private.consume_group_g_allocations(uuid,integer,uuid,uuid)',
  'private.register_group_g_slip_tracking(uuid,integer,uuid,uuid)',
  'private.admin_confirm_shipment_slip(uuid,integer,text,text,date,boolean,uuid,uuid)',
  'private.restore_group_g_shipment(uuid,uuid,uuid,uuid,text)',
  'private.admin_cancel_shipment_slip(uuid,integer,uuid,uuid)',
]);

/**
 * G-3 の移行 group_g3_shipping_actions（G3D）が、その時点までに存在する書き手だけで持つ一覧（G3C の72本 + 伝票番号の後入力・訂正と手動の
 * 配達済み・出荷日訂正の3本 = 75本）。G-4 Task 4 までの DB の書き手の一覧はこれと同じだった（今の一覧は CURRENT_ALLOWLIST）。
 * G3C の末尾の確かめを今の DB で流す試験は、流す前に G3C_ALLOWLIST（72本）へ入れ替える。
 */
export const G3D_ALLOWLIST: readonly string[] = Object.freeze([
  ...G3C_ALLOWLIST,
  'private.admin_update_shipment_slip_tracking(uuid,integer,text,text,boolean,uuid,uuid)',
  'private.admin_mark_shipment_slip_delivered(uuid,integer,date,boolean,uuid,uuid)',
  'private.admin_correct_shipment_date(uuid,integer,date,text,uuid,uuid)',
]);

/**
 * G-4 の移行 group_g4_orders_swap（G4C）が持つ書き手の一覧（G3D の75本 + 割当の入替 private.admin_swap_order_allocations の1本 = 76本）。
 * 今の DB の書き手の一覧はこれと同じ。G3D の末尾の確かめや G4A の確かめを今の DB で流す試験は、流す前に G3D_ALLOWLIST（75本）へ入れ替える。
 */
export const G4_ALLOWLIST: readonly string[] = Object.freeze([
  ...G3D_ALLOWLIST,
  'private.admin_swap_order_allocations(uuid,uuid,uuid,integer,text,uuid,uuid)',
]);

/**
 * グループ H の移行 group_h_discounts_acceptance（H4）が持つ書き手の一覧（G4 の76本 + 入金照合用の受付
 * private.place_reconciled_order_from_checkout_draft の1本 = 77本）。redemption だけを書く H の helper は G の一覧に混ぜない。
 * 今の DB の書き手の一覧はこれと同じ。G の末尾の確かめを今の DB で流す試験は、流す前に自分の時点の一覧（G4_ALLOWLIST など）へ入れ替える。
 */
export const H4_ALLOWLIST: readonly string[] = Object.freeze([
  ...G4_ALLOWLIST,
  'private.place_reconciled_order_from_checkout_draft(uuid,text,text,integer,integer,text,timestamptz,text,text)',
]);

// H7 and RR replace existing writers in place; the 77 OIDs stay the same.
// RR's return_receive_amounts is a read helper and must never enter this writer list.
export const H7_ALLOWLIST: readonly string[] = H4_ALLOWLIST;

/**
 * 交換の印の移行 C（FREQ-642）で、受け取りの入口が15の引数（末尾に値段の計画 jsonb）になり、14の引数の関数は落ちた。
 * 本数は同じ77本で、入れ替わったのは受け取りの署名の1本だけ（今の一覧は UB_ALLOWLIST）。
 * それより前の時点の一覧（G2〜H の一覧）は14の引数の署名を持つ。その時点の末尾の確かめを今の DB で再生する試験は、
 * 一覧を入れ替える文（replaceAllowlistSql）に含まれる14の引数の署名を型に通せるよう、同じ性質（DEFINER・search_path 空・
 * service_role だけ EXECUTE）の14の引数の関数を、呼び出し元の取引の中だけに作る（巻き戻しで消える）。
 */
export const RECEIVE_RETURN_14 = 'private.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text)';
export const RECEIVE_RETURN_15 = 'private.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text,jsonb)';
export const UB_ALLOWLIST: readonly string[] = Object.freeze(H7_ALLOWLIST.map((entry) => (entry === RECEIVE_RETURN_14 ? RECEIVE_RETURN_15 : entry)));
/**
 * 交換の印の移行 D（FREQ-642）で、返金の入口3本が値段の計画（末尾の引数）を受けるようになり、13・15・7の引数の関数は落ちた。
 * 本数は同じ77本で、入れ替わったのは begin_order_refund（13→14）・begin_order_refund_core（15→16）・admin_refund_return（7→8）の署名の3本。
 * それより前の時点の一覧が名指す、今は無い署名は、replaceAllowlistSql が取引の中だけの代わりの関数（巻き戻しで消える）を立てて型に通す。
 */
export const REFUND_SIGNATURE_SWAPS: readonly (readonly [string, string])[] = Object.freeze([
  ['private.begin_order_refund(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer)',
    'private.begin_order_refund(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,jsonb)'],
  ['private.begin_order_refund_core(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,uuid,integer)',
    'private.begin_order_refund_core(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,uuid,integer,uuid)'],
  ['private.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean)', 'private.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean,jsonb)'],
]);
export const UB_REFUNDS_ALLOWLIST: readonly string[] = Object.freeze(UB_ALLOWLIST.map((entry) => REFUND_SIGNATURE_SWAPS.find(([from]) => from === entry)?.[1] ?? entry));

/**
 * 今の DB の書き手の一覧。「今の DB の一覧が固定の集合や本数と等しい」ことを確かめる生きた検査は、すべてこの定数に向ける。
 * 次の段階が本数を足す時は、この指し先だけを新しい一覧へ付け替える（時点の再実行が使う G3C/G3D/G4_ALLOWLIST は変えない）。
 */
export const CURRENT_ALLOWLIST: readonly string[] = UB_REFUNDS_ALLOWLIST;

/** 移行 C より前の時点の確かめを再生するための、14の引数の受け取りの入口（取引の中だけ。本体は15の引数へ渡すだけ） */
const LEGACY_RECEIVE_STUB_SQL = `create or replace function private.admin_receive_return(_return_id uuid, _actor_id uuid, _actor_can_refund boolean, _request_key uuid,
      _units jsonb, _exchange_overrides jsonb, _refund_choice text, _refund_amount integer, _refund_shipping_amount integer, _note text,
      _notify_customer boolean, _sent_back_message text, _sent_back_carrier text, _sent_back_tracking_number text)
    returns table(receipt_id uuid, return_status text, refund_id uuid, refund_amount integer, refund_status text, exchange_order_item_ids uuid[],
      fee_due_amount integer, shop_notice_enqueued boolean, replayed boolean)
    language sql security definer set search_path = '' as $stub$
      select r.receipt_id, r.return_status, r.refund_id, r.refund_amount, r.refund_status, r.exchange_order_item_ids, r.fee_due_amount,
        r.shop_notice_enqueued, r.replayed from private.admin_receive_return(_return_id, _actor_id, _actor_can_refund, _request_key, _units,
        _exchange_overrides, _refund_choice, _refund_amount, _refund_shipping_amount, _note, _notify_customer, _sent_back_message,
        _sent_back_carrier, _sent_back_tracking_number, null) as r $stub$;
    alter function ${RECEIVE_RETURN_14} owner to postgres;
    revoke all on function ${RECEIVE_RETURN_14} from public, anon, authenticated, service_role;
    grant execute on function ${RECEIVE_RETURN_14} to service_role;`;

/** 書き手の閉じた一覧を、渡した一覧へ置き換える文（関数の所有者・SECURITY DEFINER・search_path 空は移行と同じ）。14の引数の受け取りを含む一覧には、その入口を取引の中に作る文を前に付ける */
/** 一覧が名指す署名のうち今の DB に無い物（移行 C・D で落ちた旧い署名）の代わりの関数を、取引の中だけに立てる文 */
function missingSignatureStubsSql(entries: readonly string[]): string {
  const list = entries.map((entry) => `'${entry}'`).join(', ');
  return `do $stubs$ declare s text; begin
    foreach s in array array[${list}] loop
      if pg_catalog.to_regprocedure(s) is null and s <> '${RECEIVE_RETURN_14}' then
        execute pg_catalog.format('create function %s returns void language sql security definer set search_path = '''' as ''select null::void''', s);
        execute pg_catalog.format('alter function %s owner to postgres', s);
        execute pg_catalog.format('revoke all on function %s from public, anon, authenticated, service_role', s);
      end if;
    end loop; end $stubs$;
    `;
}

export function replaceAllowlistSql(entries: readonly string[], options: { stub?: boolean } = {}): string {
  const stub = (options.stub ?? true) && entries.includes(RECEIVE_RETURN_14) ? `${LEGACY_RECEIVE_STUB_SQL};
` : '';
  return `${stub}${missingSignatureStubsSql(entries)}create or replace function private.group_g_writer_allowlist()
    returns pg_catalog.regprocedure[] language sql stable security definer set search_path = ''
    as $f$ select array[${entries.map((entry) => `'${entry}'`).join(', ')}]::pg_catalog.regprocedure[] $f$`;
}

/**
 * H4 の移行が置いた書き手の一覧の関数の本文そのまま（H4・H5・H7・RR の確かめは、この関数の本文の指紋も確かめる）。
 * 14の引数の受け取りの署名を含むので、stub を true にすると、その入口を取引の中に立てる文を前に付ける。
 */
export function restoreH4AllowlistSql(options: { stub?: boolean } = {}): string {
  const text = fs.readFileSync(path.join(MIGRATION_DIRECTORY, '20261029130300_group_h_discounts_acceptance.sql'), 'utf8');
  const body = text.match(/^CREATE OR REPLACE FUNCTION private\.group_g_writer_allowlist\(\)[\s\S]*?^\$\$;/m)?.[0];
  if (!body) throw new Error('GROUP_H_H4_ALLOWLIST_FUNCTION_MISSING');
  return `${options.stub ?? true ? `${LEGACY_RECEIVE_STUB_SQL};
` : ''}${missingSignatureStubsSql(H4_ALLOWLIST)}${body}`;
}

/** 呼び出し元の取引の中で一覧を入れ替えてから、末尾の確かめの節を流す。戻すのは呼び出し元の rollback */
export async function runWithAllowlist(client: PgClient, entries: readonly string[], assertSql: string): Promise<void> {
  if (!(await isInTransaction(client))) throw new Error('GROUP_G_ALLOWLIST_TRANSACTION_REQUIRED');
  await client.query(replaceAllowlistSql(entries));
  await client.query(assertSql);
}
