export type LookSeasonType = 'SS' | 'AW';

export type PublicLookLinkedItem = {
  category: string;
  id: number;
  name: string;
  price: number;
  imageUrl: string;
};

export type PublicLook = {
  id: number;
  seasonYear: number;
  seasonType: LookSeasonType;
  theme: string;
  themeDescription: string;
  imageUrls: string[];
  createdAt: string;
  linkedItems: PublicLookLinkedItem[];
};

/**
 * 一覧とホームが受け取る LOOK。説明文を持たない。
 *
 * @remarks 一覧の応答から説明文を外す決まり（SEC-LOOK-009）を型でも守る。説明文が要る詳細だけが PublicLook を使う。
 */
export type PublicLookListItem = Omit<PublicLook, 'themeDescription'>;

export const LOOK_SEASON_OPTIONS = ['ALL', 'SS', 'AW'] as const;

export type LookSeasonFilter = (typeof LOOK_SEASON_OPTIONS)[number];

type LookSeasonLike = {
  seasonType: LookSeasonType;
};

function isLookSeasonFilter(value: string): value is LookSeasonFilter {
  return (LOOK_SEASON_OPTIONS as readonly string[]).includes(value);
}

/**
 * 詳細の URL の id を正の整数にする。合わなければ null。
 *
 * @impl IMPL-LOOK-147
 * @design DD-LOOK-068
 * @remarks id は URL から来る。Number() に任せると '1e3'・'1.5'・' 1'・'0x10' が通るので、10 進の数字だけを受ける。桁を 16 に切り、安全な整数でなければ弾く。
 */
export function parseLookId(value: string): number | null {
  if (!/^[1-9]\d{0,15}$/.test(value)) {
    return null;
  }

  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * シーズンを「2026 AW」の形の文字にする。
 *
 * @impl IMPL-LOOK-110
 * @design DD-LOOK-033
 * @remarks 年とシーズンの種別は別々の列で持つので、詳細の情報欄に出す時にだけ 1 つの文字に組む。
 */
export function formatLookSeason(seasonYear: number, seasonType: LookSeasonType): string {
  return `${seasonYear} ${seasonType}`;
}

/**
 * URL などの文字をシーズンの選択（ALL・SS・AW）の 1 つに直す。
 *
 * @impl IMPL-LOOK-106
 * @design DD-LOOK-005
 * @remarks URL は利用者が手で書き換えられ、空白や大文字小文字が混ざりうるので、そろえた上で候補に無い値は例外にせず fallback に倒す。
 */
export function resolveLookSeasonFilter(
  value: string | null | undefined,
  fallback: LookSeasonFilter = 'ALL',
): LookSeasonFilter {
  const normalized = value?.trim().toUpperCase();

  if (!normalized) {
    return fallback;
  }

  return isLookSeasonFilter(normalized) ? normalized : fallback;
}

/**
 * 複数選択の値を、最後に選ばれた有効なシーズン 1 つに直す。有効な値が無ければ ALL。
 *
 * @impl IMPL-LOOK-107
 * @design DD-LOOK-005
 * @remarks 絞り込みの部品が複数選択の形で値を返すが、一覧が持てる選択は 1 つなので、最後に足された値を採る。
 */
export function normalizeLookSeasonSelection(values: string[]): LookSeasonFilter {
  const normalizedValues = values
    .map((value) => value.trim().toUpperCase())
    .filter((value): value is LookSeasonFilter => isLookSeasonFilter(value));

  if (normalizedValues.length === 0) {
    return 'ALL';
  }

  const lastValue = normalizedValues[normalizedValues.length - 1];
  return lastValue ?? 'ALL';
}

/**
 * シーズンの選択を、複数選択の部品に渡す配列にする。
 *
 * @impl IMPL-LOOK-108
 * @design DD-LOOK-005
 * @remarks ALL も 1 つの選択肢として持つ部品なので、常に要素 1 つの配列にする。
 */
export function toLookSeasonValues(season: LookSeasonFilter): LookSeasonFilter[] {
  return season === 'ALL' ? ['ALL'] : [season];
}

/**
 * LOOK をシーズンで絞る。ALL なら渡された配列をそのまま返す。
 *
 * @impl IMPL-LOOK-109
 * @design DD-LOOK-005
 * @remarks 絞りは画面の上で行うので、サーバーから全件を受け取ったあとで使う。ALL は絞らない普通の状態なので、無駄な複製を避けて渡された配列をそのまま返す。
 */
export function filterLooksBySeason<T extends LookSeasonLike>(
  looks: T[],
  season: LookSeasonFilter,
): T[] {
  if (season === 'ALL') {
    return looks;
  }

  return looks.filter((look) => look.seasonType === season);
}
