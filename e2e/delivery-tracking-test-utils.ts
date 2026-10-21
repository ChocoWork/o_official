/**
 * 配送の状況（グループ E-4 の Task 13）の E2E の道具。
 *
 * - 追跡の HTTP は、手元の作り物の 17TRACK（scripts/e2e/fake-17track.mjs。127.0.0.1:4017）。本物の 17TRACK へはつながない。
 * - 起動したアプリの毎分の定期処理（POST /api/cron/process-stripe-webhooks）を CRON_SECRET で呼び、本物の 17TRACK の部品
 *   （登録・読み直し・知らせの合図・メール）を進める。状態やメールを待つ時は expect.poll で毎分の処理と読み取りを繰り返す。
 * - 注文・発送・配送の操作は、手元の DB の本物の関数を呼ぶ。管理画面の窓口（RBAC・CSRF を通る本物のログインには2段階認証が要る）
 *   だけは、今までの E2E と同じく差し替える（実装計画 P22）。差し替えた窓口は、DB の本物の読み出しを画面の形へ写すだけで、
 *   管理者の権限・CSRF の確かめの証拠にはならない（それは Task 9 の単体の試験）。
 * - 設定の「鍵なし」の表示は、窓口の答えの見本であり、本物の環境変更の証拠ではない（ADMIN-104・ACCOUNT-043）。
 * - 新しい8本は設定（追跡のオン・オフ）と登録の表を共有するので、withDeliveryScenario が DB の pg_advisory_lock(940488) で
 *   ファイルをまたいで1本ずつに直列にする。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { Client } from 'pg';
import { expect, type APIRequestContext, type Locator, type Page, type Route } from '@playwright/test';
import type { OrderItem } from '@/components/OrderSection';
import {
  buildOrderHistory,
  type OrderEmailHistoryRow,
  type OrderHistoryLine,
  type OrderStatusHistoryRow,
} from '@/lib/orders/email/order-history';
import type { OrderFulfillmentHistoryRow } from '@/lib/orders/fulfillment/fulfillment-store';
import type { OrderStatus } from '@/lib/orders/order-payment-types';
import { ORDER_PROGRESS_LABELS, deriveOrderProgress, type OrderLineProgressCounts } from '@/lib/orders/order-progress';
import type { ShippingCarrierId } from '@/lib/orders/shipping-carriers';
import { DELIVERY_ERROR_MESSAGES } from '@/lib/orders/tracking/delivery-messages';
import type {
  DeliveryAttentionItem,
  DeliveryErrorCode,
  FulfillmentDeliveryDetail,
  OrderDeliveryDetail,
} from '@/lib/orders/tracking/delivery-types';
import {
  E2E_FAKE_17TRACK_CONTRACT,
  E2E_FAKE_17TRACK_KEY,
  E2E_FAKE_17TRACK_URL,
  computeFake17TrackBuild,
  isLocalUrl,
} from '../scripts/e2e/environment';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import {
  createFulfillment,
  createOrderWithLines,
  mailBodies,
  uniqueEmail,
  type E2eCreatedOrder,
  type MailBody,
} from './order-email-test-utils';
import { createTestMember, loginAsMember, type TestMember } from './member-session-helpers';
import { adminOrder, fulfillJson, mockAdminSession, orderNumberOf } from './order-fulfillment-test-utils';

// ---- 画面の幅 ----

export const deliveryViewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
] as const;

// ---- 作り物の 17TRACK ----

export type TrackingCarrierId = 100062 | 100040 | 10021;
export type TrackingPair = { carrier: TrackingCarrierId; number: string };

/** 運送会社の番号（src/lib/orders/tracking/seventeen-track-status.ts と同じ値。試験が自分で持つ） */
export const TRACKING_CARRIER_IDS: Record<ShippingCarrierId, TrackingCarrierId> = {
  yamato: 100062,
  sagawa: 100040,
  japanpost: 10021,
};

const APP_ORIGIN = 'http://localhost:3000';
const FAKE_ORIGIN = new URL(E2E_FAKE_17TRACK_URL).origin;
const LOCAL_DB_URL = process.env.E2E_LOCAL_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const SCENARIO_LOCK = 940488;

/** 作り物へつなぐ前の確かめ。環境が作り物の URL と鍵になっていなければ、何も送らずに止める（二重の見張り） */
function assertFakeEnv(): void {
  if (process.env.TRACKING_17TRACK_BASE_URL !== E2E_FAKE_17TRACK_URL || process.env.TRACKING_17TRACK_API_KEY !== E2E_FAKE_17TRACK_KEY) {
    throw new Error('17TRACK の接続先が作り物の URL と鍵になっていない。E2E は playwright.config.ts の見張りを通して流す');
  }
}

async function assertFakeHealthy(): Promise<void> {
  let body: unknown = null;
  try {
    const response = await fetch(`${FAKE_ORIGIN}/__health`, { signal: AbortSignal.timeout(3_000) });
    body = response.ok ? await response.json() : null;
  } catch {
    body = null;
  }
  if (typeof body !== 'object' || body === null || (body as { fake?: unknown }).fake !== E2E_FAKE_17TRACK_CONTRACT) {
    throw new Error('17TRACK の作り物が4017番で動いていない（scripts/e2e-server.mjs が起こす。別のプロセスが4017番にいないか確かめる）');
  }
  // 作り物のコードや見本が今のファイルと違う古い作り物では、試験の合否があてにならない。使い回さずに止める
  if ((body as { build?: unknown }).build !== computeFake17TrackBuild()) {
    throw new Error('4017番の 17TRACK の作り物のコードが、今のファイルと違う（古い作り物）。作り物を止めて、scripts/e2e-server.mjs に起こし直させる');
  }
}

