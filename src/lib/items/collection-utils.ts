import type { Item } from '@/types/item';

export type CollectionSeason = 'AW' | 'SS';

export type ItemCollectionMeta = {
  year: number | null;
  season: CollectionSeason | null;
  raw: string | null;
};

function normalizeSeason(value: string): CollectionSeason | null {
  const upper = value.toUpperCase();
  if (upper.includes('AW') || upper.includes('AUTUMN') || upper.includes('WINTER')) {
    return 'AW';
  }
  if (upper.includes('SS') || upper.includes('SPRING') || upper.includes('SUMMER')) {
    return 'SS';
  }
  return null;
}

function toSourceText(item: Pick<Item, 'product_details'>): string {
  const details = item.product_details;

  if (!details) {
    return '';
  }

  if (typeof details === 'string') {
    return details;
  }

  if (Array.isArray(details)) {
    return details.join(' ');
  }

  if (typeof details === 'object') {
    if ('collection' in details) {
      const value = (details as Record<string, unknown>).collection;
      if (typeof value === 'string') {
        return value;
      }
    }
    return Object.values(details)
      .filter((value): value is string => typeof value === 'string')
      .join(' ');
  }

  return '';
}

export function parseItemCollectionMeta(item: Pick<Item, 'product_details'>): ItemCollectionMeta {
  const source = toSourceText(item).trim();
  if (source.length === 0) {
    return { year: null, season: null, raw: null };
  }

  const yearMatch = source.match(/\b(19|20)\d{2}\b/);
  const seasonMatch = source.match(/\b(AW|SS|AUTUMN\s*WINTER|SPRING\s*SUMMER)\b/i);

  return {
    year: yearMatch ? Number.parseInt(yearMatch[0], 10) : null,
    season: seasonMatch ? normalizeSeason(seasonMatch[0]) : normalizeSeason(source),
    raw: source,
  };
}
