import { adminLoadFailureMessage } from '@/lib/admin/admin-load-failure';
import { clientFetch } from '@/lib/client-fetch';
import { RATE_LIMITED_MESSAGE } from '@/lib/orders/refund/refund-messages';
import type { DeliveryCallResult } from '@/lib/orders/tracking/delivery-types';
import {
  isShipmentSlipErrorCode,
  isShipmentSlipId,
  parsePackingRow,
  parseShipmentSlipCancelled,
  parseShipmentSlipConfirmed,
  parseShipmentSlipDateCorrected,
  parseShipmentSlipDelivered,
  parseShipmentSlipDetail,
  parseShipmentSlipListRow,
  parseShipmentSlipSaved,
  parseShipmentSlipTrackingUpdated,
  SHIPMENT_SLIP_ERRORS,
  SHIPMENT_SLIP_TEXT,
  type PackingRow,
  type ShipmentSlipCancelled,
  type ShipmentSlipConfirmed,
  type ShipmentSlipConfirmInput,
  type ShipmentSlipDateCorrected,
  type ShipmentSlipDateInput,
  type ShipmentSlipDelivered,
  type ShipmentSlipDeliveredInput,
  type ShipmentSlipDetail,
  type ShipmentSlipDraftLine,
  type ShipmentSlipListRow,
  type ShipmentSlipSaved,
  type ShipmentSlipStage,
  type ShipmentSlipTrackingInput,
  type ShipmentSlipTrackingUpdated,
} from './shipment-slip-types';
import { disputeHoldMessage } from './shipment-slip-notice';

/**
 * 管理画面（ブラウザ）から発送票の窓口を呼ぶ唯一のモジュール（G-3）。荷作り表・票の頁・後の Task の確定・伝票・配達済み・取消・出荷日の訂正が、
 * ここに窓口の呼び出しを足す（別のモジュールに窓口の呼び出しを作らない）。clientFetch を使うのでブラウザだけで動く。サーバーからは import しない。
 * 読取は SlipReadResult、書込みは DeliveryCallResult（ok・refused・blocked・unknown）で返す。
 */

/** 読めた（窓口の答えの中身）か、画面に出す文つきの失敗か。denied は 401・403（権限や認証が無い）で、画面は同じ権限で断られる読み込みを重ねない */
export type SlipReadResult<T> = { kind: 'ok'; data: T } | { kind: 'error'; message: string; denied: boolean };

/** 窓口の応答（{ rows, total, page, limit }）から行と全件数を取る。形が崩れていれば null */
function readPage<T>(body: unknown, parse: (row: unknown) => T): { rows: T[]; total: number } | null {
  if (body === null || typeof body !== 'object') return null;
  const { rows, total } = body as { rows?: unknown; total?: unknown };
  if (!Array.isArray(rows) || typeof total !== 'number' || !Number.isSafeInteger(total) || total < rows.length) return null;
  // 全件があるのに頁が空なのは、頁の指定が合っていない（読み違い）
  if (rows.length === 0 && total > 0) return null;
  try {
    return { rows: rows.map((row: unknown) => parse(row)), total };
  } catch {
    return null;
  }
}

/** 荷作り表の応答: 行と全件数に加えて、操作（下書きを作る）の権限があるかの canManage（真偽）が要る。無ければ・真偽でなければ読み違い */
function readPackingPage(body: unknown): { rows: PackingRow[]; total: number; canManage: boolean } | null {
  const page = readPage(body, parsePackingRow);
  const canManage = (body as { canManage?: unknown } | null)?.canManage;
  return page === null || typeof canManage !== 'boolean' ? null : { ...page, canManage };
}

/** GET を1回読み、成功なら body を parse に渡す。失敗は文にして返す（例外にしない。clientFetch は GET を1回だけ自動で送り直す） */
async function readJson<T>(
  url: string,
  parse: (body: unknown) => T | null,
  messages: { forbidden: string; failed: string },
): Promise<SlipReadResult<T>> {
  const failed: SlipReadResult<T> = { kind: 'error', message: messages.failed, denied: false };
  try {
    const response = await clientFetch(url, { cache: 'no-store' });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        kind: 'error',
        message: adminLoadFailureMessage(response.status, body, messages.forbidden, messages.failed),
        denied: response.status === 401 || response.status === 403,
      };
    }
    const data = parse(body);
    return data === null ? failed : { kind: 'ok', data };
  } catch {
    return failed;
  }
}