async function fakeControl(method: string, pathAndQuery: string, body?: unknown): Promise<Response> {
  assertFakeEnv();
  return fetch(`${FAKE_ORIGIN}${pathAndQuery}`, {
    method,
    headers: { 'x-e2e-control': E2E_FAKE_17TRACK_KEY, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
}

type ScenarioState = {
  numberPrefix: string;
  touched: Map<string, TrackingPair>;
  /** 管理画面の橋渡しが開いた専用の接続・窓口の差し替えを閉じる処理（場面の片づけの最初に呼ぶ） */
  bridgeClosers: Array<() => Promise<void>>;
};
let activeScenario: ScenarioState | null = null;

const pairKey = (pair: TrackingPair) => `${pair.carrier}:${pair.number.toUpperCase()}`;

/**
 * 作り物の、自分の組の状態を変える。responseKey は共通の見本 tests/fixtures/17track/v2.4.json の responses の名前
 * （inTransit・outForDelivery・delivered・unknownStatus・noInformation・invalidNumber・accountQuota など）。
 * 見本に無い failure（問題あり）と attemptedDelivery（不在で持ち帰り）は、作り物が inTransit の複製から作る。
 * 時刻は、渡さなければ作り物が読まれた時刻にする（読んだ時刻より後にならない。発送を作る前に決めても、出来事の時刻が発送の時刻より前にならない）。
 */
export async function setFakeTracking(input: {
  carrier: TrackingCarrierId;
  number: string;
  responseKey: string;
  happenedAt?: string;
  deliveredAt?: string;
}): Promise<void> {
  const response = await fakeControl('POST', '/__control/state', input);
  if (!response.ok) throw new Error(`作り物の 17TRACK の状態を変えられない（${response.status}）`);
  activeScenario?.touched.set(pairKey(input), { carrier: input.carrier, number: input.number });
}

/** 作り物が受けた、自分の組への呼び出し（口の道・番号・運送会社の番号だけ。見出し・鍵・名前・住所は記録されない） */
export async function readFakeTrackingCalls(pair: {
  carrier: number;
  number: string;
}): Promise<Array<{ path: string; number: string; carrier: number }>> {
  const response = await fakeControl('GET', `/__control/calls?carrier=${pair.carrier}&number=${encodeURIComponent(pair.number)}`);
  if (!response.ok) throw new Error(`作り物の 17TRACK の呼び出しを読めない（${response.status}）`);
  return (await response.json()) as Array<{ path: string; number: string; carrier: number }>;
}

async function deleteFakeTracking(pair: TrackingPair): Promise<void> {
  await fakeControl('DELETE', `/__control/state?carrier=${pair.carrier}&number=${encodeURIComponent(pair.number)}`);
}

/** 呼び出しの口の名前だけ（'/track/v2.4/register' → 'register'）。順番や数を比べる時に使う */
export function callMethods(calls: Array<{ path: string }>): string[] {
  return calls.map((call) => call.path.replace('/track/v2.4/', ''));
}

// ---- 17TRACK の知らせ（Webhook）と毎分の定期処理 ----

let fixtureCache: { webhooks: { updated: unknown; stopped: unknown } } | null = null;
function sharedFixture(): { webhooks: { updated: unknown; stopped: unknown } } {
  fixtureCache ??= JSON.parse(readFileSync(path.resolve(process.cwd(), 'tests/fixtures/17track/v2.4.json'), 'utf8'));
  return fixtureCache as { webhooks: { updated: unknown; stopped: unknown } };
}

/**
 * 署名つきの知らせを、起動したアプリの受け口（POST /api/webhook/17track）へ送る。本文は共通の見本の形
 * （更新の知らせには偽の Delivered の track_info が入っている。受け口はそれを使わず、読み直しの合図にだけする）。
 * 署名は SHA-256（本文そのまま + "/" + 鍵）の16進。invalidSign を立てると1字だけ違う署名にする。
 */
export async function sendSignedTrackingWebhook(input: {
  carrier: TrackingCarrierId;
  number: string;
  event: 'TRACKING_UPDATED' | 'TRACKING_STOPPED';
  invalidSign?: boolean;
}): Promise<Response> {
  assertFakeEnv();
  const template = structuredClone(
    (input.event === 'TRACKING_UPDATED' ? sharedFixture().webhooks.updated : sharedFixture().webhooks.stopped) as {
      event: string;
      data: { number: string; carrier: number };
    },
  );
  template.data.number = input.number;
  template.data.carrier = input.carrier;
  const raw = JSON.stringify(template);
  const sign = createHash('sha256').update(raw).update('/').update(E2E_FAKE_17TRACK_KEY).digest('hex');
  const headerSign = input.invalidSign ? `${sign.slice(0, 63)}${sign.endsWith('0') ? '1' : '0'}` : sign;
  return fetch(`${APP_ORIGIN}/api/webhook/17track`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', sign: headerSign },
    body: raw,
    signal: AbortSignal.timeout(30_000),
  });
}

/** 毎分の定期処理の入口を1回呼ぶ（Stripe の知らせ → 注文のメール → 配送の追跡 → 点検の順に動く） */
export async function runTrackingMinuteJob(): Promise<void> {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new Error('CRON_SECRET が無い（E2E の固定の値）');
  const response = await fetch(`${APP_ORIGIN}/api/cron/process-stripe-webhooks`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(90_000),
  });
  if (response.status !== 200) throw new Error(`毎分の定期処理が 200 を返さなかった（${response.status}）`);
}

/**
 * 毎分の処理を呼んでから読む、を条件が満たされるまで繰り返す（30秒）。固定の待ちで成功を仮定しない。
 * 登録 → 読み直し → 次の起動でのメールの送り出し、の順で進むので、1回呼んだだけでは足りないことがある。
 * 条件を満たした時の読み取りを返す。
 */
export async function pollWithMinuteJob<T>(read: () => Promise<T>, done: (value: T) => boolean, message: string): Promise<T> {
  let last: T | undefined;
  await expect
    .poll(
      async () => {
        await runTrackingMinuteJob();
        last = await read();
        return done(last);
      },
      { timeout: 30_000, intervals: [300, 600, 1_000, 2_000], message },
    )
    .toBe(true);
  return last as T;
}

/** その件名のメールが、ちょうど expected 通になるまで、毎分の処理を呼んで待つ（多すぎる時は 30 秒後に落ちる） */
export async function pollMails(
  request: APIRequestContext,
  email: string,
  subjectIncludes: string,
  expected: number,
): Promise<MailBody[]> {
  return pollWithMinuteJob(
    () => mailBodies(request, email, subjectIncludes),
    (mails) => mails.length === expected,
    `${subjectIncludes} のメールが ${expected} 通になること`,
  );
}

/** もう毎分の処理を数回呼んでも、その件名のメールが増えない（二重に送らない）ことを確かめる */
export async function expectMailCountStays(
  request: APIRequestContext,
  email: string,
  subjectIncludes: string,
  expected: number,
  runs = 2,
): Promise<void> {
  for (let run = 0; run < runs; run += 1) {
    await runTrackingMinuteJob();
    expect((await mailBodies(request, email, subjectIncludes)).length, `${subjectIncludes} のメール`).toBe(expected);
  }
}

// ---- 場面（設定を共有するので1本ずつ） ----

type SettingsRow = { delivery_tracking_enabled: boolean; delivery_tracking_updated_at: Date | null; delivery_tracking_updated_by: string | null };

async function readSettingsRow(client: PgClient): Promise<SettingsRow> {
  return (
    await client.query(
      'select delivery_tracking_enabled, delivery_tracking_updated_at, delivery_tracking_updated_by from public.shop_settings where id = 1',
    )
  ).rows[0] as SettingsRow;
}

/** 設定の配送の3列を決めた値にする。守りのトリガーが許す形（操作印 toggle・関数の持ち主の接続）で、取引の中だけ印を置く */
async function writeSettingsRow(client: PgClient, row: SettingsRow): Promise<void> {
  await client.query('begin');
  try {
    await client.query("select set_config('app.delivery_tracking_setting', 'toggle', true)");
    await client.query(
      `update public.shop_settings
       set delivery_tracking_enabled = $1, delivery_tracking_updated_at = $2, delivery_tracking_updated_by = $3 where id = 1`,
      [row.delivery_tracking_enabled, row.delivery_tracking_updated_at, row.delivery_tracking_updated_by],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  }
}

/** 場面の最初に、追跡の印だけを決めた値にする（更新者と時刻は触らない。取り込みや停止もしない）。オフの試験の前提を整えるのに使う */
export async function setTrackingFlagDirect(client: PgClient, enabled: boolean): Promise<void> {
  const current = await readSettingsRow(client);
  if (current.delivery_tracking_enabled === enabled) return;
  await writeSettingsRow(client, { ...current, delivery_tracking_enabled: enabled });
}

/**
 * 自分の場面（numberPrefix で始まる伝票番号）以外の登録の読み直しを、1年先へ送る。追跡をオンにすると、前の試験や別の試験が残した
 * 登録（期限内のオフで止めた物の再開・オンにした時の取り込み）が一斉に動き出し、毎分の処理の予算（8秒）を使って、自分の登録の
 * 番が回るのを遅らせる。場面の鍵を持っている間だけ使い、自分の登録には触らない。使い捨ての E2E の DB の中だけの調整。
 */
export async function deferOtherRegistrations(client: PgClient, numberPrefix: string): Promise<void> {
  await client.query(
    `update private.fulfillment_tracking_registrations
     set next_run_at = now() + interval '1 year'
     where tracking_number not like $1 and state in ('pending', 'registered', 'failed')
       and lease_token is null and next_run_at < now() + interval '1 hour'`,
    [`${numberPrefix}%`],
  );
}

/**
 * 追跡のオン・オフを、管理画面の設定の保存と同じ DB の関数（admin_set_delivery_tracking）で切り替える。取り込み・停止・要対応の閉じも本物。
 * 場面の中でオンにした時は、ほかの登録を後回しにする（deferOtherRegistrations）。
 */
export async function setTrackingViaFunction(
  client: PgClient,
  enabled: boolean,
  actorId: string,
): Promise<{ enabled: boolean; updatedAt: Date | null; updatedBy: string | null; backfilledCount: number }> {
  const row = (await client.query('select * from public.admin_set_delivery_tracking($1::boolean, $2::uuid)', [enabled, actorId])).rows[0];
  if (enabled && activeScenario) await deferOtherRegistrations(client, activeScenario.numberPrefix);
  return {
    enabled: row.enabled as boolean,
    updatedAt: (row.updated_at as Date | null) ?? null,
    updatedBy: (row.updated_by as string | null) ?? null,
    backfilledCount: Number(row.backfilled_count),
  };
}

/** 場面で作った登録を、これ以上動かさないようにする（期限切れで止める）。ほかの場面の取り込みや見回りに残さない */
async function neutralizeScenarioRows(client: PgClient, numberPrefix: string): Promise<void> {
  const like = `${numberPrefix}%`;
  await client.query(
    `update private.fulfillment_tracking_registrations
     set state = 'stopped', stop_reason = 'expired', stopped_at = now(), failure_kind = null,
         expires_at = now() - interval '1 minute', lease_token = null, lease_expires_at = null, provider_stop_pending = false
     where tracking_number like $1 and state <> 'stopped'`,
    [like],
  );
  await client.query(
    `update private.fulfillment_tracking_registrations
     set lease_token = null, lease_expires_at = null, provider_stop_pending = false
     where tracking_number like $1 and (lease_token is not null or provider_stop_pending)`,
    [like],
  );
  await client.query(
    `update public.order_fulfillment_attention as a set resolved_at = now(), resolution = 'auto'
     where a.resolved_at is null
       and a.fulfillment_id in (select f.id from public.order_fulfillments as f where f.tracking_number like $1)`,
    [like],
  );
}

/**
 * 追跡の設定と登録の表を共有する試験を、ファイルをまたいで1本ずつにする。専用の pg 接続で pg_advisory_lock(940488) を取り、
 * 終わりに（失敗しても）配送の設定を元に戻し、自分の番号（numberPrefix で始まる）の作り物の状態と登録を片づけて、鍵を返す。
 * 鍵を待つ時間は試験の時間に入るので、使う試験は test.setTimeout を長めにする。
 * 試験が作る伝票番号は、必ず numberPrefix で始める（片づけの対象を決めるため）。
 */
export async function withDeliveryScenario<T>(
  run: (context: { client: PgClient; numberPrefix: string }) => Promise<T>,
): Promise<T> {
  if (!isLocalUrl(LOCAL_DB_URL)) throw new Error('手元の DB 以外では配送の場面を作らない');
  assertFakeEnv();
  const client = new Client({ connectionString: LOCAL_DB_URL });
  await client.connect();
  const state: ScenarioState = {
    numberPrefix: `E2E${randomBytes(5).toString('hex').toUpperCase()}`,
    touched: new Map(),
    bridgeClosers: [],
  };
  let locked = false;
  let original: SettingsRow | null = null;
  let failure: unknown = null;
  let result: T | undefined;
  try {
    await client.query('select pg_advisory_lock($1::bigint)', [SCENARIO_LOCK]);
    locked = true;
    await assertFakeHealthy();
    original = await readSettingsRow(client as unknown as PgClient);
    activeScenario = state;
    result = await run({ client: client as unknown as PgClient, numberPrefix: state.numberPrefix });
  } catch (error) {
    failure = error;
  }

  // 片づけ。1つが落ちても残りを続け、試験自身の失敗を隠さない
  activeScenario = null;
  const cleanupErrors: unknown[] = [];
  const attempt = async (step: () => Promise<unknown>) => {
    try {
      await step();
    } catch (error) {
      cleanupErrors.push(error);
    }
  };
  const db = client as unknown as PgClient;
  // 橋渡しの窓口の差し替えと専用の接続を、最初に閉じる（片づけの間に、画面の要求が場面の取引の中へ入らないように）
  for (const close of state.bridgeClosers) await attempt(close);
  if (locked) {
    // 先に自分の登録を止める。作り物の組を先に消すと、その間に別の呼び出しが自分の登録を借りて、作り物に新しい組ができて残る
    await attempt(() => neutralizeScenarioRows(db, state.numberPrefix));
    await attempt(async () => {
      const registered = (
        await db.query(
          'select carrier, tracking_number from private.fulfillment_tracking_registrations where tracking_number like $1',
          [`${state.numberPrefix}%`],
        )
      ).rows as Array<{ carrier: ShippingCarrierId; tracking_number: string }>;
      for (const row of registered) {
        state.touched.set(`${TRACKING_CARRIER_IDS[row.carrier]}:${row.tracking_number}`, {
          carrier: TRACKING_CARRIER_IDS[row.carrier],
          number: row.tracking_number,
        });
      }
      for (const pair of state.touched.values()) await deleteFakeTracking(pair);
    });
    await attempt(async () => {
      if (!original) return;
      const current = await readSettingsRow(db);
      const same =
        current.delivery_tracking_enabled === original.delivery_tracking_enabled &&
        current.delivery_tracking_updated_at?.getTime() === original.delivery_tracking_updated_at?.getTime() &&
        current.delivery_tracking_updated_by === original.delivery_tracking_updated_by;
      if (!same) await writeSettingsRow(db, original);
    });
    await attempt(() => client.query('select pg_advisory_unlock($1::bigint)', [SCENARIO_LOCK]));
  }
  await attempt(() => client.end());
  if (failure) throw failure;
  if (cleanupErrors.length > 0) throw cleanupErrors[0];
  return result as T;
}

// ---- 注文と発送（本物の DB の関数） ----

export type AdminActor = { id: string; email: string };

/** 管理者の代わりの利用者（auth.users の行）。履歴の「操作」に出る人のメールを引けるよう、メールつきで返す */
export async function createAdminActor(client: PgClient): Promise<AdminActor> {
  const email = uniqueEmail('delivery-admin');
  const res = await client.query(
    `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
     values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`,
    [email],
  );
  return { id: res.rows[0].id as string, email };
}

export type PaidOrderFixture = E2eCreatedOrder & {
  orderItemId: string;
  quantity: number;
  email: string;
  orderNumber: string;
  actor: AdminActor;
};

/** 入金済みの注文（在庫の品1行・数 quantity）。会員の注文にしたい時は userId とそのメールを渡す */
export async function createPaidOrderFixture(
  client: PgClient,
  input: { label: string; quantity?: number; userId?: string; email?: string; actor?: AdminActor },
): Promise<PaidOrderFixture> {
  const email = input.email ?? uniqueEmail(`dt-${input.label}`);
  const quantity = input.quantity ?? 1;
  const order = await createOrderWithLines(
    client,
    email,
    [{ name: 'E2E配送のシャツ', quantity, fulfillmentType: 'stock' }],
    { paidAmount: 'total', userId: input.userId },
  );
  return {
    ...order,
    orderItemId: order.orderItemIds[0],
    quantity,
    email,
    orderNumber: orderNumberOf(order.orderId),
    actor: input.actor ?? (await createAdminActor(client)),
  };
}

export type ShipmentFixture = {
  fulfillmentId: string;
  number: number;
  carrier: ShippingCarrierId;
  trackingNumber: string;
  /** 作り物の組（番号は大文字） */
  pair: TrackingPair;
};

/**
 * これから作る発送（shipFixture・createShippedFixture に同じ numberPrefix と tag を渡す）の、作り物の組。
 * 発送を作ると、追跡がオンなら登録が毎分の処理の対象になり、別の試験の定期処理の呼び出しが先に読むことがある。
 * 作り物の答え（setFakeTracking）は、発送を作る前にこの組へ決めておく。
 */
export function pairFor(numberPrefix: string, tag: string, carrier: ShippingCarrierId = 'yamato'): TrackingPair {
  return { carrier: TRACKING_CARRIER_IDS[carrier], number: `${numberPrefix}-${tag}`.toUpperCase() };
}

/** 注文へ発送を足す（DB の admin_create_fulfillment）。伝票番号は numberPrefix で始めて tag で分ける */
export async function shipFixture(
  client: PgClient,
  order: PaidOrderFixture,
  input: { numberPrefix: string; tag: string; carrier?: ShippingCarrierId; notify?: boolean; quantity?: number },
): Promise<ShipmentFixture> {
  const carrier = input.carrier ?? 'yamato';
  const trackingNumber = `${input.numberPrefix}-${input.tag}`;
  const shipment = await createFulfillment(client, order.orderId, order.actor.id, {
    trackingNumber,
    carrier,
    notify: input.notify ?? true,
    lines: [{ orderItemId: order.orderItemId, quantity: input.quantity ?? order.quantity }],
  });
  return {
    fulfillmentId: shipment.fulfillmentId,
    number: shipment.number,
    carrier,
    trackingNumber,
    pair: { carrier: TRACKING_CARRIER_IDS[carrier], number: trackingNumber.toUpperCase() },
  };
}

/** 注文を作って、その全部を1つの発送で送る（数は quantity の全部） */
export async function createShippedFixture(
  client: PgClient,
  input: {
    numberPrefix: string;
    tag: string;
    carrier?: ShippingCarrierId;
    notify?: boolean;
    quantity?: number;
    userId?: string;
    email?: string;
    /** 発送を作る管理者の代わりの利用者。省くと注文ごとに新しく作る（複数の注文で同じ人にしたい時に渡す） */
    actor?: AdminActor;
  },
): Promise<PaidOrderFixture & { shipment: ShipmentFixture }> {
  const quantity = input.quantity ?? 1;
  const order = await createPaidOrderFixture(client, {
    label: input.tag.toLowerCase(), quantity, userId: input.userId, email: input.email, actor: input.actor,
  });
  const shipment = await shipFixture(client, order, { ...input, quantity });
  return { ...order, shipment };
}

/** 手で配達済みにする DB の関数（admin_mark_fulfillment_delivered）。管理画面の「配達済みにする」と同じ関数 */
export async function markDeliveredInDb(
  client: PgClient,
  input: { orderId: string; fulfillmentId: string; actorId: string; deliveredOn: string; notify: boolean; requestKey?: string },
): Promise<{ eventId: string; deliveredAt: Date; replayed: boolean }> {
  const row = (
    await client.query('select * from public.admin_mark_fulfillment_delivered($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::boolean)', [
      input.orderId, input.fulfillmentId, input.actorId, input.requestKey ?? randomUUID(), input.deliveredOn, input.notify,
    ])
  ).rows[0];
  return { eventId: row.event_id as string, deliveredAt: row.delivered_at as Date, replayed: row.replayed as boolean };
}

/** 伝票番号を直す DB の関数（admin_update_fulfillment_tracking）。管理画面の「伝票番号を直す」と同じ関数 */
export async function editTrackingInDb(
  client: PgClient,
  input: {
    orderId: string;
    fulfillmentId: string;
    actorId: string;
    carrier: ShippingCarrierId;
    trackingNumber: string;
    notify: boolean;
    requestKey?: string;
  },
): Promise<{ trackingChangeId: string; trackingVersion: number; replayed: boolean }> {
  const row = (
    await client.query(
      'select * from public.admin_update_fulfillment_tracking($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, $6::text, $7::boolean)',
      [input.orderId, input.fulfillmentId, input.actorId, input.requestKey ?? randomUUID(), input.carrier, input.trackingNumber, input.notify],
    )
  ).rows[0];
  return { trackingChangeId: row.tracking_change_id as string, trackingVersion: Number(row.tracking_version), replayed: row.replayed as boolean };
}

/** 返品の設定のうち、届いた日からの期限に効く物 */
export async function returnWindowSettings(client: PgClient) {
  const row = (
    await client.query('select window_days, window_start, delivery_buffer_days from public.shop_return_settings where id = 1')
  ).rows[0] as { window_days: number | null; window_start: string; delivery_buffer_days: number };
  return { windowDays: row.window_days, windowStart: row.window_start, bufferDays: row.delivery_buffer_days };
}

/** DB が出す、その発送の返品の期限（日本時間の日付。無制限なら null） */
export async function returnDeadlineOf(client: PgClient, orderId: string, fulfillmentId: string): Promise<string | null> {
  const row = (
    await client.query(
      `select deadline_date::text as deadline from private.fulfillment_line_returnable($1::uuid)
       where fulfillment_id = $2::uuid limit 1`,
      [orderId, fulfillmentId],
    )
  ).rows[0] as { deadline: string | null } | undefined;
  if (!row) throw new Error('返品の期限の行が無い');
  return row.deadline;
}

/** 日本時間の今日（YYYY-MM-DD）。DB の now() で決める（アプリの時計や試験の地域設定に頼らない） */
export async function jstToday(client: PgClient): Promise<string> {
  return (await client.query("select (now() at time zone 'Asia/Tokyo')::date::text as today")).rows[0].today as string;
}

/** 日本時間の日付に日数を足す */
export function addDays(date: string, days: number): string {
  const time = Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000;
  return new Date(time).toISOString().slice(0, 10);
}

/** 時刻の日本時間の日付（YYYY-MM-DD） */
export function jstDateOf(value: Date | string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}

/** 日本時間の「M月D日」（画面とメールと同じ書き方） */
export function jstMonthDay(value: Date | string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric' }).formatToParts(new Date(value));
  return `${parts.find((part) => part.type === 'month')?.value}月${parts.find((part) => part.type === 'day')?.value}日`;
}

/** お客様の画面の「最後の更新」の日時（日本時間の年月日と時分。画面と同じ書き方） */
export function jstDateTime(value: Date | string): string {
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Tokyo',
  }).format(new Date(value));
}

