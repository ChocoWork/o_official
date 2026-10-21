import {
  DELIVERY_ATTENTION_KINDS,
  DELIVERY_EVENT_SOURCES,
  DELIVERY_STATUSES,
  TRACKING_FAILURE_KINDS,
  TRACKING_STATES,
  TRACKING_STOP_REASONS,
  type DeliveryErrorCode,
} from '@/lib/orders/tracking/delivery-types';
import {
  DELIVERY_ATTENTION_LABELS,
  DELIVERY_ERROR_MESSAGES,
  DELIVERY_STATUS_LABELS,
  TRACKING_STATE_LABELS,
} from '@/lib/orders/tracking/delivery-messages';
import { SEVENTEEN_TRACK_CARRIERS } from '@/lib/orders/tracking/seventeen-track-status';

// C-4 の10記号。実装の表から期待値を作らず、承認された HTTP と文を全部照合する。
const ERROR_CASES = [
  ['ORDER_NOT_FOUND', 404, '注文が見つかりません。'],
  ['FULFILLMENT_NOT_FOUND', 404, '発送の記録が見つかりません。'],
  ['DELIVERY_ARGUMENT_INVALID', 400, '入力を確かめてください。'],
  ['DELIVERY_REQUEST_MISMATCH', 409, '操作の内容が変わりました。画面を開き直してください。'],
  ['DELIVERY_FULFILLMENT_CANCELLED', 409, '取り消した発送は変更できません。'],
  ['DELIVERY_TRACKING_UNCHANGED', 409, '配送業者か伝票番号を直してください。'],
  ['DELIVERY_ALREADY_DELIVERED', 409, 'すでに配達済みです。履歴を読み直してください。'],
  ['DELIVERY_DATE_INVALID', 400, '届いた日は、発送の日から今日までの日を選んでください。'],
  ['DELIVERY_TRACKING_KEY_MISSING', 409, '17TRACK の鍵を設定してください。'],
  ['DELIVERY_ATTENTION_NOT_FOUND', 404, '配送の要対応が見つかりません。'],
] as const satisfies ReadonlyArray<readonly [DeliveryErrorCode, 400 | 404 | 409, string]>;

describe('配送の型・値・文言（C-2/C-4/C-5）', () => {
  test('状態と運送会社は承認した値だけ', () => {
    expect(DELIVERY_STATUSES).toEqual([
      'confirmed', 'in_transit', 'out_for_delivery', 'attempted_delivery',
      'ready_for_pickup', 'delivered', 'delayed', 'failure',
    ]);
    expect(SEVENTEEN_TRACK_CARRIERS).toEqual({ yamato: 100062, sagawa: 100040, japanpost: 10021 });
  });

  test('出来事・要対応・登録・失敗・停止理由は承認した順の値だけ', () => {
    expect(DELIVERY_EVENT_SOURCES).toEqual(['shipment', 'tracking', 'manual', 'tracking_edit']);
    expect(DELIVERY_ATTENTION_KINDS).toEqual([
      'delivery_failure', 'attempted_delivery', 'tracking_not_found',
      'tracking_registration_failed', 'tracking_stalled',
    ]);
    expect(TRACKING_STATES).toEqual(['pending', 'registered', 'stopped', 'failed']);
    expect(TRACKING_FAILURE_KINDS).toEqual(['invalid_number', 'repeated_error']);
    expect(TRACKING_STOP_REASONS).toEqual([
      'delivered', 'expired', 'replaced', 'cancelled', 'provider_stopped', 'disabled',
    ]);
  });

  test.each(ERROR_CASES)('%s の HTTP は %s、文は「%s」', (code, status, message) => {
    expect(DELIVERY_ERROR_MESSAGES[code]).toEqual({ status, message });
  });

  test('誤りの表に C-4 以外の記号を混ぜない', () => {
    expect(Object.keys(DELIVERY_ERROR_MESSAGES).sort()).toEqual(ERROR_CASES.map(([code]) => code).sort());
  });

  test('8つの配送状況の表示は C-5 と同じ', () => {
    expect(DELIVERY_STATUS_LABELS).toEqual({
      confirmed: '受付済み', in_transit: '輸送中', out_for_delivery: '配達中',
      attempted_delivery: '不在で持ち帰り', ready_for_pickup: '受け取り待ち',
      delivered: '配達済み', delayed: '遅れ', failure: '問題あり',
    });
  });

  test('5つの要対応の表示は C-5 と同じ', () => {
    expect(DELIVERY_ATTENTION_LABELS).toEqual({
      delivery_failure: '問題あり', attempted_delivery: '不在で持ち帰り',
      tracking_not_found: '伝票番号で荷物が見つからない',
      tracking_registration_failed: '追跡の登録ができない', tracking_stalled: '配達済みにならない',
    });
  });

  test('4つの登録状態の表示は C-5 と同じ', () => {
    expect(TRACKING_STATE_LABELS).toEqual({
      pending: '登録待ち', registered: '追跡中', stopped: '止めた', failed: '登録できない',
    });
  });
});
