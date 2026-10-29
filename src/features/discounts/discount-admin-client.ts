// File: src/features/discounts/discount-admin-client.ts
// 割引の管理画面（グループ H Task 5）の共通部分。画面の言葉・日本時間の変換・非 ok の本文の読み切り・要求番号の保持・詳細の読み。
// I/O は clientFetch だけ。DB・server-only には触らない。
import { clientFetch } from '@/lib/client-fetch';
import {
  GROUP_H_ERRORS,
  type AdminDiscountDetail,
  type AdminDiscountCode,
  type DiscountAssignmentRow,
  type DiscountListStatus,
} from '@/lib/discounts/admin-discount-types';
import type { DiscountDefinition, DiscountKind, DiscountMethod } from '@/lib/discounts/discount-types';

export const DISCOUNT_TEXT = {
  title: '割引',
  listForbidden: '割引を見る権限がありません。',
  listFailed: '割引を読み込めませんでした。',
  reload: '読み直す',
  empty: '割引はありません。',
  loading: '読み込み中…',
  attention: '割引の計算を確認してください。',
  create: '割引を作る',
  detailNotFound: GROUP_H_ERRORS.GROUP_H_DISCOUNT_NOT_FOUND[2],
  manageForbidden: GROUP_H_ERRORS.GROUP_H_FORBIDDEN[2],
  staleAfterChange: '変更しましたが、最新の情報を読み込めませんでした。',
  usedNote: '使用後に値や対象を変える場合は、複製して新しく作ってください。',
  stackableNote: GROUP_H_ERRORS.GROUP_H_STACKABLE_AUTOMATIC_LIMIT[2],
  authRequired: '認証が必要です。再ログインしてください。',
  rateLimited: 'しばらくしてから、もう一度お試しください。',
  unavailable: '現在この操作を行えません。しばらくしてからお試しください。',
  failed: GROUP_H_ERRORS.GROUP_H_LOCK_REQUIRED[2],
  invalid: GROUP_H_ERRORS.GROUP_H_ARGUMENT_INVALID[2],
} as const;

export const KIND_LABELS: Readonly<Record<DiscountKind, string>> = {
  order_percent: '注文の％引き',
  order_amount: '注文の円引き',
  product: '商品の割引',
  repeat: 'リピート割引',
  set: 'セット割引',
};
export const METHOD_LABELS: Readonly<Record<DiscountMethod, string>> = { code: 'コード', automatic: '自動' };
export const STATUS_LABELS: Readonly<Record<DiscountListStatus, string>> = {
  scheduled: '予定', active: '有効', expired: '期限切れ', stopped: '止めた',
};
export const ASSIGNMENT_STATUS_LABELS: Readonly<Record<DiscountAssignmentRow['status'], string>> = {
  unused: '未使用', reserved: '使用済み（入金待ち）', confirmed: '使用済み',
};
export const KIND_ORDER: readonly DiscountKind[] = ['order_percent', 'order_amount', 'product', 'repeat', 'set'];
export const STATUS_ORDER: readonly DiscountListStatus[] = ['scheduled', 'active', 'expired', 'stopped'];

