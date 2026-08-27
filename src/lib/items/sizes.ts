/**
 * サイズの表示順の正。Admin の選択肢（`SIZES` = S / M / L / FREE）はこの並びの部分集合で、
 * 保存順はチェックした順になるため、表示側はここを基準に並べ替える。
 */
export const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'FREE'] as const;

/**
 * サイズ配列を SIZE_ORDER の並びにそろえる。
 * SIZE_ORDER に無い値は元の相対順のまま末尾に置く。
 */
export function sortSizes(sizes: readonly string[]): string[] {
  const rank = (size: string): number => {
    const index = (SIZE_ORDER as readonly string[]).indexOf(size.toUpperCase());
    return index === -1 ? SIZE_ORDER.length : index;
  };

  return [...sizes].sort((a, b) => rank(a) - rank(b));
}
