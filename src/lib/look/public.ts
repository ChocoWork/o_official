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

export const LOOK_SEASON_OPTIONS = ['ALL', 'SS', 'AW'] as const;

export type LookSeasonFilter = (typeof LOOK_SEASON_OPTIONS)[number];

type LookSeasonLike = {
  seasonType: LookSeasonType;
};

function isLookSeasonFilter(value: string): value is LookSeasonFilter {
  return (LOOK_SEASON_OPTIONS as readonly string[]).includes(value);
}

export function formatLookSeason(seasonYear: number, seasonType: LookSeasonType): string {
  return `${seasonYear} ${seasonType}`;
}

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

export function toLookSeasonValues(season: LookSeasonFilter): LookSeasonFilter[] {
  return season === 'ALL' ? ['ALL'] : [season];
}

export function filterLooksBySeason<T extends LookSeasonLike>(
  looks: T[],
  season: LookSeasonFilter,
): T[] {
  if (season === 'ALL') {
    return looks;
  }

  return looks.filter((look) => look.seasonType === season);
}
