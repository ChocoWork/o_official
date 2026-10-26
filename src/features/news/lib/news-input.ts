/**
 * 公開のニュースの入口の確かめ（src/features/news/lib/news-input.ts）。記事の id と分類を DB や取り出しに渡す前に確かめる。
 *
 * @packageDocumentation
 */
import { categories } from '@/lib/news-data';

const NEWS_ID_PATTERN = /^[1-9]\d{0,17}$/;

/**
 * 記事の id として DB に渡してよい文字か返す。
 *
 * @impl IMPL-NEWS-168
 * @design DD-NEWS-070
 * @remarks id の列は bigint なので、桁を超える数や数字以外を DB に渡すと型の誤りになる。入口で偽にして DB を呼ばず「無い記事」に倒す（SEC-NEWS-012）。
 */
export function isNewsId(value: string): boolean {
  return NEWS_ID_PATTERN.test(value);
}

/**
 * 分類の文字を許可の一覧にある1つの値に直す。外れた値・無い値は ALL。
 *
 * @impl IMPL-NEWS-169
 * @design DD-NEWS-070
 * @remarks 外から来る分類をそのまま絞りに渡さず、許可の一覧の値だけを通す。頁の分類の決まりと窓口の決まりを同じにするため、ここ1か所に置く（SEC-NEWS-012）。
 */
export function resolveNewsCategory(raw: string | null | undefined): (typeof categories)[number] {
  const normalized = (raw ?? 'ALL').toUpperCase();
  return categories.includes(normalized as (typeof categories)[number])
    ? (normalized as (typeof categories)[number])
    : 'ALL';
}
