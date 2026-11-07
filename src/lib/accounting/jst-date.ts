// 仕訳の日は出来事の日の日本時間（設計 1-e）。timestamptz はこの関数で日へ直して渡す。

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 日時を Asia/Tokyo の暦日 `YYYY-MM-DD` へ直す。日本は夏時間が無いので +9 時間で決まる。 */
export function toJstDate(instant: string | Date): string {
	const time = (instant instanceof Date ? instant : new Date(instant)).getTime();
	if (!Number.isFinite(time)) throw new RangeError('invalid instant');
	return new Date(time + JST_OFFSET_MS).toISOString().slice(0, 10);
}