export const yen = (value: number): string => `¥${value.toLocaleString('ja-JP')}`;

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 日時を日本時間の `YYYY-MM-DD HH:mm` にする。読めない日時はそのまま返す */
export function formatJst(value: string | null): string {
  if (value === null) return '';
  const time = Date.parse(value);
  return Number.isNaN(time) ? value : new Date(time + JST_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
}

/** `datetime-local` の値（日本時間の壁時計）を UTC の ISO 文字列にする。形が違えば null */
export function jstLocalToIso(local: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return null;
  const time = Date.parse(`${local}:00+09:00`);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/** UTC の ISO 文字列を `datetime-local` の値（日本時間の壁時計）にする */
export function isoToJstLocal(iso: string | null): string {
  if (iso === null) return '';
  const time = Date.parse(iso);
  return Number.isNaN(time) ? '' : new Date(time + JST_OFFSET_MS).toISOString().slice(0, 16);
}

/** 割引の今の状態。詳細の応答には状態が無いので、停止・期間から数える */
export function discountStatus(discount: DiscountDefinition, now: Date = new Date()): DiscountListStatus {
  if (discount.stopped) return 'stopped';
  if (Date.parse(discount.startsAt) > now.getTime()) return 'scheduled';
  if (discount.endsAt !== null && Date.parse(discount.endsAt) <= now.getTime()) return 'expired';
  return 'active';
}

/** 非 ok の本文を読み切る（読めなければ cancel）。認証・制限の応答は no-store で、読まずに残すと fetch が開いたまま残る */
export async function drainBody(response: Response): Promise<string> {
  try {
    if (typeof response.arrayBuffer === 'function') {
      return new TextDecoder().decode(await response.arrayBuffer());
    }
  } catch {
    // 読み切れなかった時は下で cancel する
  }
  try {
    await response.body?.cancel();
  } catch {
    // 閉じられなくても結果の判定には関わらない
  }
  return '';
}

const KNOWN_MESSAGES: ReadonlySet<string> = new Set(Object.values(GROUP_H_ERRORS).map((entry) => entry[2]));

export type DiscountFailure = { status: number; code: string | null; message: string };

/**
 * 非 ok の応答から、画面に出す文を決める（本文は必ず読み切る）。
 * 401/403/404/429/503 は状態で決め、ほかは窓口の固定コードと固定文の組だけを信じる。
 */
export async function readDiscountFailure(response: Response, fallback: string, forbiddenMessage: string): Promise<DiscountFailure> {
  const text = await drainBody(response);
  const { status } = response;
  if (status === 401) return { status, code: null, message: DISCOUNT_TEXT.authRequired };
  if (status === 403) return { status, code: null, message: forbiddenMessage };
  if (status === 429) return { status, code: null, message: DISCOUNT_TEXT.rateLimited };
  if (status === 503 && !text.includes('GROUP_H_')) return { status, code: null, message: DISCOUNT_TEXT.unavailable };
  try {
    const body = JSON.parse(text) as { code?: unknown; error?: unknown };
    if (typeof body.error === 'string' && KNOWN_MESSAGES.has(body.error)) {
      return { status, code: typeof body.code === 'string' ? body.code : null, message: body.error };
    }
  } catch {
    // 本文が JSON でなければ、状態ごとの既定の文にする
  }
  return { status, code: null, message: status === 404 ? DISCOUNT_TEXT.detailNotFound : fallback };
}

/**
 * 同じ操作の連打・再送は同じ要求番号を使う。番号は「操作の中身」の署名ごとに持ち、成功で手放す。
 * 失敗（通信切れ）の後の再送は同じ番号なので、サーバーが元の結果を返す。
 */
export function createRequestKeys(): { keyFor: (signature: string) => string; done: (signature: string) => void } {
  const keys = new Map<string, string>();
  return {
    keyFor: (signature) => {
      const existing = keys.get(signature);
      if (existing) return existing;
      const created = crypto.randomUUID();
      keys.set(signature, created);
      return created;
    },
    done: (signature) => { keys.delete(signature); },
  };
}

export type SharedAssignment = { mode: 'shared'; codeId: string } | { mode: 'batch' };

/** 割り当て行が0件でも、コード自身のsingleUseで共有と束を区別する。 */
export function assignmentMode(codes: readonly AdminDiscountCode[]): SharedAssignment {
  const shared = codes.find((code) => !code.singleUse);
  return shared ? { mode: 'shared', codeId: shared.codeId } : { mode: 'batch' };
}

export type DiscountDetailResult =
  | { kind: 'ready'; data: AdminDiscountDetail }
  | { kind: 'forbidden' }
  | { kind: 'notFound' }
  | { kind: 'error'; message: string };

function isDetail(value: unknown): value is AdminDiscountDetail {
  if (typeof value !== 'object' || value === null) return false;
  const data = value as Record<string, unknown>;
  const discount = data.discount as Record<string, unknown> | null | undefined;
  const permissions = data.permissions as Record<string, unknown> | null | undefined;
  return typeof discount === 'object' && discount !== null && typeof discount.id === 'string' && typeof discount.version === 'string'
    && Array.isArray(data.codes) && data.codes.every((code: AdminDiscountCode) => typeof code?.codeId === 'string' && typeof code.code === 'string' && typeof code.singleUse === 'boolean')
    && Array.isArray(data.assignments) && typeof data.assignmentTotal === 'number' && typeof data.used === 'boolean'
    && typeof permissions === 'object' && permissions !== null && typeof permissions.manage === 'boolean';
}

export async function fetchDiscountDetail(discountId: string, page: number): Promise<DiscountDetailResult> {
  try {
    const query = page > 1 ? `?page=${page}` : '';
    const response = await clientFetch(`/api/admin/discounts/${encodeURIComponent(discountId)}${query}`, { cache: 'no-store' });
    if (!response.ok) {
      const failure = await readDiscountFailure(response, DISCOUNT_TEXT.listFailed, DISCOUNT_TEXT.listForbidden);
      if (failure.status === 403) return { kind: 'forbidden' };
      if (failure.status === 404) return { kind: 'notFound' };
      return { kind: 'error', message: failure.message };
    }
    const json = (await response.json()) as { data?: unknown };
    return isDetail(json.data) && json.data.discount.id === discountId ? { kind: 'ready', data: json.data } : { kind: 'error', message: DISCOUNT_TEXT.listFailed };
  } catch (error) {
    console.error('Failed to fetch admin discount:', error instanceof Error ? error.name : 'UnknownError');
    return { kind: 'error', message: DISCOUNT_TEXT.listFailed };
  }
}
