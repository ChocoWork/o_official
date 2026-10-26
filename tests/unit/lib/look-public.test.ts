import {
  LOOK_SEASON_OPTIONS,
  filterLooksBySeason,
  formatLookSeason,
  normalizeLookSeasonSelection,
  parseLookId,
  resolveLookSeasonFilter,
  toLookSeasonValues,
} from '@/lib/look/public';

describe('look public helpers', () => {
  const looks = [
    { seasonType: 'SS' as const, seasonYear: 2026 },
    { seasonType: 'AW' as const, seasonYear: 2026 },
    { seasonType: 'SS' as const, seasonYear: 2027 },
  ];

  it('DD-LOOK-033 formats season labels', () => {
    expect(formatLookSeason(2028, 'SS')).toBe('2028 SS');
  });

  it('DD-LOOK-033 joins the year and the season with a single space', () => {
    expect(formatLookSeason(2026, 'AW')).toBe('2026 AW');
  });

  it('DD-LOOK-005 offers ALL, SS and AW as the season options', () => {
    expect(LOOK_SEASON_OPTIONS).toEqual(['ALL', 'SS', 'AW']);
  });

  it('DD-LOOK-005 resolves invalid or blank query values to the fallback season', () => {
    expect(resolveLookSeasonFilter(undefined)).toBe('ALL');
    expect(resolveLookSeasonFilter('')).toBe('ALL');
    expect(resolveLookSeasonFilter('invalid')).toBe('ALL');
    expect(resolveLookSeasonFilter('aw')).toBe('AW');
  });

  it('DD-LOOK-005 trims and upper-cases the query value before matching', () => {
    expect(resolveLookSeasonFilter(' aw ')).toBe('AW');
    expect(resolveLookSeasonFilter('ss')).toBe('SS');
    expect(resolveLookSeasonFilter(' all ')).toBe('ALL');
  });

  it('DD-LOOK-005 returns the default ALL fallback for null and undefined', () => {
    expect(resolveLookSeasonFilter(null)).toBe('ALL');
    expect(resolveLookSeasonFilter(undefined)).toBe('ALL');
  });

  it('DD-LOOK-005 returns the given fallback for whitespace-only values', () => {
    expect(resolveLookSeasonFilter('  ', 'SS')).toBe('SS');
  });

  it('DD-LOOK-005 returns the given fallback for values outside ALL, SS and AW', () => {
    expect(resolveLookSeasonFilter('FW', 'AW')).toBe('AW');
    expect(resolveLookSeasonFilter('FW')).toBe('ALL');
  });

  it('DD-LOOK-005 ignores the fallback when the value is valid', () => {
    expect(resolveLookSeasonFilter('SS', 'AW')).toBe('SS');
  });

  it('DD-LOOK-005 normalizes selection changes to a single active season', () => {
    expect(normalizeLookSeasonSelection([])).toBe('ALL');
    expect(normalizeLookSeasonSelection(['ALL'])).toBe('ALL');
    expect(normalizeLookSeasonSelection(['SS'])).toBe('SS');
    expect(normalizeLookSeasonSelection(['SS', 'AW'])).toBe('AW');
    expect(normalizeLookSeasonSelection(['ALL', 'SS'])).toBe('SS');
    expect(normalizeLookSeasonSelection(['SS', 'ALL'])).toBe('ALL');
  });

  it('DD-LOOK-005 trims and upper-cases each selection value', () => {
    expect(normalizeLookSeasonSelection([' ss ', 'aw'])).toBe('AW');
    expect(normalizeLookSeasonSelection([' ss '])).toBe('SS');
  });

  it('DD-LOOK-005 returns ALL when no selection value is valid', () => {
    expect(normalizeLookSeasonSelection(['X'])).toBe('ALL');
    expect(normalizeLookSeasonSelection(['', '  ', 'FW'])).toBe('ALL');
  });

  it('DD-LOOK-005 skips invalid values and keeps the last valid one', () => {
    expect(normalizeLookSeasonSelection(['SS', 'X'])).toBe('SS');
  });

  it('DD-LOOK-005 maps season filters to MultiSelect values', () => {
    expect(toLookSeasonValues('ALL')).toEqual(['ALL']);
    expect(toLookSeasonValues('SS')).toEqual(['SS']);
    expect(toLookSeasonValues('AW')).toEqual(['AW']);
  });

  it('DD-LOOK-005 returns the same array when the season is ALL', () => {
    expect(filterLooksBySeason(looks, 'ALL')).toBe(looks);
    expect(filterLooksBySeason(looks, 'ALL')).toHaveLength(3);
  });

  it('DD-LOOK-005 filters looks by the selected season ignoring the year', () => {
    expect(filterLooksBySeason(looks, 'SS')).toEqual([looks[0], looks[2]]);
    expect(filterLooksBySeason(looks, 'AW')).toEqual([looks[1]]);
  });

  it('DD-LOOK-005 returns an empty array when no look matches the season', () => {
    expect(filterLooksBySeason([looks[0]!], 'AW')).toEqual([]);
  });
});

describe('parseLookId', () => {
  it('DD-LOOK-068 正の整数の文字を数にする', () => {
    expect(parseLookId('1')).toBe(1);
    expect(parseLookId('1234567890123456')).toBe(1234567890123456);
  });

  it.each(['0', '01', '1.5', '1e3', '-1', ' 1', '1 ', '', 'abc', '0x10', '12345678901234567', '9999999999999999'])(
    'DD-LOOK-068 %p は null にする',
    (value) => {
      expect(parseLookId(value)).toBeNull();
    },
  );
});
