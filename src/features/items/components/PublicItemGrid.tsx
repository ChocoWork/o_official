'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Drawer } from '@/components/ui/Drawer';
import { Slider } from '@/components/ui/Slider';
import { Item } from '@/types/item';
import { usePublicItems } from '@/features/items/hooks/usePublicItems';
import { CollectionSeason, parseItemCollectionMeta } from '@/lib/items/collection-utils';
import { cn } from '@/lib/utils';

const ITEM_CATEGORIES = ['ALL', 'TOPS', 'BOTTOMS', 'OUTERWEAR', 'ACCESSORIES'] as const;
const SORT_OPTIONS = [
  { value: 'newest', label: 'NEWEST' },
  { value: 'popular', label: 'POPULAR' },
  { value: 'price_asc', label: 'PRICE: LOW TO HIGH' },
  { value: 'price_desc', label: 'PRICE: HIGH TO LOW' },
] as const;

type ItemCategory = typeof ITEM_CATEGORIES[number];
type ItemSort = (typeof SORT_OPTIONS)[number]['value'];

type PublicItemGridHomeProps = {
  variant: 'home';
  items?: Item[];
  fetchLimit?: number;
  className?: string;
};

type PublicItemGridCatalogProps = {
  variant: 'catalog';
  items: Item[];
  initialHasMore: boolean;
  pageSize: number;
  className?: string;
};

type PublicItemGridProps = PublicItemGridHomeProps | PublicItemGridCatalogProps;

type ItemsApiPayload = {
  items: Item[];
  hasMore: boolean;
};

type StockFilter = 'all' | 'in' | 'out';
type DrawerSectionKey = 'category' | 'color' | 'stock' | 'size' | 'season' | 'price';

type ColorSwatch = {
  name: string;
  hex: string | null;
};

function parseSort(sort: string | null): ItemSort {
  return SORT_OPTIONS.some((entry) => entry.value === sort) ? (sort as ItemSort) : 'newest';
}

function parseIntQuery(value: string | null): number | '' {
  if (!value) {
    return '';
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return '';
  }
  return parsed;
}

function parseStock(value: string | null): StockFilter {
  if (value === 'in' || value === 'out') {
    return value;
  }
  return 'all';
}

function parseSeasons(value: string | null): CollectionSeason[] {
  if (!value) {
    return ['AW', 'SS'];
  }

  const tokens = value
    .split(',')
    .map((entry) => entry.trim().toUpperCase())
    .filter((entry): entry is CollectionSeason => entry === 'AW' || entry === 'SS');

  if (tokens.length === 0) {
    return ['AW', 'SS'];
  }

  return Array.from(new Set(tokens));
}

function parseCategories(value: string | null): ItemCategory[] {
  if (!value) {
    return [];
  }
  const tokens = value.split(',').map((t) => t.trim().toUpperCase());
  return tokens.filter(
    (t): t is ItemCategory => ITEM_CATEGORIES.includes(t as ItemCategory) && t !== 'ALL',
  );
}

function parseSizes(value: string | null): string[] {
  if (!value) {
    return [];
  }
  return value.split(',').map((t) => t.trim()).filter(Boolean);
}

function parseColors(value: string | null): string[] {
  if (!value) {
    return [];
  }
  return value.split(',').map((t) => t.trim()).filter(Boolean);
}

function normalizeColor(value: string): string {
  return value.trim().toLowerCase();
}

function extractCollection(item: Item): string | null {
  if (!item.product_details || typeof item.product_details !== 'object' || Array.isArray(item.product_details)) {
    return null;
  }
  if (!('collection' in item.product_details)) {
    return null;
  }
  const raw = (item.product_details as Record<string, unknown>).collection;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return null;
  }
  return raw;
}

function extractColors(item: Item): string[] {
  if (!Array.isArray(item.colors)) {
    return [];
  }

  return item.colors
    .map((entry) => {
      if (typeof entry === 'string') {
        return entry;
      }
      if (entry && typeof entry === 'object' && 'name' in entry) {
        return String((entry as { name: string }).name);
      }
      return null;
    })
    .filter((entry): entry is string => Boolean(entry));
}

function extractColorSwatches(item: Item): ColorSwatch[] {
  if (!Array.isArray(item.colors)) {
    return [];
  }

  return item.colors
    .map((entry) => {
      if (typeof entry === 'string') {
        return { name: entry, hex: null };
      }
      if (entry && typeof entry === 'object' && 'name' in entry) {
        const name = String((entry as { name: string }).name);
        const hexValue = 'hex' in entry ? String((entry as { hex?: string }).hex ?? '') : '';
        const normalizedHex = /^#[0-9a-fA-F]{6}$/.test(hexValue) ? hexValue : null;
        return { name, hex: normalizedHex };
      }
      return null;
    })
    .filter((entry): entry is ColorSwatch => Boolean(entry));
}

