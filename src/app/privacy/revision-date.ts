/**
 * プライバシーポリシーの最終改定日を決める（src/app/privacy/revision-date.ts）。
 *
 * @packageDocumentation
 */

/** 追跡の設定を一度も切り替えていない時に示す、方針の最終改定日 */
export const PRIVACY_POLICY_BASE_REVISION = '2026-10-26';

const jstDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function toJstIsoDate(value: string | null): string | null {
  if (!value) return null;
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return null;
  return jstDateFormatter.format(time);
}

/**
 * 基準日と、追跡の設定が変わった時刻（UTC の文字列）を日本時間の日付にした物の、遅いほうを「YYYY年M月D日」で返す。null・読めない値・基準日より前は基準日。
 *
 * @impl IMPL-PRIVACY-103
 * @design DD-PRIVACY-003
 * @remarks 追跡の切り替えで委託の一覧の一文が出入りするのに、最終改定日が固定のままだと方針が変わった日を誤って示すため、固定の基準日と設定が変わった日の遅いほうにする。
 * 設定の時刻は UTC の文字列なので、日付に直す時は日本時間で数える（UTC のままだと、日本時間の 0 時から 9 時の間は前日の日付になる）。
 */
export function resolveRevisionDate(trackingUpdatedAt: string | null): string {
  const switched = toJstIsoDate(trackingUpdatedAt);
  const latest = switched !== null && switched > PRIVACY_POLICY_BASE_REVISION ? switched : PRIVACY_POLICY_BASE_REVISION;
  const [year, month, day] = latest.split('-').map(Number);
  return `${year}年${month}月${day}日`;
}