// ---- DB の読み取り ----

export async function readFulfillment(client: PgClient, fulfillmentId: string) {
  return (
    await client.query(
      `select delivery_status, delivery_status_at, delivered_at, tracking_version, shipping_carrier, tracking_number,
              notify_customer, shipped_at, cancelled_at
       from public.order_fulfillments where id = $1`,
      [fulfillmentId],
    )
  ).rows[0] as {
    delivery_status: string;
    delivery_status_at: Date;
    delivered_at: Date | null;
    tracking_version: number;
    shipping_carrier: ShippingCarrierId | null;
    tracking_number: string | null;
    notify_customer: boolean;
    shipped_at: Date;
    cancelled_at: Date | null;
  };
}

/** 現版、または version の登録（無ければ undefined） */
export async function readRegistration(client: PgClient, fulfillmentId: string, version?: number) {
  return (
    await client.query(
      `select * from private.fulfillment_tracking_registrations
       where fulfillment_id = $1 and ($2::integer is null or tracking_version = $2)
       order by tracking_version desc limit 1`,
      [fulfillmentId, version ?? null],
    )
  ).rows[0] as
    | {
        tracking_version: number;
        state: 'pending' | 'registered' | 'stopped' | 'failed';
        failure_kind: string | null;
        stop_reason: string | null;
        ever_registered: boolean;
        next_run_at: Date;
        provider_status: string | null;
        provider_sub_status: string | null;
        carrier: ShippingCarrierId;
        tracking_number: string;
      }
    | undefined;
}

