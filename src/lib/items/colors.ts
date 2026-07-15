import type { Item } from "@/types/item";

export type ColorSwatch = {
  name: string;
  hex: string | null;
};

/**
 * items.colors（string[] または {name, hex}[]）を一覧カード用のスウォッチ配列に正規化する。
 * hex は #RRGGBB 形式のみ採用し、それ以外・未指定は null（＝透明表示）にする。
 */
export function extractColorSwatches(colors: Item["colors"]): ColorSwatch[] {
  if (!Array.isArray(colors)) {
    return [];
  }

  return colors
    .map((entry) => {
      if (typeof entry === "string") {
        return { name: entry, hex: null };
      }
      if (entry && typeof entry === "object" && "name" in entry) {
        const name = String((entry as { name: string }).name);
        const hexValue =
          "hex" in entry ? String((entry as { hex?: string }).hex ?? "") : "";
        const normalizedHex = /^#[0-9a-fA-F]{6}$/.test(hexValue)
          ? hexValue
          : null;
        return { name, hex: normalizedHex };
      }
      return null;
    })
    .filter((entry): entry is ColorSwatch => Boolean(entry));
}
