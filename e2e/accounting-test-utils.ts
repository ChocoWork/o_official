/**
 * 会計の新しい E2E（FR-ADMIN-128..131）の道具。本物の route・本物の画面・手元の Supabase だけを使う。応答は作り物にしない。
 * 表示だけを確かめる差し替え（FR-ADMIN-129 の上限の応答）は spec 側で明示する。実 Stripe の呼び出しは無い。
 *
 * 期間と仕訳は消せない（DELETE を断るトリガー）。E2E を流す前に db reset して基準の状態から始め、次の3つで扱う。
 * 1. 試験ごとの期間は「個人の期間の池」から取る。池は seedAccountingPeriod（その事業の形の最後の期間の次に続く期間）で
 *    2030 年以降の空の期間を最初の1回だけまとめて足したもの。取る時は空き（仕訳が1本も無い・最後の期間でない）を
 *    advisory lock（鍵の組 190529 / period id）で自分の接続に結ぶ。別の試験とは期間が重ならない。
 * 2. 「やめた日」を一度入れると、個人の期間はこれより後に作れない（DB の決まり）。だから池は、やめた日を入れる試験
 *    （FR-ADMIN-128）が入れる前に必ず足しておく（ensurePool）。入れた後は足せず、池から取るだけにする。
 *    やめた日は池の一番後ろの期間（最後の期間）の中に置く。池の期間の日付はそれより前なので、ほかの試験は止まらない。
 * 3. 設定（開業日・やめた日）と池の足し方は共有の状態なので、書く試験は全体の lock（190528 / 1）を取って直列にする。
 * 後片付けは、自分が作った取引の論理削除と、試験用の session だけ。試験用の利用者・期間・仕訳・証憑は消さない（db reset で消える）。
 *
 * 各試験は固有の x-real-ip（playwright.config.ts と同じ 198.19.0.0/16）を使う。回数の制限は無効にしない。
 */
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { expect, request as playwrightRequest, type APIRequestContext, type Page } from '@playwright/test';
import { japanToday, seedAccountingPeriod } from '../tests/integration/db/helpers/accounting-fixtures';
import {
  addDisputeHistory,
  confirmSlipAt as confirmSlipAtFixture,
  correctShipmentDate as correctShipmentDateFixture,
  seedConfirmedSlip as seedConfirmedSlipFixture,
  seedDispute as seedDisputeFixture,
  seedDisputeReversal as seedDisputeReversalFixture,
  seedStripeCharge as seedStripeChargeFixture,
  seedStripeFee as seedStripeFeeFixture,
  type SeedSlipOrder,
} from '../tests/integration/db/helpers/accounting-orders-fixtures';
import { seedHOrderUnits } from '../tests/integration/db/helpers/group-h-fixtures';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { createCatalogFixture } from '../tests/integration/db/helpers/order-fixtures';
import { mockAdminBackgroundApis } from './admin-test-utils';
import { withGroupG1Material } from './group-g1-test-utils';
import { createAdminSessionActor, type AdminSessionActor, type AdminSessionAal, type AdminSessionRole } from './admin-session-test-utils';
import { withLocalDb } from './order-email-test-utils';
import { withPermissionScenario } from './permission-settings-test-utils';

const ORIGIN = 'http://localhost:3000';
/** 設定（開業日・やめた日）と池の足し方を直列にする lock の鍵 */
const GLOBAL_LOCK = '190528, 1';
/** 法人の期間を足す試験を直列にする lock の鍵 */
const CORPORATE_LOCK = '190528, 2';
/** 池の期間を試験の接続に結ぶ lock の鍵の組の1つ目 */
const CLAIM_CLASS = 190529;
/** 池に入れる最初の年（今の日本時間の年+1 より後。自動で作られる期間と重ねない） */
const POOL_FIRST_YEAR = 2030;
/** 池の空きの目標。やめた日の前に足す */
const POOL_FREE_TARGET = 60;

export const ACCOUNTING_EXPENSE_CATEGORY = '広告宣伝費';
const ACCOUNTING_EXPENSE_METHOD = '現金';

export type ApiReply = { status: number; body: any; text: string };

export type ExpenseInput = {
  date: string;
  amount: number;
  item?: string;
  category?: string;
  paymentMethod?: string;
  entryType?: 'expense' | 'income';
  partner?: string;
  memo?: string;
};

export type PoolPeriod = { id: string; name: string; year: number; startsOn: string; endsOn: string; version: string };

export type ScenarioOptions = {
  /** 'pool'（既定）: 池の空きの期間を1つ取る。'none': 取らない（periodId を読むと投げる） */
  period?: 'pool' | 'none';
  /** true: 全体の lock を試験の終わりまで持つ（設定を書き換える試験） */
  exclusive?: boolean;
  /** true: 法人の期間を足す試験の lock を持つ */
  corporateChain?: boolean;
};

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
/** YYYY-MM-DD に日数を足す（UTC の日付計算。夏時間は無い） */
export const addDaysIso = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const ip198 = (): string => `198.19.${randomInt(0, 256)}.${randomInt(1, 255)}`;