export async function readEvents(client: PgClient, fulfillmentId: string) {
  return (
    await client.query(
      `select tracking_version, status, source, happened_at, provider_sub_status, created_by
       from public.order_fulfillment_events where fulfillment_id = $1 order by tracking_version, happened_at, recorded_at, id`,
      [fulfillmentId],
    )
  ).rows as Array<{
    tracking_version: number;
    status: string;
    source: 'shipment' | 'tracking' | 'manual' | 'tracking_edit';
    happened_at: Date;
    provider_sub_status: string | null;
    created_by: string | null;
  }>;
}

export async function readAttention(client: PgClient, fulfillmentId: string) {
  return (
    await client.query(
      `select id, kind, opened_at, resolved_at, resolved_by, resolution
       from public.order_fulfillment_attention where fulfillment_id = $1 order by opened_at, id`,
      [fulfillmentId],
    )
  ).rows as Array<{
    id: string;
    kind: string;
    opened_at: Date;
    resolved_at: Date | null;
    resolved_by: string | null;
    resolution: 'auto' | 'manual' | null;
  }>;
}

export async function readTrackingChanges(client: PgClient, fulfillmentId: string) {
  return (
    await client.query(
      `select tracking_version, from_carrier, from_tracking_number, to_carrier, to_tracking_number, notify_customer
       from public.order_fulfillment_tracking_changes where fulfillment_id = $1 order by tracking_version`,
      [fulfillmentId],
    )
  ).rows as Array<{
    tracking_version: number;
    from_carrier: string | null;
    from_tracking_number: string | null;
    to_carrier: string;
    to_tracking_number: string;
    notify_customer: boolean;
  }>;
}