function isItemInStock(item: Item): boolean {
  const soldOutText = `${item.description ?? ''}`.toLowerCase();
  if (soldOutText.includes('sold out') || soldOutText.includes('在庫切れ')) {
    return false;
  }
  if (Array.isArray(item.sizes) && item.sizes.length === 0) {
    return false;
  }
  return true;
}

function itemKey(item: Item): string {
  return String(item.id);
}

export function PublicItemGrid(props: PublicItemGridProps) {
  const { variant } = props;

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const isSelfFetch = variant === 'home' ? typeof props.items === 'undefined' : false;
  const fetchLimit = variant === 'home' ? (props.fetchLimit ?? 8) : undefined;
  const overFetchLimit = typeof fetchLimit === 'number' ? fetchLimit + 1 : undefined;
  const { items: fetchedItems, loading, error } = usePublicItems({
    limit: overFetchLimit,
    enabled: isSelfFetch,
  });

  const [loadedItems, setLoadedItems] = useState<Item[]>(variant === 'catalog' ? props.items : []);
  const [hasMore, setHasMore] = useState<boolean>(variant === 'catalog' ? props.initialHasMore : false);
  const [nextPage, setNextPage] = useState<number>(2);
  const [isFetchingMore, setIsFetchingMore] = useState<boolean>(false);
  const [isFilterDrawerOpen, setIsFilterDrawerOpen] = useState(false);
  const [isSortMenuOpen, setIsSortMenuOpen] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const sortMenuRef = useRef<HTMLDivElement | null>(null);
  const latestQueryRef = useRef<string>(searchParams.toString());

  const selectedCategoryQuery = searchParams.get('category');
  const selectedSortQuery = searchParams.get('sort');
  const selectedCollectionQuery = searchParams.get('collection');
  const selectedSizeQuery = searchParams.get('size');
  const selectedColorQuery = searchParams.get('color');
  const selectedStockQuery = searchParams.get('stock');
  const selectedCollectionYearMinQuery = searchParams.get('collectionYearMin');
  const selectedCollectionYearMaxQuery = searchParams.get('collectionYearMax');
  const selectedCollectionSeasonsQuery = searchParams.get('collectionSeasons');
  const selectedPriceMinQuery = searchParams.get('priceMin');
  const selectedPriceMaxQuery = searchParams.get('priceMax');

  const selectedCategories = useMemo(() => parseCategories(selectedCategoryQuery), [selectedCategoryQuery]);
  const selectedSort = useMemo(() => parseSort(selectedSortQuery), [selectedSortQuery]);
  const selectedCollection = selectedCollectionQuery ?? '';
  const selectedSizes = useMemo(() => parseSizes(selectedSizeQuery), [selectedSizeQuery]);
  const selectedColors = useMemo(() => parseColors(selectedColorQuery), [selectedColorQuery]);
  const selectedStock = useMemo(() => parseStock(selectedStockQuery), [selectedStockQuery]);
  const selectedCollectionYearMin = useMemo(
    () => parseIntQuery(selectedCollectionYearMinQuery),
    [selectedCollectionYearMinQuery],
  );
  const selectedCollectionYearMax = useMemo(
    () => parseIntQuery(selectedCollectionYearMaxQuery),
    [selectedCollectionYearMaxQuery],
  );
  const selectedCollectionSeasons = useMemo(
    () => parseSeasons(selectedCollectionSeasonsQuery),
    [selectedCollectionSeasonsQuery],
  );
  const selectedPriceMin = useMemo(() => parseIntQuery(selectedPriceMinQuery), [selectedPriceMinQuery]);
  const selectedPriceMax = useMemo(() => parseIntQuery(selectedPriceMaxQuery), [selectedPriceMaxQuery]);

  const [draftCollection, setDraftCollection] = useState(selectedCollection);
  const [draftCategories, setDraftCategories] = useState<ItemCategory[]>(selectedCategories);
  const [draftSizes, setDraftSizes] = useState<string[]>(selectedSizes);
  const [draftColors, setDraftColors] = useState<string[]>(selectedColors);
  const [draftStock, setDraftStock] = useState<StockFilter>(selectedStock);
  const [draftCollectionYearMin, setDraftCollectionYearMin] = useState<number | ''>(selectedCollectionYearMin);
  const [draftCollectionYearMax, setDraftCollectionYearMax] = useState<number | ''>(selectedCollectionYearMax);
  const [draftCollectionSeasons, setDraftCollectionSeasons] = useState<CollectionSeason[]>(selectedCollectionSeasons);
  const [draftPriceRange, setDraftPriceRange] = useState<[number, number]>([0, 100]);
  const [openSections, setOpenSections] = useState<Record<DrawerSectionKey, boolean>>({
    category: true,
    color: true,
    stock: true,
    size: true,
    season: true,
    price: true,
  });

  useEffect(() => {
    if (variant !== 'catalog') {
      return;
    }

    setLoadedItems(props.items);
    setHasMore(props.initialHasMore);
    setNextPage(2);
  }, [variant, props]);

  useEffect(() => {
    latestQueryRef.current = searchParams.toString();
  }, [searchParams]);

  useEffect(() => {
    if (!isFilterDrawerOpen) {
      return;
    }

    setDraftCollection(selectedCollection);
    setDraftCategories(selectedCategories);
    setDraftSizes(selectedSizes);
    setDraftColors(selectedColors);
    setDraftStock(selectedStock);
    setDraftCollectionYearMin(selectedCollectionYearMin);
    setDraftCollectionYearMax(selectedCollectionYearMax);
    setDraftCollectionSeasons(selectedCollectionSeasons);
  }, [
    isFilterDrawerOpen,
    selectedCollection,
    selectedCategories,
    selectedSizes,
    selectedColors,
    selectedStock,
    selectedCollectionYearMin,
    selectedCollectionYearMax,
    selectedCollectionSeasons,
  ]);

  useEffect(() => {
    if (!isSortMenuOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (!sortMenuRef.current?.contains(target)) {
        setIsSortMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [isSortMenuOpen]);

  const updateQuery = useCallback(
    (mutator: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(latestQueryRef.current);
      mutator(params);
      const query = params.toString();
      latestQueryRef.current = query;
      const nextUrl = query.length > 0 ? `${pathname}?${query}` : pathname;
      router.push(nextUrl, { scroll: false });
    },
    [pathname, router],
  );

  const sourceItems = useMemo(() => {
    if (variant === 'home') {
      return props.items ?? fetchedItems;
    }
    return loadedItems;
  }, [variant, props, fetchedItems, loadedItems]);

  const hasMoreHomeItems = variant === 'home' && typeof fetchLimit === 'number' && sourceItems.length > fetchLimit;
  const resolvedItems = useMemo(
    () => sourceItems.slice(0, fetchLimit ?? sourceItems.length),
    [sourceItems, fetchLimit],
  );

  const availableSizes = useMemo(() => {
    const set = new Set<string>();
    for (const item of resolvedItems) {
      if (Array.isArray(item.sizes)) {
        for (const size of item.sizes) {
          set.add(size);
        }
      }
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [resolvedItems]);

  const availableColorSwatches = useMemo(() => {
    const map = new Map<string, string | null>();

    for (const item of resolvedItems) {
      for (const swatch of extractColorSwatches(item)) {
        const key = swatch.name.toUpperCase();
        if (!map.has(key) || (map.get(key) === null && swatch.hex)) {
          map.set(key, swatch.hex);
        }
      }
    }

    return Array.from(map.entries())
      .map(([name, hex]) => ({ name, hex }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [resolvedItems]);

  const collectionYearBounds = useMemo(() => {
    const years = resolvedItems
      .map((item) => parseItemCollectionMeta(item).year)
      .filter((year): year is number => typeof year === 'number' && Number.isFinite(year));

    if (years.length === 0) {
      return { min: 2000, max: new Date().getFullYear() };
    }

    return {
      min: Math.min(...years),
      max: Math.max(...years),
    };
  }, [resolvedItems]);

  useEffect(() => {
    if (!isFilterDrawerOpen) {
      return;
    }

    if (selectedCollectionYearMin === '') {
      setDraftCollectionYearMin(collectionYearBounds.min);
    }
    if (selectedCollectionYearMax === '') {
      setDraftCollectionYearMax(collectionYearBounds.max);
    }
  }, [
    isFilterDrawerOpen,
    selectedCollectionYearMin,
    selectedCollectionYearMax,
    collectionYearBounds.min,
    collectionYearBounds.max,
  ]);

  const priceBounds = useMemo(() => {
    if (resolvedItems.length === 0) {
      return { min: 0, max: 100000 };
    }

    const prices = resolvedItems.map((item) => item.price).filter((price) => Number.isFinite(price));
    return {
      min: Math.min(...prices),
      max: Math.max(...prices),
    };
  }, [resolvedItems]);

  useEffect(() => {
    const min = selectedPriceMin === '' ? priceBounds.min : selectedPriceMin;
    const max = selectedPriceMax === '' ? priceBounds.max : selectedPriceMax;
    setDraftPriceRange([Math.min(min, max), Math.max(min, max)]);
  }, [priceBounds.min, priceBounds.max, selectedPriceMin, selectedPriceMax, isFilterDrawerOpen]);

  const activeFilterCount = useMemo(() => {
    const checks = [
      selectedCollection.length > 0,
      selectedCategories.length > 0,
      selectedSizes.length > 0,
      selectedColors.length > 0,
      selectedStock !== 'all',
      selectedCollectionYearMin !== '' && selectedCollectionYearMin !== collectionYearBounds.min,
      selectedCollectionYearMax !== '' && selectedCollectionYearMax !== collectionYearBounds.max,
      selectedCollectionSeasons.length !== 2,
      selectedPriceMin !== '' && selectedPriceMin !== priceBounds.min,
      selectedPriceMax !== '' && selectedPriceMax !== priceBounds.max,
    ];

    return checks.filter(Boolean).length;
  }, [
    selectedCollection,
    selectedCategories,
    selectedSizes,
    selectedColors,
    selectedStock,
    selectedCollectionYearMin,
    selectedCollectionYearMax,
    selectedCollectionSeasons,
    selectedPriceMin,
    selectedPriceMax,
    collectionYearBounds.min,
    collectionYearBounds.max,
    priceBounds.min,
    priceBounds.max,
  ]);

  const displayItems = useMemo(() => {
    if (variant === 'home') {
      return resolvedItems;
    }

    return resolvedItems.filter((item) => {
      const categoryOk =
        selectedCategories.length === 0 ||
        selectedCategories.includes(item.category.toUpperCase() as ItemCategory);

      const collection = extractCollection(item);
      const collectionOk = !selectedCollection || (collection && collection.toLowerCase() === selectedCollection.toLowerCase());

      const sizeOk =
        selectedSizes.length === 0 ||
        (Array.isArray(item.sizes) && selectedSizes.some((s) => item.sizes!.includes(s)));

      const colorOk =
        selectedColors.length === 0 ||
        selectedColors.some((c) =>
          extractColors(item).map(normalizeColor).includes(normalizeColor(c)),
        );

      const collectionMeta = parseItemCollectionMeta(item);
      const collectionYearMinOk =
        selectedCollectionYearMin === '' ||
        (typeof collectionMeta.year === 'number' && collectionMeta.year >= selectedCollectionYearMin);
      const collectionYearMaxOk =
        selectedCollectionYearMax === '' ||
        (typeof collectionMeta.year === 'number' && collectionMeta.year <= selectedCollectionYearMax);
      const collectionSeasonOk =
        selectedCollectionSeasons.length === 2 ||
        (collectionMeta.season !== null && selectedCollectionSeasons.includes(collectionMeta.season));

      const priceMinOk = selectedPriceMin === '' || item.price >= selectedPriceMin;
      const priceMaxOk = selectedPriceMax === '' || item.price <= selectedPriceMax;

      const stockOk =
        selectedStock === 'all' ||
        (selectedStock === 'in' ? isItemInStock(item) : !isItemInStock(item));

      return (
        categoryOk &&
        collectionOk &&
        sizeOk &&
        colorOk &&
        collectionYearMinOk &&
        collectionYearMaxOk &&
        collectionSeasonOk &&
        stockOk &&
        priceMinOk &&
        priceMaxOk
      );
    });
  }, [
    variant,
    resolvedItems,
    selectedCategories,
    selectedCollection,
    selectedSizes,
    selectedColors,
    selectedStock,
    selectedCollectionYearMin,
    selectedCollectionYearMax,
    selectedCollectionSeasons,
    selectedPriceMin,
    selectedPriceMax,
  ]);

  const applyDraftFilters = useCallback(() => {
    updateQuery((params) => {
      if (draftCollection) {
        params.set('collection', draftCollection);
      } else {
        params.delete('collection');
      }

      if (draftCategories.length > 0) {
        params.set('category', draftCategories.join(','));
      } else {
        params.delete('category');
      }

      if (draftSizes.length > 0) {
        params.set('size', draftSizes.join(','));
      } else {
        params.delete('size');
      }

      if (draftColors.length > 0) {
        params.set('color', draftColors.join(','));
      } else {
        params.delete('color');
      }

      if (draftStock !== 'all') {
        params.set('stock', draftStock);
      } else {
        params.delete('stock');
      }

      if (draftCollectionYearMin !== '') {
        if (draftCollectionYearMin !== collectionYearBounds.min) {
          params.set('collectionYearMin', String(draftCollectionYearMin));
        } else {
          params.delete('collectionYearMin');
        }
      } else {
        params.delete('collectionYearMin');
      }

      if (draftCollectionYearMax !== '') {
        if (draftCollectionYearMax !== collectionYearBounds.max) {
          params.set('collectionYearMax', String(draftCollectionYearMax));
        } else {
          params.delete('collectionYearMax');
        }
      } else {
        params.delete('collectionYearMax');
      }

      if (draftCollectionSeasons.length === 2) {
        params.delete('collectionSeasons');
      } else {
        params.set('collectionSeasons', draftCollectionSeasons.join(','));
      }

      const draftPriceMin = Math.min(draftPriceRange[0], draftPriceRange[1]);
      const draftPriceMax = Math.max(draftPriceRange[0], draftPriceRange[1]);

      if (draftPriceMin !== priceBounds.min) {
        params.set('priceMin', String(draftPriceMin));
      } else {
        params.delete('priceMin');
      }

      if (draftPriceMax !== priceBounds.max) {
        params.set('priceMax', String(draftPriceMax));
      } else {
        params.delete('priceMax');
      }
    });
  }, [
    draftCollection,
    draftCategories,
    draftSizes,
    draftColors,
    draftStock,
    draftCollectionYearMin,
    draftCollectionYearMax,
    draftCollectionSeasons,
    draftPriceRange,
    updateQuery,
    collectionYearBounds.min,
    collectionYearBounds.max,
    priceBounds.min,
    priceBounds.max,
  ]);

  const closeDrawerAndApplyFilters = useCallback(() => {
    applyDraftFilters();
    setIsFilterDrawerOpen(false);
  }, [applyDraftFilters]);

  const resetDraftFilters = useCallback(() => {
    setDraftCollection('');
    setDraftCategories([]);
    setDraftSizes([]);
    setDraftColors([]);
    setDraftStock('all');
    setDraftCollectionYearMin('');
    setDraftCollectionYearMax('');
    setDraftCollectionSeasons(['AW', 'SS']);
    setDraftPriceRange([priceBounds.min, priceBounds.max]);
  }, [priceBounds.max, priceBounds.min]);

  const toggleDraftCategory = useCallback((category: ItemCategory) => {
    setDraftCategories((prev) => {
      if (category === 'ALL') {
        return [];
      }
      const current = prev.filter((entry) => entry !== 'ALL');
      if (current.includes(category)) {
        return current.filter((entry) => entry !== category);
      }
      return [...current, category];
    });
  }, []);

  const toggleDraftColor = useCallback((colorName: string) => {
    if (colorName === 'ALL') {
      setDraftColors([]);
      return;
    }
    setDraftColors((prev) =>
      prev.includes(colorName)
        ? prev.filter((entry) => entry !== colorName)
        : [...prev, colorName],
    );
  }, []);

  const toggleDraftSize = useCallback((size: string) => {
    if (size === 'ALL') {
      setDraftSizes([]);
      return;
    }
    setDraftSizes((prev) =>
      prev.includes(size)
        ? prev.filter((entry) => entry !== size)
        : [...prev, size],
    );
  }, []);

  const toggleDraftStock = useCallback((value: StockFilter) => {
    if (value === 'all') {
      setDraftStock('all');
      return;
    }
    setDraftStock((prev) => (prev === value ? 'all' : value));
  }, []);

  const toggleDraftSeason = useCallback((season: CollectionSeason | 'ALL') => {
    if (season === 'ALL') {
      setDraftCollectionSeasons(['AW', 'SS']);
      return;
    }
    setDraftCollectionSeasons([season]);
  }, []);

  const toggleSection = useCallback((key: DrawerSectionKey) => {
    setOpenSections((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  }, []);

  useEffect(() => {
    if (variant !== 'catalog') {
      return;
    }

    if (!hasMore || isFetchingMore) {
      return;
    }

    const sentinel = sentinelRef.current;
    if (!sentinel) {
      return;
    }

    const observer = new IntersectionObserver(
      async (entries) => {
        const first = entries[0];
        if (!first?.isIntersecting) {
          return;
        }

        setIsFetchingMore(true);
        try {
          const params = new URLSearchParams(searchParams.toString());
          params.set('page', String(nextPage));
          params.set('pageSize', String(props.pageSize));

          const response = await fetch(`/api/items?${params.toString()}`, { cache: 'no-store' });
          if (!response.ok) {
            throw new Error('Failed to fetch next items page');
          }

          const payload = (await response.json()) as ItemsApiPayload;
          setLoadedItems((prev) => {
            const existingKeys = new Set(prev.map(itemKey));
            const deduped = payload.items.filter((item) => !existingKeys.has(itemKey(item)));
            return [...prev, ...deduped];
          });
          setHasMore(payload.hasMore);
          setNextPage((prev) => prev + 1);
        } catch (fetchError) {
          console.error('Failed to fetch next items page:', fetchError);
        } finally {
          setIsFetchingMore(false);
        }
      },
      {
        rootMargin: '300px 0px 300px 0px',
        threshold: 0,
      },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [variant, hasMore, isFetchingMore, nextPage, props, searchParams]);

  const resolvedMobileLimit = variant === 'home' ? 6 : undefined;
  const shouldLimitOnMobile = typeof resolvedMobileLimit === 'number';
  const hasHiddenItemsOnTablet = shouldLimitOnMobile && resolvedItems.length > resolvedMobileLimit;

  const renderGrid = () => (
    <div className='grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-2 sm:gap-4 md:gap-6 lg:gap-8 w-full'>
      {displayItems.map((item, index) => {
        const hideOnMobile = shouldLimitOnMobile && index >= resolvedMobileLimit!;

        return (
          <Link
            key={item.id}
            href={`/item/${item.id}`}
            data-testid="item-card-link"
            className={hideOnMobile ? 'hidden lg:block' : undefined}
          >
            <div className="group cursor-pointer" data-testid="item-card">
              <div className="aspect-[3/4] bg-[#f5f5f5] mb-2 sm:mb-3 overflow-hidden">
                {item.image_url ? (
                  <Image
                    src={item.image_url}
                    alt={item.name}
                    width={600}
                    height={800}
                    className="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-500"
                    priority={false}
                    data-testid="item-image"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-gray-400">
                    No Image
                  </div>
                )}
              </div>
              <div>
                <p className="text-[11px] text-[#474747] mb-1 tracking-wider" data-testid="item-category">
                  {item.category}
                </p>
                <h3 className="mb-1 text-sm text-black font-brand tracking-tight" data-testid="item-name">
                  {item.name}
                </h3>
                <p className="mb-2 text-xs text-black font-brand" data-testid="item-price">
                  ¥{item.price.toLocaleString('ja-JP')}
                </p>
              </div>
            </div>
          </Link>
        );
      })}
    </div>
  );

  if (variant === 'home') {
    if (isSelfFetch && error) {
      return (
        <section id="items" className="px-6 lg:px-12 bg-white w-full pb-14 sm:pb-16 md:pb-20">
          <div className="max-w-7xl mx-auto text-center py-10">
            <div className="text-xl text-red-500">{error}</div>
          </div>
        </section>
      );
    }

    return (
      <section id="items" className="mt-14 sm:mt-16 lg:mt-20 pb-14 sm:pb-16 md:pb-20 px-6 lg:px-12 bg-white w-full">
        <div className="max-w-7xl mx-auto">
          <SectionTitle title="ITEMS" />

          {isSelfFetch && loading ? (
            <div className="text-center py-12 text-[#474747] font-brand">読み込み中...</div>
          ) : resolvedItems.length === 0 ? (
            <div className="text-center py-12 text-[#474747] font-brand">公開中のITEMがありません</div>
          ) : (
            <div id="sym:success">
              {renderGrid()}
              {(hasHiddenItemsOnTablet || hasMoreHomeItems) && (
                <div className="text-center mt-6 md:mt-8 lg:mt-12">
                  <Button href="/item" variant="secondary" size="md" className="font-acumin">
                    VIEW ALL ITEMS
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    );
  }

  return (
    <>
      <div className="mb-4 sm:mb-6 md:mb-8">
        <div className="flex items-center justify-between pt-3">
          <button
            type="button"
            onClick={() => setIsFilterDrawerOpen(true)}
            className="text-[11px] tracking-[0.22em] text-black uppercase"
            aria-label="Open filter drawer"
          >
            FILTER +
            {activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
          </button>

          <div className="relative" ref={sortMenuRef}>
            <button
              type="button"
              onClick={() => setIsSortMenuOpen((prev) => !prev)}
              className="text-[11px] tracking-[0.22em] text-black uppercase"
              aria-label="Open sort menu"
              aria-expanded={isSortMenuOpen}
            >
              SORT
            </button>

            {isSortMenuOpen && (
              <div className="absolute right-0 top-7 z-20 w-52 border border-black/15 bg-white shadow-lg">
                {SORT_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={cn(
                      'w-full px-3 py-2 text-left text-xs tracking-wider hover:bg-[#f5f5f5]',
                      selectedSort === option.value ? 'text-black' : 'text-[#474747]',
                    )}
                    onClick={() => {
                      updateQuery((params) => {
                        params.set('sort', option.value);
                      });
                      setIsSortMenuOpen(false);
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {renderGrid()}

      {displayItems.length === 0 && (
        <div className="text-center py-12">
          <p className="text-base tracking-widest font-brand text-gray-500">商品が見つかりません</p>
        </div>
      )}

      <div ref={sentinelRef} data-testid="item-infinite-sentinel" className="h-8" />
      {isFetchingMore && (
        <div className="text-center text-sm text-[#474747] pb-4">読み込み中...</div>
      )}

      <Drawer
        open={isFilterDrawerOpen}
        onClose={closeDrawerAndApplyFilters}
        side="left"
        size="md"
      >
        <div className="px-5 py-4 sm:px-6 sm:py-5">
          <div className="flex items-center justify-between border-b border-black/10 pb-3">
            <h3 className="text-sm tracking-[0.22em] text-black">FILTER</h3>
            <button
              type="button"
              onClick={closeDrawerAndApplyFilters}
              aria-label="Close filter drawer"
              className="text-xl leading-none text-black"
            >
              ×
            </button>
          </div>

          <div className="pt-3 space-y-3">
            <div className="border-b border-black/10 pb-3">
              <button
                type="button"
                onClick={() => toggleSection('category')}
                className="flex w-full items-center justify-between py-1 text-left text-xs tracking-[0.2em] text-black"
                aria-label="Toggle CATEGORY section"
              >
                <span>CATEGORY</span>
                <span>{openSections.category ? '-' : '+'}</span>
              </button>
              {openSections.category && (
                <div className="mt-2 space-y-2">
                  {ITEM_CATEGORIES.map((category) => {
                    const isAll = category === 'ALL';
                    const isChecked = isAll ? draftCategories.length === 0 : draftCategories.includes(category);
                    return (
                      <label key={category} className="flex cursor-pointer items-center gap-2 text-xs text-[#474747]">
                        <span
                          aria-hidden="true"
                          className={cn(
                            'h-2.5 w-2.5 flex-shrink-0 border',
                            isChecked ? 'bg-black border-black' : 'bg-white border-black/40',
                          )}
                        />
                        <input
                          className="sr-only"
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleDraftCategory(category)}
                          aria-label={`CATEGORY ${category}`}
                        />
                        <span className="tracking-widest">{category}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            {availableColorSwatches.length > 0 && (
              <div className="border-b border-black/10 pb-3">
                <button
                  type="button"
                  onClick={() => toggleSection('color')}
                  className="flex w-full items-center justify-between py-1 text-left text-xs tracking-[0.2em] text-black"
                  aria-label="Toggle COLOR section"
                >
                  <span>COLOR</span>
                  <span>{openSections.color ? '-' : '+'}</span>
                </button>
                {openSections.color && (
                  <div className="mt-2 space-y-2">
                    <label className="flex cursor-pointer items-center gap-2 text-xs text-[#474747]">
                      <span
                        aria-hidden="true"
                        className={cn(
                          'h-2.5 w-2.5 flex-shrink-0 border',
                          draftColors.length === 0 ? 'bg-black border-black' : 'bg-white border-black/40',
                        )}
                      />
                      <input
                        className="sr-only"
                        type="checkbox"
                        checked={draftColors.length === 0}
                        onChange={() => toggleDraftColor('ALL')}
                        aria-label="COLOR ALL"
                      />
                      <span className="tracking-widest">ALL</span>
                    </label>
                    {availableColorSwatches.map((swatch) => {
                      const checked = draftColors.includes(swatch.name);
                      return (
                        <label key={swatch.name} className="flex cursor-pointer items-center gap-2 text-xs text-[#474747]">
                          <span
                            aria-hidden="true"
                            className={cn(
                              'h-2.5 w-2.5 flex-shrink-0 border',
                              checked ? 'bg-black border-black' : 'bg-white border-black/40',
                            )}
                          />
                          <input
                            className="sr-only"
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleDraftColor(swatch.name)}
                            aria-label={`COLOR ${swatch.name}`}
                          />
                          <span
                            className="inline-block h-3 w-3 rounded-full border border-black/20"
                            style={{ backgroundColor: swatch.hex ?? '#ffffff' }}
                            aria-hidden="true"
                          />
                          <span className="tracking-widest">{swatch.name}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            <div className="border-b border-black/10 pb-3">
              <button
                type="button"
                onClick={() => toggleSection('stock')}
                className="flex w-full items-center justify-between py-1 text-left text-xs tracking-[0.2em] text-black"
                aria-label="Toggle STOCK section"
              >
                <span>STOCK</span>
                <span>{openSections.stock ? '-' : '+'}</span>
              </button>
              {openSections.stock && (
                <div className="mt-2 space-y-2">
                  {([
                    { value: 'all', label: 'ALL' },
                    { value: 'in', label: 'IN STOCK' },
                    { value: 'out', label: 'OUT OF STOCK' },
                  ] as const).map((option) => {
                    const checked = draftStock === option.value;
                    return (
                      <label key={option.value} className="flex cursor-pointer items-center gap-2 text-xs text-[#474747]">
                        <span
                          aria-hidden="true"
                          className={cn(
                            'h-2.5 w-2.5 flex-shrink-0 border',
                            checked ? 'bg-black border-black' : 'bg-white border-black/40',
                          )}
                        />
                        <input
                          className="sr-only"
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleDraftStock(option.value)}
                          aria-label={`STOCK ${option.label}`}
                        />
                        <span className="tracking-widest">{option.label}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            {availableSizes.length > 0 && (
              <div className="border-b border-black/10 pb-3">
                <button
                  type="button"
                  onClick={() => toggleSection('size')}
                  className="flex w-full items-center justify-between py-1 text-left text-xs tracking-[0.2em] text-black"
                  aria-label="Toggle SIZE section"
                >
                  <span>SIZE</span>
                  <span>{openSections.size ? '-' : '+'}</span>
                </button>
                {openSections.size && (
                  <div className="mt-2 space-y-2">
                    <label className="flex cursor-pointer items-center gap-2 text-xs text-[#474747]">
                      <span
                        aria-hidden="true"
                        className={cn(
                          'h-2.5 w-2.5 flex-shrink-0 border',
                          draftSizes.length === 0 ? 'bg-black border-black' : 'bg-white border-black/40',
                        )}
                      />
                      <input
                        className="sr-only"
                        type="checkbox"
                        checked={draftSizes.length === 0}
                        onChange={() => toggleDraftSize('ALL')}
                        aria-label="SIZE ALL"
                      />
                      <span className="tracking-widest">ALL</span>
                    </label>
                    {availableSizes.map((size) => {
                      const checked = draftSizes.includes(size);
                      return (
                        <label key={size} className="flex cursor-pointer items-center gap-2 text-xs text-[#474747]">
                          <span
                            aria-hidden="true"
                            className={cn(
                              'h-2.5 w-2.5 flex-shrink-0 border',
                              checked ? 'bg-black border-black' : 'bg-white border-black/40',
                            )}
                          />
                          <input
                            className="sr-only"
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleDraftSize(size)}
                            aria-label={`SIZE ${size}`}
                          />
                          <span className="tracking-widest">{size}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            <div className="border-b border-black/10 pb-3">
              <button
                type="button"
                onClick={() => toggleSection('season')}
                className="flex w-full items-center justify-between py-1 text-left text-xs tracking-[0.2em] text-black"
                aria-label="Toggle SEASON section"
              >
                <span>SEASON</span>
                <span>{openSections.season ? '-' : '+'}</span>
              </button>
              {openSections.season && (
                <div className="mt-2 space-y-2">
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-[#474747]">
                    <span
                      aria-hidden="true"
                      className={cn(
                        'h-2.5 w-2.5 flex-shrink-0 border',
                        draftCollectionSeasons.length === 2 ? 'bg-black border-black' : 'bg-white border-black/40',
                      )}
                    />
                    <input
                      className="sr-only"
                      type="checkbox"
                      checked={draftCollectionSeasons.length === 2}
                      onChange={() => toggleDraftSeason('ALL')}
                      aria-label="SEASON ALL"
                    />
                    <span className="tracking-widest">ALL</span>
                  </label>
                  {(['AW', 'SS'] as const).map((season) => {
                    const checked = draftCollectionSeasons.length === 1 && draftCollectionSeasons[0] === season;
                    return (
                      <label key={season} className="flex cursor-pointer items-center gap-2 text-xs text-[#474747]">
                        <span
                          aria-hidden="true"
                          className={cn(
                            'h-2.5 w-2.5 flex-shrink-0 border',
                            checked ? 'bg-black border-black' : 'bg-white border-black/40',
                          )}
                        />
                        <input
                          className="sr-only"
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleDraftSeason(season)}
                          aria-label={`SEASON ${season}`}
                        />
                        <span className="tracking-widest">{season}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="border-b border-black/10 pb-3">
              <button
                type="button"
                onClick={() => toggleSection('price')}
                className="flex w-full items-center justify-between py-1 text-left text-xs tracking-[0.2em] text-black"
                aria-label="Toggle PRICE section"
              >
                <span>PRICE</span>
                <span>{openSections.price ? '-' : '+'}</span>
              </button>
              {openSections.price && (
                <div className="mt-2 pb-1">
                  <Slider
                    mode="range"
                    label="PRICE RANGE"
                    rangeValue={draftPriceRange}
                    min={priceBounds.min}
                    max={priceBounds.max}
                    step={1000}
                    onRangeChange={setDraftPriceRange}
                    valueDisplay={`¥${Math.min(draftPriceRange[0], draftPriceRange[1]).toLocaleString('ja-JP')} - ¥${Math.max(draftPriceRange[0], draftPriceRange[1]).toLocaleString('ja-JP')}`}
                  />
                </div>
              )}
            </div>
          </div>

          <div className="mt-5">
            <Button
              type="button"
              variant="secondary"
              size="md"
              onClick={resetDraftFilters}
              className="w-full tracking-[0.18em]"
            >
              RESET
            </Button>
          </div>
        </div>
      </Drawer>
    </>
  );
}
