/**
 * 検索と候補の窓口が共有する、検索語の入口の決まり。
 *
 * @packageDocumentation
 */
import { z } from 'zod';

const CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/;

/**
 * 前後の空白を取り、100字まで、制御文字（0x00-0x1F・0x7F）を含まない語だけを通す zod の型を返す。
 *
 * @impl IMPL-SEARCH-126
 * @design DD-SEARCH-009
 * @remarks 検索と候補で決まりが違うと、制御文字を含む語が片方だけ DB の関数まで届くので、1か所にそろえる（SEC-SEARCH-004）。
 * 制御文字は DB の関数の引数で壊れた値になりうるため、取り出しの前に 400 で断る。
 */
export function searchQuerySchema() {
  return z
    .string()
    .trim()
    .max(100)
    .refine((value) => !CONTROL_CHAR_RE.test(value), {
      message: 'Control characters are not allowed',
    });
}