/** 注文のメールの表の、その種類（複数可）の行 */
export async function readOutbox(client: PgClient, orderId: string, kinds: string[]) {
  return (
    await client.query(
      `select kind, status, fulfillment_id, tracking_version, tracking_change_id
       from private.order_email_outbox where order_id = $1 and kind = any($2::text[]) order by seq`,
      [orderId, kinds],
    )
  ).rows as Array<{ kind: string; status: string; fulfillment_id: string | null; tracking_version: number | null; tracking_change_id: string | null }>;
}

/** 自分の登録だけ、次の読み直しの時刻を今にする（6時間後の予定を待たずに、毎分の処理に読ませる） */
export async function makeRegistrationDue(client: PgClient, fulfillmentId: string): Promise<void> {
  await client.query(
    `update private.fulfillment_tracking_registrations set next_run_at = now()
     where fulfillment_id = $1 and state = 'registered' and lease_token is null`,
    [fulfillmentId],
  );
}

/** 自分の登録だけ、毎分の処理が借りない先の時刻へ送る（登録待ちのまま残したい時に使う） */
export async function holdRegistration(client: PgClient, fulfillmentId: string): Promise<void> {
  await client.query(
    `update private.fulfillment_tracking_registrations set next_run_at = now() + interval '1 day'
     where fulfillment_id = $1 and state in ('pending', 'registered')`,
    [fulfillmentId],
  );
}

// ---- 画面の確かめ ----

/** 横方向にページがはみ出していない（document.documentElement.scrollWidth <= innerWidth） */
export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(overflow.scrollWidth, '横方向のページスクロールが無いこと').toBeLessThanOrEqual(overflow.innerWidth);
}

/** ダイアログが画面の幅の中に収まり、中身が横に見切れていない */
export async function expectDialogFits(page: Page, dialog: Locator): Promise<void> {
  const viewport = page.viewportSize();
  const box = await dialog.boundingBox();
  expect(box, 'ダイアログの位置').not.toBeNull();
  if (box && viewport) {
    expect(box.x, 'ダイアログの左端').toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, 'ダイアログの右端').toBeLessThanOrEqual(viewport.width + 1);
  }
  const clipped = await dialog.evaluate((node) => node.scrollWidth > node.clientWidth + 1);
  expect(clipped, 'ダイアログの中身が横に見切れていないこと').toBe(false);
}

// ---- 管理画面の橋渡し（P22） ----

export type DeliveryBridgeLog = {
  listReads: number;
  attentionReads: number;
  historyReads: number;
  trackingPosts: Array<{ orderId: string; fulfillmentId: string; body: Record<string, unknown>; status: number }>;
  deliveredPosts: Array<{ orderId: string; fulfillmentId: string; body: Record<string, unknown>; status: number }>;
  resolvePosts: Array<{ attentionId: string; status: number }>;
  settingsGets: number;
  /** 設定の GET が返した「取り込む件数」を読んだ順に */
  backfillCounts: number[];
  settingsPuts: Array<{ body: Record<string, unknown>; status: number; backfilledCount: number | null }>;
};

export function newDeliveryBridgeLog(): DeliveryBridgeLog {
  return {
    listReads: 0,
    attentionReads: 0,
    historyReads: 0,
    trackingPosts: [],
    deliveredPosts: [],
    resolvePosts: [],
    settingsGets: 0,
    backfillCounts: [],
    settingsPuts: [],
  };
}

export type DeliveryBridgeContext = {
  /** 場面の接続。橋渡しは問い合わせの重なりを避けるため、これは使わず専用の接続を開く（指示書の宣言の形を保つために受け取る） */
  client: PgClient;
  /** 橋渡しが扱ってよい注文。これ以外の注文の窓口は 404 にする */
  orderIds: string[];
  /** 書く操作の実行者。省くと、橋渡しが管理者の代わりの利用者を作る */
  actor?: AdminActor;
  role?: 'admin' | 'supporter';
  /** 窓口の呼び出しの記録。渡すと橋渡しが書き込む */
  log?: DeliveryBridgeLog;
  /** 設定の「鍵：設定済み」。省くと、起動したアプリと同じ（環境に鍵がある） */
  keyConfigured?: boolean;
};

const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));
const isoOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : iso(value));
const textOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

/** get_order_delivery_detail の jsonb（snake_case）を、窓口の答えの形（C-2）へ写す。src/lib/orders/tracking/delivery-store.ts と同じ写し */
function toOrderDeliveryDetail(raw: Record<string, unknown>): OrderDeliveryDetail {
  const list = (value: unknown): Array<Record<string, unknown>> => (Array.isArray(value) ? (value as Array<Record<string, unknown>>) : []);
  return {
    enabled: raw.enabled === true,
    fulfillments: list(raw.fulfillments).map((row): FulfillmentDeliveryDetail => {
      const registration = row.registration as Record<string, unknown> | null;
      return {
        fulfillmentId: String(row.fulfillment_id),
        number: Number(row.number),
        carrier: textOrNull(row.carrier),
        trackingNumber: textOrNull(row.tracking_number),
        notifyCustomer: row.notify_customer === true,
        shippedAt: String(row.shipped_at),
        cancelledAt: textOrNull(row.cancelled_at),
        trackingVersion: Number(row.tracking_version),
        deliveryStatus: row.delivery_status as FulfillmentDeliveryDetail['deliveryStatus'],
        deliveryStatusAt: String(row.delivery_status_at),
        deliveredAt: textOrNull(row.delivered_at),
        deliveredSource: (textOrNull(row.delivered_source) as FulfillmentDeliveryDetail['deliveredSource']) ?? null,
        registration: registration
          ? {
              state: registration.state as NonNullable<FulfillmentDeliveryDetail['registration']>['state'],
              failureKind: (textOrNull(registration.failure_kind) as NonNullable<FulfillmentDeliveryDetail['registration']>['failureKind']) ?? null,
              stopReason: (textOrNull(registration.stop_reason) as NonNullable<FulfillmentDeliveryDetail['registration']>['stopReason']) ?? null,
              expiresAt: String(registration.expires_at),
              everRegistered: registration.ever_registered === true,
            }
          : null,
        events: list(row.events).map((event) => ({
          id: String(event.id),
          trackingVersion: Number(event.tracking_version),
          status: event.status as FulfillmentDeliveryDetail['deliveryStatus'],
          happenedAt: String(event.happened_at),
          recordedAt: String(event.recorded_at),
          source: event.source as FulfillmentDeliveryDetail['events'][number]['source'],
          providerSubStatus: textOrNull(event.provider_sub_status),
          actorEmail: textOrNull(event.actor_email),
        })),
        trackingChanges: list(row.tracking_changes).map((change) => ({
          id: String(change.id),
          fromCarrier: textOrNull(change.from_carrier),
          fromTrackingNumber: textOrNull(change.from_tracking_number),
          toCarrier: change.to_carrier as ShippingCarrierId,
          toTrackingNumber: String(change.to_tracking_number),
          trackingVersion: Number(change.tracking_version),
          notifyCustomer: change.notify_customer === true,
          changedAt: String(change.changed_at),
          actorEmail: textOrNull(change.actor_email),
          emailStatus: (textOrNull(change.email_status) as FulfillmentDeliveryDetail['trackingChanges'][number]['emailStatus']) ?? null,
        })),
      };
    }),
  };
}

