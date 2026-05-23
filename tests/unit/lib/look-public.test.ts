import {
  filterLooksBySeason,
  formatLookSeason,
  normalizeLookSeasonSelection,
  resolveLookSeasonFilter,
  toLookSeasonValues,
} from '@/lib/look/public';

describe('look public helpers', () => {
  const looks = [
    { seasonType: 'SS' as const, seasonYear: 2026 },
    { seasonType: 'AW' as const, seasonYear: 2026 },
    { seasonType: 'SS' as const, seasonYear: 2027 },
  ];

  it('formats season labels', () => {
    expect(formatLookSeason(2028, 'SS')).toBe('2028 SS');
  });

  it('resolves invalid or blank query values to the fallback season', () => {
    expect(resolveLookSeasonFilter(undefined)).toBe('ALL');
    expect(resolveLookSeasonFilter('')).toBe('ALL');
    expect(resolveLookSeasonFilter('invalid')).toBe('ALL');
    expect(resolveLookSeasonFilter('aw')).toBe('AW');
  });

  it('normalizes selection changes to a single active season', () => {
    expect(normalizeLookSeasonSelection([])).toBe('ALL');
    expect(normalizeLookSeasonSelection(['ALL'])).toBe('ALL');
    expect(normalizeLookSeasonSelection(['SS'])).toBe('SS');
    expect(normalizeLookSeasonSelection(['SS', 'AW'])).toBe('AW');
    expect(normalizeLookSeasonSelection(['ALL', 'SS'])).toBe('SS');
    expect(normalizeLookSeasonSelection(['SS', 'ALL'])).toBe('ALL');
  });

  it('maps season filters to MultiSelect values', () => {
    expect(toLookSeasonValues('ALL')).toEqual(['ALL']);
    expect(toLookSeasonValues('SS')).toEqual(['SS']);
  });

  it('filters looks by the selected season', () => {
    expect(filterLooksBySeason(looks, 'ALL')).toHaveLength(3);
    expect(filterLooksBySeason(looks, 'SS')).toHaveLength(2);
    expect(filterLooksBySeason(looks, 'AW')).toHaveLength(1);
  });
});