/**
 * 荷作り表（GET /api/admin/packing）。slipId を渡すと、その下書きが選んでいる数と、同梱できるか（bundleOk）も付く。
 * 並びは窓口が決めた順（古い注文から）。
 */
export function fetchPacking(input: { slipId?: string | null; limit: number; page: number }): Promise<SlipReadResult<{ rows: PackingRow[]; total: number; canManage: boolean }>> {
  // 票の id は URL のパスではなく query に入れるが、uuid の形でなければ窓口へ送らない
  if (input.slipId && !isShipmentSlipId(input.slipId)) {
    return Promise.resolve({ kind: 'error', message: SHIPMENT_SLIP_TEXT.slipNotFound, denied: false });
  }
  const query = [input.slipId ? `slipId=${input.slipId}` : null, `limit=${input.limit}`, `page=${input.page}`].filter((part) => part !== null).join('&');
  return readJson(`/api/admin/packing?${query}`, readPackingPage, {
    forbidden: SHIPMENT_SLIP_TEXT.packingForbidden,
    failed: SHIPMENT_SLIP_TEXT.packingFailed,
  });
}

/** 発送票の一覧（GET /api/admin/shipment-slips）。stage で絞れる。新しく更新した順 */
export function fetchShipmentSlips(input: { stage?: ShipmentSlipStage | null; limit: number; page: number }): Promise<SlipReadResult<{ rows: ShipmentSlipListRow[]; total: number }>> {
  const query = [input.stage ? `stage=${input.stage}` : null, `limit=${input.limit}`, `page=${input.page}`].filter((part) => part !== null).join('&');
  return readJson(`/api/admin/shipment-slips?${query}`, (body) => readPage(body, parseShipmentSlipListRow), {
    forbidden: SHIPMENT_SLIP_TEXT.slipListForbidden,
    failed: SHIPMENT_SLIP_TEXT.slipListFailed,
  });
}

/** 詳細GETだけが返すサーバーの権限。DBの詳細や役割名には混ぜない。 */
export type ShipmentSlipView = ShipmentSlipDetail & { canCorrectDate: boolean };
/** 発送票1件の詳細と訂正権限。権限の真偽が欠ける応答は読み違いとして断る。 */
export async function fetchShipmentSlip(id: string): Promise<SlipReadResult<ShipmentSlipView>> {
  if (!isShipmentSlipId(id)) return { kind: 'error', message: SHIPMENT_SLIP_TEXT.slipNotFound, denied: false };
  const failed: SlipReadResult<ShipmentSlipView> = { kind: 'error', message: SHIPMENT_SLIP_TEXT.slipFailed, denied: false };
  try {
    const response = await clientFetch(`/api/admin/shipment-slips/${id}`, { cache: 'no-store' });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 404) return { kind: 'error', message: SHIPMENT_SLIP_TEXT.slipNotFound, denied: false };
      return {
        kind: 'error',
        message: adminLoadFailureMessage(response.status, body, SHIPMENT_SLIP_TEXT.slipForbidden, SHIPMENT_SLIP_TEXT.slipFailed),
        denied: response.status === 401 || response.status === 403,
      };
    }
    if (body === null || typeof body !== 'object' || !('canCorrectDate' in body) || typeof body.canCorrectDate !== 'boolean') return failed;
    return { kind: 'ok', data: { ...parseShipmentSlipDetail((body as { slip?: unknown }).slip), canCorrectDate: body.canCorrectDate } };
  } catch {
    return failed;
  }
}

/** 窓口が断った時（記録していない）に画面へ出す文。判断待ちの止め（DISPUTE_HOLD）ならその文、DB の誤りの code が表にあればその本文、無ければ「入力を確かめてください。」 */
function refusedMessage(body: unknown): string {
  // カード会社の判断待ちの注文を含む票の確定の止め（計画2 Task 10）は、その旨の文を出す
  const hold = disputeHoldMessage(body);
  if (hold !== null) return hold;
  const code = body !== null && typeof body === 'object' ? (body as { code?: unknown }).code : undefined;
  return typeof code === 'string' && isShipmentSlipErrorCode(code)
    ? SHIPMENT_SLIP_ERRORS[code][2]
    : SHIPMENT_SLIP_ERRORS.GROUP_G_ARGUMENT_INVALID[2];
}

/**
 * 書く窓口（POST）の答えを、画面が分けて扱う4つにする。処理の前の断り（401・403・429）は blocked、
 * 処理の中の断り（400・404・409・422）は refused、通信が切れた・500 番台・読めない成功は unknown（記録されたか分からない）。
 */