/** 「この注文の履歴」の答え。窓口が使うのと同じ DB の読み出しと同じ組み立て（buildOrderHistory）で作る */
async function bridgeHistory(client: PgClient, orderId: string) {
  const order = (
    await client.query('select id, status::text as status, shipping_email, created_at from public.orders where id = $1', [orderId])
  ).rows[0] as { id: string; status: OrderStatus; shipping_email: string | null; created_at: Date } | undefined;
  if (!order) return null;
  const statusRows = (await client.query('select * from public.list_order_status_history($1::uuid)', [orderId])).rows.map(
    (row): OrderStatusHistoryRow => ({
      changedAt: iso(row.changed_at),
      fromStatus: textOrNull(row.from_status),
      toStatus: String(row.to_status),
      changeReason: textOrNull(row.change_reason),
      actorEmail: textOrNull(row.actor_email),
      shippingCarrier: textOrNull(row.shipping_carrier),
      trackingNumber: textOrNull(row.tracking_number),
      cancelReason: textOrNull(row.cancel_reason),
    }),
  );
  const emailRows = (await client.query('select * from public.list_order_email_history($1::uuid)', [orderId])).rows.map(
    (row): OrderEmailHistoryRow => ({
      id: String(row.email_id),
      kind: row.kind,
      origin: row.origin === 'manual' ? 'manual' : 'auto',
      requestedByEmail: textOrNull(row.requested_by_email),
      status: row.status,
      attempts: Number(row.attempts),
      lastErrorCode: textOrNull(row.last_error_code),
      deliveryStatus: textOrNull(row.delivery_status) as OrderEmailHistoryRow['deliveryStatus'],
      deliveryEventAt: isoOrNull(row.delivery_event_at),
      createdAt: iso(row.created_at),
      sentAt: isoOrNull(row.sent_at),
      finishedAt: isoOrNull(row.finished_at),
      hasBody: row.has_body === true,
      bodyErased: row.body_erased === true,
      fulfillmentId: textOrNull(row.fulfillment_id),
      fulfillmentNumber: row.fulfillment_number === null || row.fulfillment_number === undefined ? null : Number(row.fulfillment_number),
      refundId: textOrNull(row.refund_id),
      returnId: textOrNull(row.return_id),
      returnReceiptId: textOrNull(row.return_receipt_id),
    }),
  );
  const fulfillments = (await client.query('select * from public.list_order_fulfillments($1::uuid)', [orderId])).rows.map(
    (row): OrderFulfillmentHistoryRow => ({
      fulfillmentId: String(row.fulfillment_id),
      number: Number(row.number),
      shippingCarrier: textOrNull(row.shipping_carrier),
      trackingNumber: textOrNull(row.tracking_number),
      notifyCustomer: row.notify_customer === true,
      completesOrder: row.completes_order === true,
      shippedAt: iso(row.shipped_at),
      createdByEmail: textOrNull(row.created_by_email),
      cancelledAt: isoOrNull(row.cancelled_at),
      cancelledByEmail: textOrNull(row.cancelled_by_email),
      legacy: row.legacy === true,
      lines: (Array.isArray(row.lines) ? row.lines : []).map((line: { order_item_id: unknown; quantity: unknown }) => ({
        orderItemId: String(line.order_item_id),
        quantity: Number(line.quantity),
      })),
    }),
  );
  const lines = (
    await client.query(
      `select oi.id, oi.item_name, oi.color, oi.size, l.shipped, l.completed
       from public.order_items as oi
       join public.list_order_line_fulfillment(array[$1::uuid]) as l on l.order_item_id = oi.id
       where oi.order_id = $1 order by oi.created_at, oi.id`,
      [orderId],
    )
  ).rows.map((row): OrderHistoryLine => {
    const variant = [row.color, row.size].filter(Boolean).join(' / ');
    return {
      orderItemId: String(row.id),
      name: variant ? `${row.item_name}（${variant}）` : String(row.item_name),
      shipped: Number(row.shipped),
      completed: Number(row.completed),
    };
  });
  const detail = (await client.query('select public.get_order_delivery_detail($1::uuid) as detail', [orderId])).rows[0].detail as Record<string, unknown>;
  return buildOrderHistory({
    order: { id: order.id, status: order.status, shippingEmail: order.shipping_email, createdAt: iso(order.created_at) },
    statusRows,
    emailRows,
    sendState: { paused: false, reason: null },
    fulfillments,
    completions: [],
    refunds: [],
    returns: [],
    returnReceiptLines: [],
    returnRecords: [],
    cancelRequests: [],
    lines,
    delivery: toOrderDeliveryDetail(detail),
  });
}

/** 注文の一覧の行。窓口と同じ進み具合の決め方（deriveOrderProgress）に、DB の商品ごとの数と発送ごとの集計を渡す */
async function bridgeOrderRow(client: PgClient, orderId: string): Promise<OrderItem | null> {
  const order = (
    await client.query(
      `select id, status::text as status, shipping_email, shipping_full_name, total_amount, created_at
       from public.orders where id = $1`,
      [orderId],
    )
  ).rows[0] as
    | { id: string; status: OrderStatus; shipping_email: string; shipping_full_name: string; total_amount: number; created_at: Date }
    | undefined;
  if (!order) return null;
  const lines = (
    await client.query(
      `select oi.id, oi.item_name, oi.color, oi.size, oi.quantity, oi.fulfillment_type,
              l.shipped, l.in_production, l.ready_unshipped, l.unshipped
       from public.order_items as oi
       join public.list_order_line_fulfillment(array[$1::uuid]) as l on l.order_item_id = oi.id
       where oi.order_id = $1 order by oi.created_at, oi.id`,
      [orderId],
    )
  ).rows;
  const summary = (await client.query('select * from public.list_order_delivery_summaries(array[$1::uuid])', [orderId])).rows[0] as
    | { active_count: number; delivered_count: number; attention_kind: string | null }
    | undefined;
  const counts: OrderLineProgressCounts[] = lines.map((row) => ({
    fulfillmentType: String(row.fulfillment_type),
    quantity: Number(row.quantity),
    shipped: Number(row.shipped),
    inProduction: Number(row.in_production),
    readyUnshipped: Number(row.ready_unshipped),
    unshipped: Number(row.unshipped),
  }));
  const progress = deriveOrderProgress(order.status, counts, {
    delivery: { activeCount: Number(summary?.active_count ?? 0), deliveredCount: Number(summary?.delivered_count ?? 0) },
  });
  const kind = summary?.attention_kind ?? null;
  return adminOrder({
    id: order.id,
    customerName: order.shipping_full_name,
    customerEmail: order.shipping_email,
    orderDate: jstDateOf(order.created_at).replaceAll('-', '/'),
    itemCount: `${counts.reduce((sum, line) => sum + line.quantity, 0)}点`,
    items: lines.map((row) => ({
      id: String(row.id),
      name: String(row.item_name),
      color: textOrNull(row.color),
      size: textOrNull(row.size),
      quantity: Number(row.quantity),
      fulfillmentType: row.fulfillment_type === 'backorder' ? ('backorder' as const) : ('stock' as const),
      shipped: Number(row.shipped),
      inProduction: Number(row.in_production),
      readyUnshipped: Number(row.ready_unshipped),
    })),
    totalAmount: `¥${Number(order.total_amount).toLocaleString('ja-JP')}`,
    status: ORDER_PROGRESS_LABELS[progress.key] as OrderItem['status'],
    orderStatus: order.status,
    progressKey: progress.key,
    partiallyShipped: progress.partiallyShipped,
    canShip: order.status === 'paid' && counts.some((line) => line.readyUnshipped > 0),
    canRecordCompletion: false,
    deliveryAttention:
      kind === 'delivery_failure' ? 'failure' : kind === 'attempted_delivery' ? 'attempted_delivery' : kind ? 'untrackable' : null,
  });
}