type PoolRow = { id: string; name: string; starts_on: string; ends_on: string; version: string };
const toPoolPeriod = (row: PoolRow): PoolPeriod => ({
  id: row.id,
  name: row.name,
  year: Number(row.starts_on.slice(0, 4)),
  startsOn: row.starts_on,
  endsOn: row.ends_on,
  version: String(row.version),
});

const PERIOD_COLUMNS = `p.id, p.name, to_char(p.starts_on, 'YYYY-MM-DD') as starts_on, to_char(p.ends_on, 'YYYY-MM-DD') as ends_on, p.version::text as version`;

/** 池の空き（2030 年以降・個人・最後の期間でない・仕訳が1本も無い・申告の設定が新しい期間の既定値のまま）。年の順 */
async function freePoolPeriods(db: PgClient): Promise<PoolPeriod[]> {
  const rows = await db.query(
    `select ${PERIOD_COLUMNS}
       from public.accounting_periods p
      where p.business_type = 'soleProprietor' and p.starts_on >= make_date($1, 1, 1)
        and p.starts_on < (select max(q.starts_on) from public.accounting_periods q where q.business_type = 'soleProprietor')
        and not exists (select 1 from public.accounting_journal_entries e where e.period_id = p.id)
        and p.consumption_tax_status = 'exempt' and p.consumption_taxable_from is null
        and p.corporate_tax_extension_months = 0 and p.consumption_tax_extension_months = 0
      order by p.starts_on`,
    [POOL_FIRST_YEAR],
  );
  return (rows.rows as PoolRow[]).map(toPoolPeriod);
}

async function soleBusinessEnded(db: PgClient): Promise<boolean> {
  const row = await db.query('select sole_business_ended_on is not null as ended from public.accounting_settings where id = 1');
  return row.rows[0].ended === true;
}

/** 個人の期間のうち一番後ろ（やめた日を置く期間） */
export async function soleTail(db: PgClient): Promise<PoolPeriod> {
  const rows = await db.query(
    `select ${PERIOD_COLUMNS} from public.accounting_periods p where p.business_type = 'soleProprietor' order by p.starts_on desc limit 1`,
  );
  if (rows.rows.length !== 1) throw new Error('個人の期間が1つも無い（先に池を足す）');
  return toPoolPeriod(rows.rows[0] as PoolRow);
}

/** 池の空きを目標まで足す。やめた日が入った後は足せない（DB の決まり）ので、足りなければ投げる。全体の lock の中で呼ぶ */
async function topUpPool(db: PgClient): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if ((await freePoolPeriods(db)).length >= POOL_FREE_TARGET) return;
    // やめた日が入った後は個人の期間を足せない（DB の決まり）。足さずに今ある空きを使う（無ければ claimPeriod が投げる）
    if (await soleBusinessEnded(db)) return;
    await seedAccountingPeriod(db, { businessType: 'soleProprietor' });
  }
  throw new Error('池を目標まで足せない');
}

async function withGlobalLock<T>(db: PgClient, body: () => Promise<T>): Promise<T> {
  await db.query(`select pg_catalog.pg_advisory_lock(${GLOBAL_LOCK})`);
  try {
    return await body();
  } finally {
    await db.query(`select pg_catalog.pg_advisory_unlock(${GLOBAL_LOCK})`);
  }
}

export class AccountingScenario {
  readonly ip = ip198();
  readonly admin: AdminSessionActor;
  private readonly actors: AdminSessionActor[];
  private readonly clients = new Map<string, APIRequestContext>();
  private readonly csrf = new Map<string, string>();
  private readonly expenseIds: number[] = [];
  private readonly claimed: PoolPeriod[] = [];
  private exclusiveHeld = 0;
  private corporateHeld = false;
  private cleaned = false;

  constructor(readonly db: PgClient, admin: AdminSessionActor) {
    this.admin = admin;
    this.actors = [admin];
  }

  /** 取った池の期間（最初の1つ）。period: 'none' の試験は読めない */
  get period(): PoolPeriod {
    if (this.claimed.length === 0) throw new Error('この試験は池の期間を取っていない');
    return this.claimed[0];
  }
  get periodId(): string {
    return this.period.id;
  }