async function callWriter<T = ShipmentSlipSaved>(url: string, payload: unknown, parse: (value: unknown) => T = parseShipmentSlipSaved as (value: unknown) => T): Promise<DeliveryCallResult<T>> {
  let response: Response;
  try {
    response = await clientFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  } catch {
    return { kind: 'unknown' };
  }
  if (response.status >= 500) return { kind: 'unknown' };
  const body: unknown = await response.json().catch(() => null);
  if (response.ok) {
    try {
      return { kind: 'ok', data: parse(body) };
    } catch {
      return { kind: 'unknown' };
    }
  }
  if (response.status === 403) return forbiddenResult(body);
  if (response.status === 401) {
    return { kind: 'blocked', message: adminLoadFailureMessage(response.status, body, SHIPMENT_SLIP_TEXT.forbidden, SHIPMENT_SLIP_TEXT.failed) };
  }
  if (response.status === 429) return { kind: 'blocked', message: RATE_LIMITED_MESSAGE };
  return { kind: 'refused', message: refusedMessage(body) };
}

/**
 * 403 の中身を分ける。CSRF の失敗（reason）は「権限が無い」ではない（再読み込みで直る）ので forbidden にしない。
 * MFA が要る時もその文。窓口が権限の不足を返した時（permission がある・DB の GROUP_G_FORBIDDEN）だけ forbidden: true（画面は操作を隠す）。
 * どれにも当たらない 403 は文だけ出し、操作は隠さない。
 */
function forbiddenResult(body: unknown): Extract<DeliveryCallResult<never>, { kind: 'blocked' }> {
  const { reason, code, permission } = (body !== null && typeof body === 'object' ? body : {}) as { reason?: unknown; code?: unknown; permission?: unknown };
  if (reason === 'CSRF validation failed') return { kind: 'blocked', message: SHIPMENT_SLIP_TEXT.csrfFailed, forbidden: false };
  if (reason === 'MFA required') return { kind: 'blocked', message: adminLoadFailureMessage(403, body, SHIPMENT_SLIP_TEXT.forbidden, SHIPMENT_SLIP_TEXT.failed), forbidden: false };
  if (code === 'GROUP_G_FORBIDDEN' || (typeof permission === 'string' && permission !== '')) {
    return { kind: 'blocked', message: SHIPMENT_SLIP_TEXT.forbidden, forbidden: true };
  }
  return { kind: 'blocked', message: SHIPMENT_SLIP_TEXT.forbidden, forbidden: false };
}

/** 既にある票への書込みの答えが別の票の id だった時は、読み違い（記録されたか分からない）として unknown にする */
async function forSlip<T extends { id: string }>(slipId: string, call: Promise<DeliveryCallResult<T>>): Promise<DeliveryCallResult<T>> {
  const result = await call;
  return result.kind === 'ok' && result.data.id.toLowerCase() !== slipId.toLowerCase() ? { kind: 'unknown' } : result;
}

/**
 * 下書きを作る（slipId が null。POST /api/admin/shipment-slips、本文 { lines, requestKey }）か、
 * 下書きの品物を丸ごと入れ替える（POST /api/admin/shipment-slips/[id]/draft、本文 { expectedVersion, lines, requestKey }）。
 * 同じ requestKey と同じ内容の再送は同じ票を replayed: true で返す。
 */
export function submitSlipDraft(
  slipId: string | null,
  body: { expectedVersion?: number; lines: ShipmentSlipDraftLine[]; requestKey: string },
): Promise<DeliveryCallResult<ShipmentSlipSaved>> {
  if (slipId === null) {
    return callWriter('/api/admin/shipment-slips', { lines: body.lines, requestKey: body.requestKey });
  }
  // 票の id は URL のパスに入るので、uuid の形でなければ窓口へ送らない（送らなかったので記録も無い＝断り）
  if (!isShipmentSlipId(slipId)) return Promise.resolve({ kind: 'refused', message: SHIPMENT_SLIP_TEXT.slipNotFound });
  return forSlip(slipId, callWriter(`/api/admin/shipment-slips/${slipId}/draft`, {
    expectedVersion: body.expectedVersion, lines: body.lines, requestKey: body.requestKey,
  }));
}