async function bridgeAttentionItems(client: PgClient, allowed: (orderId: string) => boolean): Promise<DeliveryAttentionItem[]> {
  const enabled = (await client.query('select delivery_tracking_enabled from public.shop_settings where id = 1')).rows[0]
    .delivery_tracking_enabled as boolean;
  if (!enabled) return [];
  const raw = (await client.query('select public.list_delivery_attention(100) as result')).rows[0].result as {
    items: Array<Record<string, unknown>>;
  };
  return raw.items
    .filter((item) => allowed(String(item.order_id)))
    .map((item) => ({
      id: String(item.id),
      orderId: String(item.order_id),
      orderNumber: String(item.order_number),
      fulfillmentId: String(item.fulfillment_id),
      fulfillmentNumber: Number(item.fulfillment_number),
      kind: item.kind as DeliveryAttentionItem['kind'],
      openedAt: String(item.opened_at),
      status: item.status as DeliveryAttentionItem['status'],
    }));
}

async function bridgeSettings(client: PgClient, keyConfigured: boolean) {
  const row = (await client.query('select * from public.get_delivery_tracking_settings()')).rows[0] as {
    enabled: boolean;
    updated_at: Date | null;
    updated_by_email: string | null;
    backfill_count: number;
  };
  return {
    autoRefundCancelledOrderPayment: { enabled: true, updatedAt: null, updatedByEmail: null },
    autoCancelAmountMismatch: { enabled: false, updatedAt: null, updatedByEmail: null },
    deliveryTracking: {
      enabled: row.enabled,
      updatedAt: isoOrNull(row.updated_at),
      updatedByEmail: row.updated_by_email,
      keyConfigured,
      backfillCount: Number(row.backfill_count),
    },
  };
}

/** DB の関数が決まった言葉（DELIVERY_TRACKING_UNCHANGED など）で断った時の、窓口と同じ断りの答え */
async function answerDeliveryFailure(route: Route, error: unknown): Promise<number> {
  const message = error instanceof Error ? error.message : String(error);
  const code = (Object.keys(DELIVERY_ERROR_MESSAGES) as DeliveryErrorCode[]).find((candidate) => message.includes(candidate));
  if (code) {
    const { status, message: text } = DELIVERY_ERROR_MESSAGES[code];
    await fulfillJson(route, { error: text }, status);
    return status;
  }
  await fulfillJson(route, { error: '配送の記録を保存できませんでした。時間をおいて、もう一度お試しください。' }, 500);
  return 500;
}

/**
 * 橋渡し専用の DB の接続。問い合わせは、前の問い合わせが終わってから1本ずつ流す（同じ接続の上で重ねない）。
 * 場面の片づけ（またはページが閉じた時）に、窓口の差し替えを外してから接続を閉じる。場面の接続とは別の接続なので、
 * 場面の側で書いたもの（自動のコミット）は読め、橋渡しが書いたものも場面の側から読める。
 */
async function openBridgeConnection(page: Page): Promise<PgClient> {
  if (!isLocalUrl(LOCAL_DB_URL)) throw new Error('手元の DB 以外では橋渡しを作らない');
  const raw = new Client({ connectionString: LOCAL_DB_URL });
  await raw.connect();
  let tail: Promise<unknown> = Promise.resolve();
  const db: PgClient = {
    query: (text, params) => {
      const run = tail.then(() => raw.query(text, params));
      tail = run.catch(() => undefined);
      return run as unknown as ReturnType<PgClient['query']>;
    },
    end: () => raw.end(),
  };
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    // 処理中の窓口の答えを待ってから、差し替えを外す。ページがもう閉じていても構わない
    await page.unrouteAll({ behavior: 'wait' }).catch(() => undefined);
    await tail.catch(() => undefined);
    await raw.end();
  };
  activeScenario?.bridgeClosers.push(close);
  page.once('close', () => void close());
  return db;
}

/**
 * 管理画面の橋渡し。管理者のログイン・CSRF・権限は差し替え（P22）、注文の一覧・要対応・履歴・設定の読み出しは DB の本物の結果を
 * 画面の形へ写し、書く3つの操作（伝票番号を直す・配達済みにする・要対応を閉じる）と設定の配送の切り替えは本物の DB の関数を呼ぶ。
 * 許した orderIds 以外の注文は扱わない。
 */