  /** 期間の中の日付（月・日は 1〜28 で足す） */
  day(month: number, day: number, period: PoolPeriod = this.period): string {
    return `${period.year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  async actor(role: AdminSessionRole, aal: AdminSessionAal): Promise<AdminSessionActor> {
    const actor = await createAdminSessionActor(this.db, role, aal);
    this.actors.push(actor);
    return actor;
  }

  // ---- lock と池 ----
  async lockGlobal(): Promise<void> {
    await this.db.query(`select pg_catalog.pg_advisory_lock(${GLOBAL_LOCK})`);
    this.exclusiveHeld += 1;
  }
  async lockCorporateChain(): Promise<void> {
    await this.db.query(`select pg_catalog.pg_advisory_lock(${CORPORATE_LOCK})`);
    this.corporateHeld = true;
  }
  /** 全体の lock の中で、池の空きを目標まで足す（やめた日の前に呼ぶ） */
  async ensurePool(): Promise<void> {
    await withGlobalLock(this.db, () => topUpPool(this.db));
  }
  /** 池の空きの期間を1つ、この試験の接続に結んで取る */
  async claimPeriod(): Promise<PoolPeriod> {
    const period = await withGlobalLock(this.db, async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        for (const candidate of await freePoolPeriods(this.db)) {
          if (this.claimed.some((own) => own.id === candidate.id)) continue; // 同じ接続の lock は重ねて取れてしまう
          const locked = await this.db.query('select pg_catalog.pg_try_advisory_lock($1::int, pg_catalog.hashtext($2)) as ok', [CLAIM_CLASS, candidate.id]);
          if (locked.rows[0].ok === true) return candidate;
        }
        await topUpPool(this.db);
      }
      throw new Error('池に空きの期間が無い。db reset してから流す');
    });
    this.claimed.push(period);
    return period;
  }
  /** 試験の中で、やめた日の期間（個人の最後の期間）を読み直す */
  tail(): Promise<PoolPeriod> {
    return soleTail(this.db);
  }

  // ---- 今日の期間（計画2。E2E は今日の日付だけを使う） ----
  /** 日本時間の今日 */
  get today(): string {
    return japanToday();
  }
  /** 日本時間の明日（出荷日を直す例の「元の日」。G は今日より後を断るので、元の発送票だけを DB へ直に入れる） */
  get tomorrow(): string {
    return addDaysIso(japanToday(), 1);
  }

  /**
   * 日付を含む個人の期間を返す。無ければ、その事業の形の最後の期間の次に続く期間（seedAccountingPeriod）を、含むまで足す。
   * 池の期間（2030 年以降の空き）は使わない（計画2 の裁定 P2-M11）。足すのは全体の lock の中。
   * 期間は消せないので、db reset してから流す。やめた日が入った後は足せないため、含む期間が無ければ投げる。
   */
  async ensurePeriodFor(date: string): Promise<PoolPeriod> {
    return withGlobalLock(this.db, async () => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const found = await this.db.query(
          `select ${PERIOD_COLUMNS} from public.accounting_periods p
            where p.business_type = 'soleProprietor' and p.starts_on <= $1::date and p.ends_on >= $1::date`,
          [date],
        );
        if (found.rows.length === 1) return toPoolPeriod(found.rows[0] as PoolRow);
        if (await soleBusinessEnded(this.db)) throw new Error(`${date} を含む個人の期間が無く、やめた日が入っているので足せない`);
        await seedAccountingPeriod(this.db, { businessType: 'soleProprietor' });
      }
      throw new Error(`${date} を含む個人の期間を足せない`);
    });
  }

  /** 今日を含む個人の期間（無ければ足す）。明日が年をまたぐ日なら、明日の期間も足す */
  async todayPeriod(): Promise<PoolPeriod> {
    const period = await this.ensurePeriodFor(this.today);
    await this.ensurePeriodFor(this.tomorrow);
    return period;
  }

  // ---- 注文・Stripe・発送票・取り消しの材料（手元の DB へ直に入れる。Stripe は呼ばない。表示の証拠であって実 Stripe の証拠ではない） ----
  /**
   * 支払い済みの注文（着ごとの支払額つき。割引の割り当ては無い）を入れる。商品は非公開（公開のままだと、同時に流れる購入の spec の seedCart が
   * 「新しい順の最初の商品」にこの商品を拾ってしまう）。paymentIntentId を省くと新しい番号。呼び出しは G の共通の鍵を取る材料の取引の中。
   */
  async seedPaidOrder(input: {
    lines: ReadonlyArray<{ price: number; quantity: number; unitAmounts?: readonly number[] }>;
    paymentIntentId?: string;
    paidAt?: string;
  }): Promise<{ orderId: string; orderItemIds: string[]; paymentIntentId: string; total: number; orderNumber: string }> {
    const paymentIntentId = input.paymentIntentId ?? `pi_${randomUUID().replaceAll('-', '')}`;
    const total = input.lines.reduce((sum, line) => sum + line.price * line.quantity, 0);
    const seeded = await withGroupG1Material(this.db, async () => {
      const lines = [];
      for (const line of input.lines) {
        const catalog = await createCatalogFixture(this.db, { stock: 0, itemStatus: 'private' });
        lines.push({
          itemPrice: line.price,
          quantity: line.quantity,
          discounts: [],
          unitAmounts: line.unitAmounts ?? Array.from({ length: line.quantity }, () => line.price),
          catalog,
        });
      }
      const order = await seedHOrderUnits(this.db, { legacy: false, status: 'paid', paidAt: input.paidAt ?? new Date().toISOString(), lines });
      await this.db.query('update public.orders set payment_intent_id = $2 where id = $1', [order.orderId, paymentIntentId]);
      return order;
    });
    return { ...seeded, paymentIntentId, total, orderNumber: `ORD-${seeded.orderId.slice(0, 8).toUpperCase()}` };
  }

  /** Stripe の残高の取引（支払い）を入れる。日時の初期値は今 */
  seedStripeCharge(input: {
    paymentIntentId: string | null; amount: number; orderId?: string | null; fee?: number; createdAt?: string; id?: string; syncedAt?: string;
  }): Promise<string> {
    return seedStripeChargeFixture(this.db, { ...input, createdAt: input.createdAt ?? new Date().toISOString() });
  }

  /** Stripe の残高の取引（手数料・入金・補充・返金の元本など）を入れる。日時の初期値は今 */
  seedStripeFee(input: {
    type: string; reportingCategory: string; amount: number; fee?: number; createdAt?: string; id?: string; sourceId?: string;
    feeDetails?: ReadonlyArray<Record<string, unknown>>; rawPayload?: Record<string, unknown>; paymentIntentId?: string | null; payoutId?: string | null;
  }): Promise<string> {
    return seedStripeFeeFixture(this.db, { ...input, createdAt: input.createdAt ?? new Date().toISOString() });
  }

  /** 確定した発送票を G の表へ直に入れる（G の関数は今日より後の出荷日を断る）。出荷日の初期値は今日 */
  seedConfirmedSlip(input: {
    orders: ReadonlyArray<SeedSlipOrder>; shipmentDate?: string; confirmedAt?: string; recordFact?: boolean;
  }) {
    return seedConfirmedSlipFixture(this.db, input);
  }

  /** 発送票を、確定した時刻と事実の時刻を決めて入れる（支払いの取り消しが引かれた時刻と前後を決める例） */
  confirmSlipAt(order: { orderId: string; orderItemIds: string[] }, input: { quantity: number; shipmentDate: string; lockedAt: string; orderItemId?: string }) {
    return confirmSlipAtFixture(this.db, order, input);
  }

  /** G の関数で出荷日を直す（本物の関数。日は支払いの日以後・今日以前）。できた履歴の行の番号を返す */
  correctShipmentDate(slipId: string, date: string, reason: string): Promise<string> {
    return correctShipmentDateFixture(this.db, slipId, date, { reason, actorId: this.admin.userId });
  }

  /** カード会社からの支払いの取り消しと、引かれた残高の取引を入れる。日時の初期値は今 */
  seedDispute(input: {
    orderId?: string | null; paymentIntentId?: string | null; amount: number; withdrawnAt?: string | null; reason?: string;
    status?: string; fee?: number; createdAt?: string; disputeId?: string;
  }) {
    const now = new Date().toISOString();
    return seedDisputeFixture(this.db, { ...input, withdrawnAt: input.withdrawnAt === undefined ? now : input.withdrawnAt, createdAt: input.createdAt ?? now });
  }

  /** 取り消しの状態の履歴を足す（lost は Stripe 側の時刻 stripeEventCreatedAt が要る） */
  addDisputeHistory(input: { disputeId: string; status: string; occurredAt: string; stripeEventCreatedAt?: string | null; eventType?: string }) {
    return addDisputeHistory(this.db, input);
  }

  seedDisputeReversal(input: { disputeId: string; amount: number; createdAt: string }) {
    return seedDisputeReversalFixture(this.db, input);
  }

  /**
   * 計上係を流す（DB の入口 private.accounting_run_posting。画面の「もう一度計上する」と同じ係）。has_more が偽になるまで繰り返す（最大20回）。
   * 全体の係なので、ほかの試験が入れた出来事も計上される。件数は各回の合計。
   */
  async runPosting(limit = 50): Promise<{ payments: number; shipments: number; stripe: number; disputes: number; parked: number; resolved: number; loops: number }> {
    const total = { payments: 0, shipments: 0, stripe: 0, disputes: 0, parked: 0, resolved: 0, loops: 0 };
    for (let loop = 0; loop < 20; loop += 1) {
      const row = (await this.db.query('select private.accounting_run_posting($1::integer) as r', [limit])).rows[0].r as Record<string, number | boolean>;
      total.payments += Number(row.payments);
      total.shipments += Number(row.shipments);
      total.stripe += Number(row.stripe);
      total.disputes += Number(row.disputes);
      total.parked += Number(row.parked);
      total.resolved += Number(row.resolved);
      total.loops += 1;
      if (row.has_more !== true) break;
    }
    return total;
  }

  /** 印（dedupe_key）で仕訳を探す。無ければ null */
  async entryByKey(dedupeKey: string): Promise<{ id: string; entryNo: number; entryDate: string; eventKind: string; description: string; reversesEntryId: string | null; reason: string | null; periodId: string } | null> {
    const row = (await this.db.query(
      `select id, entry_no, to_char(entry_date, 'YYYY-MM-DD') as entry_date, event_kind, description, reverses_entry_id, reason, period_id
         from public.accounting_journal_entries where dedupe_key = $1`,
      [dedupeKey],
    )).rows[0];
    return row
      ? { id: row.id, entryNo: Number(row.entry_no), entryDate: row.entry_date, eventKind: row.event_kind, description: row.description, reversesEntryId: row.reverses_entry_id, reason: row.reason, periodId: row.period_id }
      : null;
  }

  /** 取り消した仕訳（元の仕訳を打ち消す仕訳）を探す。無ければ null */
  async reversalOf(entryId: string): Promise<{ id: string; entryNo: number; entryDate: string; reason: string | null } | null> {
    const row = (await this.db.query(
      `select id, entry_no, to_char(entry_date, 'YYYY-MM-DD') as entry_date, reason from public.accounting_journal_entries where reverses_entry_id = $1::uuid`,
      [entryId],
    )).rows[0];
    return row ? { id: row.id, entryNo: Number(row.entry_no), entryDate: row.entry_date, reason: row.reason } : null;
  }

  /** 仕訳の行（行の順）。借方・貸方は円 */
  async linesOf(entryId: string): Promise<Array<{ account: string; debit: number; credit: number; orderId: string | null; subAccount: string | null }>> {
    const rows = (await this.db.query(
      `select account_code, debit::bigint as debit, credit::bigint as credit, order_id, sub_account from public.accounting_journal_lines where entry_id = $1::uuid order by line_no`,
      [entryId],
    )).rows;
    return rows.map((row) => ({ account: row.account_code, debit: Number(row.debit), credit: Number(row.credit), orderId: row.order_id, subAccount: row.sub_account }));
  }

  /** 注文の前受金（2150）の残り（貸方−借方）。全部の仕訳（取り消しを含む）の合計 */
  async deferredBalance(orderId: string): Promise<number> {
    const row = (await this.db.query(
      "select coalesce(sum(credit - debit), 0)::bigint as b from public.accounting_journal_lines where order_id = $1::uuid and account_code = '2150'",
      [orderId],
    )).rows[0];
    return Number(row.b);
  }

  /** 計上待ち（この出来事の種類と元の記録の番号）の行。無ければ null */
  async pendingOf(eventKind: string, sourceId: string): Promise<{ reason: string; detail: Record<string, unknown>; resolvedAt: Date | null } | null> {
    const row = (await this.db.query(
      'select reason, detail, resolved_at from public.accounting_pending_events where event_kind = $1 and source_id = $2 order by first_detected_at desc limit 1',
      [eventKind, sourceId],
    )).rows[0];
    return row ? { reason: row.reason, detail: row.detail, resolvedAt: row.resolved_at } : null;
  }

  /** 本物の journal route を、日付の範囲で最後まで読む（続きの目印をたどる。最大20ページ）。期間の全体は読まない */
  async journalBetween(periodId: string, from: string, to: string, who: AdminSessionActor = this.admin) {
    type Entry = {
      id: string; entryNo: number; entryDate: string; eventKind: string; dedupeKey: string; description: string; reason: string | null;
      reversesEntryId: string | null; sourceTable: string | null; sourceId: string | null;
      lines: Array<{ accountCode: string; debit: number; credit: number; orderId: string | null; subAccount: string | null }>;
    };
    const entries: Entry[] = [];
    let cursor = '';
    let shipmentMeta: Array<{ entryId: string; slipNumber: string; shipmentDate: string; confirmedAt: string }> = [];
    for (let page = 0; page < 20; page += 1) {
      const reply = await this.api(who, `/api/admin/accounting/journal?periodId=${periodId}&from=${from}&to=${to}&limit=200${cursor}`);
      if (reply.status !== 200) throw new Error(`仕訳帳を読めない（${reply.status}）`);
      entries.push(...(reply.body.data.entries as Entry[]));
      shipmentMeta = shipmentMeta.concat(reply.body.data.shipmentMeta ?? []);
      const next = reply.body.data.nextAfter as { entryDate: string; entryNo: number } | null;
      if (!next) break;
      cursor = `&afterEntryDate=${next.entryDate}&afterEntryNo=${next.entryNo}`;
    }
    return { entries, shipmentMeta };
  }

  // ---- HTTP（本物の route。Authorization: Bearer なので CSRF は要らない） ----
  private async client(who: AdminSessionActor): Promise<APIRequestContext> {
    let client = this.clients.get(who.userId + who.accessToken);
    if (!client) {
      client = await playwrightRequest.newContext({
        baseURL: ORIGIN,
        extraHTTPHeaders: { origin: ORIGIN, 'x-real-ip': this.ip, authorization: `Bearer ${who.accessToken}` },
        timeout: 60_000,
      });
      this.clients.set(who.userId + who.accessToken, client);
    }
    return client;
  }

  private async read(response: Awaited<ReturnType<APIRequestContext['fetch']>>): Promise<ApiReply> {
    try {
      const text = await response.text(); // ok でない応答も本文を最後まで読む
      let body: any = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      return { status: response.status(), body, text };
    } finally {
      await response.dispose();
    }
  }

  async api(who: AdminSessionActor, path: string, method = 'GET', data?: unknown): Promise<ApiReply> {
    if (!path.startsWith('/api/') || path.startsWith('//')) throw new Error('会計の E2E は /api/ の中だけを叩く');
    const client = await this.client(who);
    return this.read(await client.fetch(path, { method, ...(data === undefined ? {} : { data }) }));
  }

  /** POST /api/admin/kpi/cost-profit/receipt（multipart）。本物の route と本物の Storage */
  async postReceipt(
    who: AdminSessionActor,
    entryId: number,
    kind: { evidenceKind?: 'electronic' | 'paper'; paperOriginalKept?: boolean },
  ): Promise<ApiReply> {
    const client = await this.client(who);
    const multipart: Record<string, string | { name: string; mimeType: string; buffer: Buffer }> = {
      file: { name: `e2e-${randomUUID().slice(0, 8)}.pdf`, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% e2e receipt\n%%EOF\n') },
      entryId: String(entryId),
    };
    if (kind.evidenceKind) multipart.evidenceKind = kind.evidenceKind;
    if (kind.paperOriginalKept !== undefined) multipart.paperOriginalKept = String(kind.paperOriginalKept);
    return this.read(await client.fetch('/api/admin/kpi/cost-profit/receipt', { method: 'POST', multipart }));
  }

  // ---- 取引 ----
  private expenseBody(input: ExpenseInput) {
    return {
      entryType: input.entryType ?? 'expense',
      date: input.date,
      category: input.category ?? ACCOUNTING_EXPENSE_CATEGORY,
      item: input.item ?? `E2E ${randomUUID().slice(0, 8)}`,
      partner: input.partner ?? '',
      amount: input.amount,
      paymentMethod: input.paymentMethod ?? ACCOUNTING_EXPENSE_METHOD,
      memo: input.memo ?? '',
      seasonTag: null,
    };
  }

  /** 本物の POST /api/admin/kpi/cost-profit（expense.create）で取引を作る。S4 のトリガーが仕訳にする。取引の番号を返す */
  async createExpense(input: ExpenseInput, who: AdminSessionActor = this.admin): Promise<number> {
    const reply = await this.api(who, '/api/admin/kpi/cost-profit', 'POST', {
      operation: 'expense.create',
      fiscalYear: Number(input.date.slice(0, 4)),
      expense: this.expenseBody(input),
    });
    if (reply.status !== 200 || !reply.body?.resourceId) throw new Error(`取引を作れない（${reply.status}）`);
    const id = Number(reply.body.resourceId);
    this.expenseIds.push(id);
    return id;
  }

  /** 本物の expense.update。元の仕訳の取り消しと正しい仕訳が足される */
  async updateExpense(id: number, input: ExpenseInput, who: AdminSessionActor = this.admin): Promise<ApiReply> {
    return this.api(who, '/api/admin/kpi/cost-profit', 'POST', {
      operation: 'expense.update',
      fiscalYear: Number(input.date.slice(0, 4)),
      expenseId: id,
      expense: this.expenseBody(input),
    });
  }

  /** 手元の DB へ直に取引を並べて入れる（route を通らない。トリガーは同じ。201 件の例用）。取引の番号を返す */
  async createExpensesInDb(rows: ReadonlyArray<{ date: string; amount: number; item?: string }>): Promise<number[]> {
    const years = [...new Set(rows.map((row) => Number(row.date.slice(0, 4))))];
    for (const year of years) {
      await this.db.query('insert into public.admin_finance_years (fiscal_year) values ($1) on conflict (fiscal_year) do nothing', [year]);
    }
    const tag = randomUUID().slice(0, 8);
    const inserted = await this.db.query(
      `insert into public.admin_finance_expenses (expense_date, category, item_name, amount, payment_method, entry_type, partner, created_by)
       select t.d, $4, t.i, t.a, $5, 'expense', '', $3::uuid
         from unnest($1::date[], $2::bigint[], $6::text[]) with ordinality as t(d, a, i, n)
        order by t.n
       returning id`,
      [
        rows.map((row) => row.date),
        rows.map((row) => row.amount),
        this.admin.userId,
        ACCOUNTING_EXPENSE_CATEGORY,
        ACCOUNTING_EXPENSE_METHOD,
        rows.map((row, index) => row.item ?? `E2E bulk ${tag} ${index + 1}`),
      ],
    );
    const ids = inserted.rows.map((row) => Number(row.id));
    this.expenseIds.push(...ids);
    return ids;
  }

  // ---- 設定 ----
  async settings(who: AdminSessionActor = this.admin) {
    const reply = await this.api(who, '/api/admin/accounting/settings');
    if (reply.status !== 200) throw new Error(`設定を読めない（${reply.status}）`);
    return reply.body.data.settings as {
      businessStartDate: string | null;
      currentBusinessType: 'soleProprietor' | 'corporation';
      soleBusinessEndedOn: string | null;
      version: string;
      soleEndChanges: Array<{ previousEndedOn: string | null; newEndedOn: string; reason: string; changedAt: string }>;
    };
  }

  /** 開業日が空なら入れる（一度入れたら選び直せない。入っていればそのまま）。入っている開業日を返す */
  async ensureBusinessStart(date: string): Promise<string> {
    return withGlobalLock(this.db, async () => {
      const current = await this.settings();
      if (current.businessStartDate) return current.businessStartDate;
      const reply = await this.api(this.admin, '/api/admin/accounting/settings', 'PUT', {
        businessStartDate: date,
        currentBusinessType: current.currentBusinessType,
        expectedVersion: current.version,
        requestKey: randomUUID(),
      });
      if (reply.status !== 200) throw new Error(`開業日を入れられない（${reply.status}）`);
      return date;
    });
  }

  /** 個人の最後の期間のやめた日を API で入れる／選び直す。呼ぶ側が全体の lock を持つ */
  async setSoleEnd(tail: PoolPeriod, endedOn: string, reason: string | null): Promise<ApiReply> {
    const settings = await this.settings();
    const period = await soleTail(this.db);
    return this.api(this.admin, `/api/admin/accounting/periods/${tail.id}/final-sole`, 'POST', {
      endedOn,
      expectedPeriodVersion: period.version,
      expectedSettingsVersion: settings.version,
      reason,
      requestKey: randomUUID(),
    });
  }

  // ---- 画面 ----
  /** 本物の session を画面の Cookie に載せる（アプリのログインを通った形。CSRF の値も DB の控えと合わせる） */
  async attach(page: Page, who: AdminSessionActor = this.admin): Promise<void> {
    let csrf = this.csrf.get(who.userId);
    if (!csrf) {
      csrf = randomBytes(32).toString('hex');
      this.csrf.set(who.userId, csrf);
      await this.db.query('update public.sessions set csrf_token_hash = $1 where auth_session_id = $2', [sha256(csrf), who.sessionId]);
    }
    const cookie = (name: string, value: string, httpOnly: boolean) => ({
      name, value, domain: 'localhost', path: '/', httpOnly, secure: false, sameSite: 'Lax' as const, expires: -1,
    });
    await page.context().clearCookies();
    await page.context().addCookies([
      cookie('sb-access-token', who.accessToken, true),
      cookie('sb-refresh-token', who.refreshToken, true),
      cookie('sb-csrf-token', csrf, false),
    ]);
    await page.context().setExtraHTTPHeaders({ 'x-real-ip': this.ip });
  }

  /** 画面の会計（ACCOUNTING）を、本物の route で開く。裏の読み込み（Meta・法定保存・要対応）だけは空の応答にする */
  async openAccounting(
    page: Page,
    tab: '財務概要' | '取引管理' | '帳簿' | '設定・期間' | '計上待ち' | '照合' = '取引管理',
  ): Promise<void> {
    await this.attach(page);
    await mockAdminBackgroundApis(page);
    // 本物の session を使うので、裏の更新の差し替えは使わない（呼ばれたら本物へ通す）
    await page.route('**/api/auth/refresh', (route) => route.continue());
    await page.goto('/admin');
    await page.getByRole('button', { name: 'ACCOUNTING' }).click();
    await page.getByRole('tab', { name: tab, exact: true }).click();
  }

  // ---- 後片付け ----
  /** 自分が作った取引の論理削除と、試験用の session だけ。期間・仕訳・証憑・試験用の利用者は消さない */
  async cleanup(): Promise<void> {
    if (this.cleaned) return;
    this.cleaned = true;
    const failures: unknown[] = [];
    const attempt = async (step: () => Promise<unknown>) => {
      try {
        await step();
      } catch (error) {
        failures.push(error);
      }
    };
    for (const client of this.clients.values()) await attempt(() => client.dispose());
    if (this.expenseIds.length > 0) {
      await attempt(() =>
        this.db.query(
          `update public.admin_finance_expenses set deleted_at = now(), deleted_by = $1::uuid, updated_by = $1::uuid
            where id = any($2::bigint[]) and deleted_at is null`,
          [this.admin.userId, this.expenseIds],
        ));
    }
    await attempt(() => this.db.query('delete from public.sessions where user_id = any($1::uuid[])', [this.actors.map((actor) => actor.userId)]));
    for (const period of this.claimed) {
      await attempt(() => this.db.query('select pg_catalog.pg_advisory_unlock($1::int, pg_catalog.hashtext($2))', [CLAIM_CLASS, period.id]));
    }
    for (; this.exclusiveHeld > 0; this.exclusiveHeld -= 1) {
      await attempt(() => this.db.query(`select pg_catalog.pg_advisory_unlock(${GLOBAL_LOCK})`));
    }
    if (this.corporateHeld) await attempt(() => this.db.query(`select pg_catalog.pg_advisory_unlock(${CORPORATE_LOCK})`));
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, '会計の E2E の後片付けが複数失敗した');
  }
}

async function runScenario<T>(db: PgClient, run: (s: AccountingScenario) => Promise<T>, options: ScenarioOptions): Promise<T> {
  const failures: unknown[] = [];
  let scenario: AccountingScenario | undefined;
  let result: T | undefined;
  try {
    const admin = await createAdminSessionActor(db, 'admin', 'aal2');
    scenario = new AccountingScenario(db, admin);
    if (options.exclusive) await scenario.lockGlobal();
    if (options.corporateChain) await scenario.lockCorporateChain();
    if ((options.period ?? 'pool') === 'pool') await scenario.claimPeriod();
    result = await run(scenario);
  } catch (error) {
    failures.push(error);
  }
  // 後片付けの失敗で本体の失敗を隠さない。両方残す
  try {
    if (scenario) await scenario.cleanup();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, '会計の E2E の本体と後片付けが失敗した');
  return result as T;
}

/** 会計の場面。name は失敗の見分け用（必須）。手元の DB の接続1本で、試験用の店長（aal2）と池の期間を用意する */
export async function withAccountingScenario<T>(
  name: string,
  run: (scenario: AccountingScenario) => Promise<T>,
  options: ScenarioOptions = {},
): Promise<T> {
  if (!name) throw new Error('会計の場面の名前が要る');
  return withLocalDb((db) => runScenario(db, run, options));
}

/** 権限の表を動かす場面。withPermissionScenario の lock と復元の中で流す（権限の変更は終わりに元へ戻る） */
export async function withAccountingPermissionScenario<T>(
  run: (scenario: AccountingScenario) => Promise<T>,
  options: ScenarioOptions = {},
): Promise<T> {
  let result: T | undefined;
  await withPermissionScenario(async (db) => {
    result = await runScenario(db, run, options);
  });
  return result as T;
}

// ---- 画面の道具 ----

/** 画面右上の会計期間の選択で、名前の期間を選ぶ */
export async function selectAccountingPeriod(page: Page, name: string): Promise<void> {
  await page.getByRole('combobox', { name: '会計期間' }).click();
  await page.getByRole('option', { name, exact: true }).click();
  await expect(page.getByRole('combobox', { name: '会計期間' })).toContainText(name);
}

/** 帳簿 → 決算・試算表 → 合計残高試算表 を開く */
export async function openTrialBalance(page: Page): Promise<void> {
  await page.getByRole('tab', { name: '帳簿', exact: true }).click();
  await page.getByRole('tab', { name: '決算・試算表', exact: true }).click();
  await page.getByRole('tab', { name: '合計残高試算表', exact: true }).click();
}

/** 試算表の合計の行の「借方合計」「貸方合計」（円の数）。合計の行は最後の行 */
export async function trialBalanceTotals(page: Page): Promise<{ debit: number; credit: number }> {
  const row = page.getByRole('row').filter({ hasText: '合計' }).last();
  const cells = await row.getByRole('cell').allInnerTexts();
  // 合計（3列ぶん）・借方合計・貸方合計・借方残高・貸方残高
  const yen = (text: string) => Number(text.replace(/[^\d-]/g, ''));
  if (cells.length < 3) throw new Error('試算表の合計の行を読めない');
  return { debit: yen(cells[1]), credit: yen(cells[2]) };
}

/** 仕訳・元帳で、科目（符号つきの名前）を検索して選ぶ */
export async function selectLedgerAccount(page: Page, account: { code: string; name: string }): Promise<void> {
  await page.getByRole('searchbox', { name: '勘定科目を検索' }).fill(account.name);
  await page.getByRole('button', { name: '勘定科目を検索する' }).click();
  await page
    .getByRole('region', { name: '勘定科目' })
    .getByRole('button', { name: new RegExp(`${account.code}\\s*${account.name}`) })
    .click();
}

/** 仕訳一覧を伝票番号（JE-000123）で絞り、その行の欄（日付・伝票No.・相手勘定科目・取引先・摘要・借方・貸方・残高・証憑・出荷した日・登録した日・出荷の跡）の文を返す */
export async function ledgerRowCells(page: Page, entryNo: number): Promise<string[]> {
  const number = `JE-${String(entryNo).padStart(6, '0')}`;
  await page.getByRole('searchbox', { name: '仕訳を検索' }).fill(number);
  await page.getByRole('button', { name: '仕訳を検索する' }).click();
  const row = page.getByRole('region', { name: '仕訳一覧' }).locator('tbody tr').filter({ hasText: number });
  await expect(row).toHaveCount(1, { timeout: 30_000 });
  return (await row.getByRole('cell').allInnerTexts()).map((text) => text.trim());
}