/** 下書きを破棄する（POST /api/admin/shipment-slips/[id]/discard、本文 { expectedVersion, requestKey }） */
export function submitSlipDiscard(
  slipId: string,
  body: { expectedVersion: number; requestKey: string },
): Promise<DeliveryCallResult<ShipmentSlipSaved>> {
  if (!isShipmentSlipId(slipId)) return Promise.resolve({ kind: 'refused', message: SHIPMENT_SLIP_TEXT.slipNotFound });
  return forSlip(slipId, callWriter(`/api/admin/shipment-slips/${slipId}/discard`, { expectedVersion: body.expectedVersion, requestKey: body.requestKey }));
}

/** 発送確定。結果不明の再送でも同じrequestKeyと本文を使う。 */
export function submitSlipConfirm(slipId: string, body: ShipmentSlipConfirmInput): Promise<DeliveryCallResult<ShipmentSlipConfirmed>> {
  if (!isShipmentSlipId(slipId)) return Promise.resolve({ kind: 'refused', message: SHIPMENT_SLIP_TEXT.slipNotFound });
  return forSlip(slipId, callWriter(`/api/admin/shipment-slips/${slipId}/confirm`, body, parseShipmentSlipConfirmed));
}

/**
 * 伝票番号を入れる・直す（POST /api/admin/shipment-slips/[id]/tracking、本文 { expectedVersion, carrier, trackingNumber, notifyCustomer, requestKey }）。
 * 結果不明の再送でも同じrequestKeyと本文を使う。
 */
export function submitSlipTrackingEdit(slipId: string, body: ShipmentSlipTrackingInput): Promise<DeliveryCallResult<ShipmentSlipTrackingUpdated>> {
  if (!isShipmentSlipId(slipId)) return Promise.resolve({ kind: 'refused', message: SHIPMENT_SLIP_TEXT.slipNotFound });
  return forSlip(slipId, callWriter(`/api/admin/shipment-slips/${slipId}/tracking`, {
    expectedVersion: body.expectedVersion, carrier: body.carrier, trackingNumber: body.trackingNumber,
    notifyCustomer: body.notifyCustomer, requestKey: body.requestKey,
  }, parseShipmentSlipTrackingUpdated));
}

/** 手動の配達済み（POST /api/admin/shipment-slips/[id]/delivered、本文 { expectedVersion, deliveredOn, notifyCustomer, requestKey }）。結果不明の再送でも同じrequestKeyと本文を使う。 */
export function submitSlipDelivered(slipId: string, body: ShipmentSlipDeliveredInput): Promise<DeliveryCallResult<ShipmentSlipDelivered>> {
  if (!isShipmentSlipId(slipId)) return Promise.resolve({ kind: 'refused', message: SHIPMENT_SLIP_TEXT.slipNotFound });
  return forSlip(slipId, callWriter(`/api/admin/shipment-slips/${slipId}/delivered`, {
    expectedVersion: body.expectedVersion, deliveredOn: body.deliveredOn, notifyCustomer: body.notifyCustomer, requestKey: body.requestKey,
  }, parseShipmentSlipDelivered));
}

/** 発送の取消（POST /api/admin/shipment-slips/[id]/cancel、本文 { expectedVersion, requestKey }）。結果不明の再送でも同じrequestKeyと本文を使う。 */
export function submitSlipCancel(slipId: string, body: { expectedVersion: number; requestKey: string }): Promise<DeliveryCallResult<ShipmentSlipCancelled>> {
  if (!isShipmentSlipId(slipId)) return Promise.resolve({ kind: 'refused', message: SHIPMENT_SLIP_TEXT.slipNotFound });
  return forSlip(slipId, callWriter(`/api/admin/shipment-slips/${slipId}/cancel`, { expectedVersion: body.expectedVersion, requestKey: body.requestKey }, parseShipmentSlipCancelled));
}

/** 日付訂正。結果不明なら同じ本文とrequestKeyで再確認する。 */
export async function submitSlipDateCorrection(
  slipId: string, body: ShipmentSlipDateInput,
): Promise<DeliveryCallResult<ShipmentSlipDateCorrected>> {
  if (!isShipmentSlipId(slipId)) return { kind: 'refused', message: SHIPMENT_SLIP_TEXT.slipNotFound };
  const result = await forSlip(slipId, callWriter(`/api/admin/shipment-slips/${slipId}/shipment-date`, {
    expectedVersion: body.expectedVersion, shipmentDate: body.shipmentDate, reason: body.reason, requestKey: body.requestKey,
  }, parseShipmentSlipDateCorrected));
  return result.kind === 'blocked' && result.forbidden ? { ...result, message: SHIPMENT_SLIP_TEXT.dateForbidden } : result;
}