export async function mockAdminDeliveryBridge(page: Page, context: DeliveryBridgeContext): Promise<void> {
  // 画面は窓口を同時に何本も呼ぶので、場面の接続（context.client）は使わず、橋渡しの専用の接続を1本開いて、問い合わせを1本ずつに並べる。
  // 同じ接続の上で問い合わせを重ねると pg の非推奨の警告が出る（pg@9 では誤りになる）うえ、場面の取引（設定を戻す begin → commit）の中へ入りうる
  const client = await openBridgeConnection(page);
  const allowedIds = new Set(context.orderIds);
  const allowed = (orderId: string) => allowedIds.has(orderId);
  const log = context.log ?? newDeliveryBridgeLog();
  const actor = context.actor ?? (await createAdminActor(client));
  const keyConfigured = context.keyConfigured ?? Boolean(process.env.TRACKING_17TRACK_API_KEY?.trim());
  const role = context.role ?? 'admin';

  // 管理者のログインと、管理画面が裏で読む窓口の固定（後から登録した窓口が先に効くので、これを最初に呼ぶ）
  await mockAdminSession(page);
  await page.route('**/api/auth/me', (route) =>
    fulfillJson(route, {
      authenticated: true,
      user: {
        id: role === 'admin' ? 'a' : 's',
        email: role === 'admin' ? 'admin@example.com' : 'support@example.com',
        role,
        mfaVerified: true,
      },
    }),
  );

  await page.route((url) => url.pathname === '/api/admin/orders', async (route) => {
    log.listReads += 1;
    const rows: OrderItem[] = [];
    for (const orderId of context.orderIds) {
      const row = await bridgeOrderRow(client, orderId);
      if (row !== null) rows.push(row);
    }
    await fulfillJson(route, { data: rows, pagination: { page: 1, pageSize: 20, total: rows.length, totalPages: 1 } });
  });

  await page.route('**/api/admin/order-attention', async (route) => {
    log.attentionReads += 1;
    const deliveries = await bridgeAttentionItems(client, allowed);
    await fulfillJson(route, {
      data: { exceptions: [], reviews: [], deliveries, counts: { exceptions: 0, reviews: 0, deliveries: deliveries.length } },
    });
  });

  await page.route(/\/api\/admin\/order-attention\/deliveries\/([^/]+)\/resolve$/, async (route) => {
    const attentionId = /\/deliveries\/([^/]+)\/resolve$/.exec(new URL(route.request().url()).pathname)?.[1] ?? '';
    try {
      const owner = (
        await client.query(
          `select f.order_id from public.order_fulfillment_attention as a
           join public.order_fulfillments as f on f.id = a.fulfillment_id where a.id = $1::uuid`,
          [attentionId],
        )
      ).rows[0] as { order_id: string } | undefined;
      if (!owner || !allowed(owner.order_id)) {
        log.resolvePosts.push({ attentionId, status: 404 });
        await fulfillJson(route, { error: DELIVERY_ERROR_MESSAGES.DELIVERY_ATTENTION_NOT_FOUND.message }, 404);
        return;
      }
      const result = (await client.query('select * from public.admin_resolve_delivery_attention($1::uuid, $2::uuid)', [attentionId, actor.id])).rows[0];
      log.resolvePosts.push({ attentionId, status: 200 });
      await fulfillJson(route, { data: { outcome: result.outcome } });
    } catch (error) {
      log.resolvePosts.push({ attentionId, status: await answerDeliveryFailure(route, error) });
    }
  });

  await page.route(/\/api\/admin\/orders\/([^/]+)\/history$/, async (route) => {
    const orderId = /\/orders\/([^/]+)\/history$/.exec(new URL(route.request().url()).pathname)?.[1] ?? '';
    if (!allowed(orderId)) {
      await fulfillJson(route, { error: 'Order not found' }, 404);
      return;
    }
    log.historyReads += 1;
    await fulfillJson(route, await bridgeHistory(client, orderId));
  });

  await page.route(/\/api\/admin\/orders\/([^/]+)\/fulfillments\/([^/]+)\/(tracking|delivered)$/, async (route) => {
    const match = /\/orders\/([^/]+)\/fulfillments\/([^/]+)\/(tracking|delivered)$/.exec(new URL(route.request().url()).pathname);
    const [, orderId = '', fulfillmentId = '', operation = ''] = match ?? [];
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    const record = (status: number) =>
      (operation === 'tracking' ? log.trackingPosts : log.deliveredPosts).push({ orderId, fulfillmentId, body, status });
    if (!allowed(orderId)) {
      record(404);
      await fulfillJson(route, { error: DELIVERY_ERROR_MESSAGES.ORDER_NOT_FOUND.message }, 404);
      return;
    }
    try {
      if (operation === 'tracking') {
        const row = (
          await client.query('select * from public.admin_update_fulfillment_tracking($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, $6::text, $7::boolean)', [
            orderId, fulfillmentId, actor.id, body.requestKey, body.carrier, body.trackingNumber, body.notifyCustomer,
          ])
        ).rows[0];
        record(200);
        await fulfillJson(route, {
          data: { trackingChangeId: row.tracking_change_id, trackingVersion: Number(row.tracking_version), replayed: row.replayed },
        });
        return;
      }
      const row = (
        await client.query('select * from public.admin_mark_fulfillment_delivered($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::boolean)', [
          orderId, fulfillmentId, actor.id, body.requestKey, body.deliveredOn, body.notifyCustomer,
        ])
      ).rows[0];
      record(200);
      await fulfillJson(route, { data: { eventId: row.event_id, deliveredAt: iso(row.delivered_at), replayed: row.replayed } });
    } catch (error) {
      record(await answerDeliveryFailure(route, error));
    }
  });

  await page.route('**/api/admin/settings/shop', async (route) => {
    if (route.request().method() === 'GET') {
      log.settingsGets += 1;
      const payload = await bridgeSettings(client, keyConfigured);
      log.backfillCounts.push(payload.deliveryTracking.backfillCount);
      await fulfillJson(route, { data: payload });
      return;
    }
    const body = (route.request().postDataJSON() ?? {}) as { deliveryTracking?: { enabled?: boolean } };
    let backfilledCount: number | null = null;
    if (typeof body.deliveryTracking?.enabled === 'boolean') {
      if (body.deliveryTracking.enabled && !keyConfigured) {
        log.settingsPuts.push({ body, status: 409, backfilledCount: null });
        await fulfillJson(route, { error: DELIVERY_ERROR_MESSAGES.DELIVERY_TRACKING_KEY_MISSING.message }, 409);
        return;
      }
      backfilledCount = (await setTrackingViaFunction(client, body.deliveryTracking.enabled, actor.id)).backfilledCount;
    }
    log.settingsPuts.push({ body, status: 200, backfilledCount });
    await fulfillJson(route, {
      data: { ...(await bridgeSettings(client, keyConfigured)), ...(backfilledCount === null ? {} : { backfilledCount }) },
    });
  });
}

// ---- お客様の画面 ----

/** お客様の注文の窓口（GET /api/orders/[id]）の答えのうち、配送に関わる所 */
export type CustomerOrderBody = {
  id: string;
  orderNumber: string;
  progress: { key: string; label: string; partiallyShipped: boolean; steps: Array<{ key: string; label: string; state: string }> | null };
  shipments: Array<{
    id: string;
    number: number;
    carrier: string | null;
    trackingNumber: string | null;
    trackingUrl: string | null;
    deliveredAt?: string | null;
    delivery?: { status: string; statusAt: string; events: Array<{ status: string; happenedAt: string }> };
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
};

/**
 * ページから出す /api/orders/** の要求の送信元を、試験ごとの値にする（全部の E2E が共有する 127.0.0.1 の回数の枠を使い切らない）。
 * ログインの要求は page.request から出て page.route を通らないので、loginAsMember の第3引数にも同じ値を渡す。
 */
export async function isolateCustomerApiIp(page: Page): Promise<string> {
  const bits = randomUUID().replaceAll('-', '');
  const ip = `2001:db8:${(bits.match(/.{4}/g) ?? []).slice(0, 6).join(':')}`;
  await page.route('**/api/orders/**', async (route) => {
    const target = new URL(route.request().url());
    const origin = new URL(page.url()).origin;
    if (!isLocalUrl(target.origin) || target.origin !== origin) {
      await route.fallback();
      return;
    }
    await route.continue({ headers: { ...route.request().headers(), 'x-forwarded-for': ip } });
  });
  return ip;
}

/** 会員を作ってログインする（確認コードは本物の道を通る）。使う spec は、ファイルの最上位に test.use({ trace: 'off' }) を置く */
export async function loginCustomer(page: Page, label: string): Promise<TestMember> {
  const member = await createTestMember(label);
  const ip = await isolateCustomerApiIp(page);
  await loginAsMember(page, member, ip);
  return member;
}

/** お客様の注文の画面を開く（注文番号が出るまで待つ） */
export async function openCustomerOrder(page: Page, orderId: string): Promise<void> {
  await page.goto(`/account/orders/${orderId}`);
  await expect(page.getByText(orderNumberOf(orderId), { exact: true })).toBeVisible();
}

/** お客様の注文の画面の、n回目の発送の区切り */
export function customerShipment(page: Page, number: number): Locator {
  return page.getByRole('region', { name: `配送情報（${number}回目）`, exact: true });
}

/** ログインしたページから、お客様の注文の窓口（GET）を呼ぶ */
export async function customerApi<T = CustomerOrderBody>(page: Page, apiPath: string): Promise<{ status: number; body: T }> {
  if (!apiPath.startsWith('/api/orders')) throw new Error('お客様の注文の窓口だけを呼ぶ');
  return (await page.evaluate(async (target) => {
    const response = await fetch(target, { credentials: 'same-origin', cache: 'no-store' });
    return { status: response.status, body: await response.json().catch(() => null) };
  }, apiPath)) as { status: number; body: T };
}

// ---- 管理画面の操作 ----

/**
 * ORDER の一覧のその注文の「履歴」を押して、履歴のダイアログを開く。
 * 戻す物は、履歴・直す画面・配達済みの画面のどれを見ていても同じダイアログを指す（画面を切り替えると、ダイアログの名前
 * （aria-label）が「この注文の履歴」から「伝票番号を直す」などに変わるので、名前では探さない。ダイアログは1つしか開かない）
 */
export async function openOrderHistory(page: Page, orderId: string): Promise<Locator> {
  await page.getByRole('button', { name: `${orderNumberOf(orderId)} の履歴`, exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'この注文の履歴', exact: true })).toBeVisible();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(`${orderNumberOf(orderId)}（`)).toBeVisible();
  return dialog;
}

/** 履歴のダイアログの、n回目の発送の行 */
export function fulfillmentRow(dialog: Locator, number: number): Locator {
  return dialog.getByRole('listitem').filter({ hasText: `発送（${number}回目）` }).filter({ hasText: '配送業者:' });
}

/** 乱数の二重防止の番号を使う試験で、同じ画面の操作を区別するための短い印 */
export function shortId(): string {
  return randomUUID().slice(0, 8);
}
