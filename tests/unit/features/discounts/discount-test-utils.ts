// グループ H Task 5 の画面試験の共通部品（試験ではない。*.test.ts ではないので jest は単独で走らせない）。
// 窓口の応答は、読み切り（arrayBuffer）と閉じる（body.cancel）を数えられる作り物で返す。
import type { AdminDiscountDetail, DiscountAssignmentRow, DiscountListRow } from '@/lib/discounts/admin-discount-types';
import type { DiscountDefinition } from '@/lib/discounts/discount-types';

export type FakeResponse = Response & { arrayBuffer: jest.Mock; json: jest.Mock; body: { cancel: jest.Mock } };

function fake(status: number, body: unknown, headers: Record<string, string> = {}): FakeResponse {
  const text = body === undefined ? '' : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name] ?? null },
    json: jest.fn(async () => JSON.parse(text || 'null')),
    text: jest.fn(async () => text),
    arrayBuffer: jest.fn(async () => new TextEncoder().encode(text).buffer),
    body: { cancel: jest.fn(async () => undefined) },
  } as unknown as FakeResponse;
}

export const okResponse = (body: unknown, status = 200): FakeResponse => fake(status, body);
/** 窓口の非 ok。本文は JSON（認証・制限の既存本文のつもり）で、画面は本文を使わずに読み切るだけ */
export const failResponse = (status: number, body: unknown = { error: 'x' }): FakeResponse => fake(status, body);
/** 本文を読めない非 ok。arrayBuffer が落ち、画面は body.cancel で閉じる */
export function unreadableResponse(status: number): FakeResponse {
  const response = fake(status, { error: 'x' });
  response.arrayBuffer.mockRejectedValue(new Error('stream broken'));
  return response;
}
export const wasDrained = (response: FakeResponse): boolean => response.arrayBuffer.mock.calls.length > 0 || response.body.cancel.mock.calls.length > 0;

export const DISCOUNT_ID = '11111111-1111-4111-8111-111111111111';
export const CODE_ID = '22222222-2222-4222-8222-222222222222';
export const ORDER_ID = '33333333-3333-4333-8333-333333333333';

export function definition(patch: Partial<DiscountDefinition> = {}): DiscountDefinition {
  return {
    id: DISCOUNT_ID, version: '3', name: '秋の10％引き', kind: 'order_percent', method: 'code',
    value: { type: 'percent', value: 10 }, targetMode: 'all', itemIds: [], minimum: { type: 'none', value: 0 },
    audience: 'anyone', allowGuests: false, firstOrderOnly: false, usageLimit: null, oncePerCustomer: false,
    startsAt: '2026-10-01T00:00:00+00:00', endsAt: null, stopped: false, combinesWithProduct: false, combinesWithOrder: false,
    advertise: false, advertisingText: null, repeatPrevious: false, repeatInOrder: false, ...patch,
  };
}

export function assignmentRow(patch: Partial<DiscountAssignmentRow> = {}): DiscountAssignmentRow {
  return {
    rowId: 'aaaaaaaa-0000-4000-8000-000000000001', codeId: CODE_ID, code: 'FRIEND', userId: '44444444-4444-4444-8444-444444444444',
    assigneeDeleted: false, assigneeName: '山田 花子', guestEmailMasked: null, status: 'unused', usedAt: null, orderId: null, ...patch,
  };
}

export function detailBody(patch: Partial<AdminDiscountDetail> = {}): { data: AdminDiscountDetail } {
  const assignments = patch.assignments ?? [];
  return {
    data: {
      codes: [{ codeId: CODE_ID, code: 'FRIEND', singleUse: false, audience: 'assigned', allowGuests: false, assignedUserId: null }],
      discount: definition(), used: false, assignmentTotal: assignments.length, assignments, searchAttention: null,
      permissions: { read: true, manage: true }, ...patch,
    },
  };
}

export function listRow(patch: Partial<DiscountListRow> = {}): DiscountListRow {
  return {
    id: DISCOUNT_ID, name: '秋の10％引き', kind: 'order_percent', method: 'code', status: 'active',
    startsAt: '2026-10-01T00:00:00+00:00', endsAt: null, usedCount: 4, usageLimit: 100, searchAttention: null, ...patch,
  };
}

export function listBody(rows: DiscountListRow[], total = rows.length, manage = true): unknown {
  return { data: { total, rows }, permissions: { read: true, manage } };
}

/** console.error を silent にした試験の後で、act の外の状態更新の警告が出ていないことを確かめる */
export function expectNoActWarnings(): void {
  const warnings = (console.error as jest.Mock).mock.calls.filter(([message]) => String(message).includes('not wrapped in act'));
  expect(warnings).toEqual([]);
}
