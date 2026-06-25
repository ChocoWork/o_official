"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Accordion } from "@/components/ui/Accordion/Accordion";
import { Button } from "@/components/ui/Button/Button";
import { MultiSelect } from "@/components/ui/MultiSelect/MultiSelect";
import { SingleSelect } from "@/components/ui/SingleSelect/SingleSelect";
import { SectionTitle } from "@/components/ui/SectionTitle/SectionTitle";
import { Drawer } from "@/components/ui/Drawer/Drawer";
import { Slider } from "@/components/ui/Slider/Slider";
import type { ComponentSize } from "@/components/ui/types";
import { Item } from "@/types/item";
import { usePublicItems } from "@/features/items/hooks/usePublicItems";
import {
  CollectionSeason,
  parseItemCollectionMeta,
} from "@/lib/items/collection-utils";
import { cn } from "@/lib/utils";

const ITEM_CATEGORIES = [
  "ALL",
  "TOPS",
  "BOTTOMS",
  "OUTERWEAR",
  "ACCESSORIES",
] as const;
const SORT_OPTIONS = [
  { value: "newest", label: "NEWEST" },
  { value: "popular", label: "POPULAR" },
  { value: "price_asc", label: "PRICE LOW TO HIGH" },
  { value: "price_desc", label: "PRICE HIGH TO LOW" },
] as const;
const FILTER_SIDEBAR_SCROLL_CLASS =
  "flex-1 min-h-0 overflow-y-auto overscroll-contain [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden border-r border-black/5 px-[13px] xl:px-[21px] pt-[8px] xl:pt-[21px] pb-4";
const FILTER_SIDEBAR_ACTIONS_CLASS =
  "flex-shrink-0 border-r border-black/5 px-[13px] xl:px-[21px] pb-[21px] xl:pb-[34px] pt-4 bg-white space-y-2";
const FILTER_DRAWER_CLASS =
  "[scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden";
// FILTER 内タイポグラフィ／余白。stein（ssstein.com）と HYKE（hyke.jp）の FILTER を
// 参考に、フィルターのスペーシングをこのスコープ内だけに適用する（共有 Accordion /
// MultiSelect の他用途には影響させない）。
// - 親（セクション見出し）↔ 子（選択肢）の間隔: stein 参考でゆったり取る（pt 約1.25em）
// - 子（選択肢）↔ 子の間隔: stein/HYKE 両方参考で行ピッチを約27pxに広げる（gap 約0.5em）
// - 見出しの字間: 両サイト参考の控えめなトラッキング（0.06em）
// 文字サイズは現状の 3xs（約11.4px）/ xs（約12.9px）が stein(10px)〜HYKE(13px) の
// 帯に収まっているため据え置く。実体のスタイルは globals.css の .filter-sections に定義。
const FILTER_SECTIONS_SPACING_CLASS = "filter-sections";
// APPLYボタンを廃止し、フィルタ操作が止まってから自動適用するまでのデバウンス時間。
// 検索・フィルタ入力の自動適用は 300ms 前後が一般的なベストプラクティス
// （ユーザーが操作を止めたと判断できる最小待機。連続操作中の過剰なリクエストを防ぐ）。
const FILTER_APPLY_DEBOUNCE_MS = 300;

type ItemCategory = (typeof ITEM_CATEGORIES)[number];
type ItemSort = (typeof SORT_OPTIONS)[number]["value"];

type PublicItemGridHomeProps = {
  variant: "home";
  items?: Item[];
  fetchLimit?: number;
  className?: string;
};

type PublicItemGridCatalogProps = {
  variant: "catalog";
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

type StockValue = "in" | "out";
type DrawerSectionKey =
  | "category"
  | "color"
  | "stock"
  | "size"
  | "season"
  | "price";

type ColorSwatch = {
  name: string;
  hex: string | null;
};

function parseSort(sort: string | null): ItemSort {
  return SORT_OPTIONS.some((entry) => entry.value === sort)
    ? (sort as ItemSort)
    : "newest";
}

function parseIntQuery(value: string | null): number | "" {
  if (!value) {
    return "";
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return "";
  }
  return parsed;
}

// STOCK は in/out のマルチセレクト。空配列は「ALL（絞り込みなし）」を表す。
function parseStockList(value: string | null): StockValue[] {
  if (!value) {
    return [];
  }
  const tokens = value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry): entry is StockValue => entry === "in" || entry === "out");
  return Array.from(new Set(tokens));
}

// SEASON も AW/SS のマルチセレクト。空配列は「ALL（絞り込みなし）」を表す。
function parseSeasons(value: string | null): CollectionSeason[] {
  if (!value) {
    return [];
  }

  const tokens = value
    .split(",")
    .map((entry) => entry.trim().toUpperCase())
    .filter(
      (entry): entry is CollectionSeason => entry === "AW" || entry === "SS",
    );

  return Array.from(new Set(tokens));
}

function parseCategories(value: string | null): ItemCategory[] {
  if (!value) {
    return [];
  }
  const tokens = value.split(",").map((t) => t.trim().toUpperCase());
  return tokens.filter(
    (t): t is ItemCategory =>
      ITEM_CATEGORIES.includes(t as ItemCategory) && t !== "ALL",
  );
}

function parseSizes(value: string | null): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function parseColors(value: string | null): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function normalizeColor(value: string): string {
  return value.trim().toLowerCase();
}

function extractCollection(item: Item): string | null {
  if (
    !item.product_details ||
    typeof item.product_details !== "object" ||
    Array.isArray(item.product_details)
  ) {
    return null;
  }
  if (!("collection" in item.product_details)) {
    return null;
  }
  const raw = (item.product_details as Record<string, unknown>).collection;
  if (typeof raw !== "string" || raw.trim().length === 0) {
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
      if (typeof entry === "string") {
        return entry;
      }
      if (entry && typeof entry === "object" && "name" in entry) {
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

function isItemInStock(item: Item): boolean {
  const soldOutText = `${item.description ?? ""}`.toLowerCase();
  if (soldOutText.includes("sold out") || soldOutText.includes("在庫切れ")) {
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

  const isSelfFetch =
    variant === "home" ? typeof props.items === "undefined" : false;
  const fetchLimit = variant === "home" ? (props.fetchLimit ?? 8) : undefined;
  const overFetchLimit =
    typeof fetchLimit === "number" ? fetchLimit + 1 : undefined;
  const {
    items: fetchedItems,
    loading,
    error,
  } = usePublicItems({
    limit: overFetchLimit,
    enabled: isSelfFetch,
  });

  const [loadedItems, setLoadedItems] = useState<Item[]>(
    variant === "catalog" ? props.items : [],
  );
  const [hasMore, setHasMore] = useState<boolean>(
    variant === "catalog" ? props.initialHasMore : false,
  );
  const [nextPage, setNextPage] = useState<number>(2);
  const [isFetchingMore, setIsFetchingMore] = useState<boolean>(false);
  const [isFilterDrawerOpen, setIsFilterDrawerOpen] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const latestQueryRef = useRef<string>(searchParams.toString());

  const selectedCategoryQuery = searchParams.get("category");
  const selectedSortQuery = searchParams.get("sort");
  const selectedCollectionQuery = searchParams.get("collection");
  const selectedSizeQuery = searchParams.get("size");
  const selectedColorQuery = searchParams.get("color");
  const selectedStockQuery = searchParams.get("stock");
  const selectedCollectionYearMinQuery = searchParams.get("collectionYearMin");
  const selectedCollectionYearMaxQuery = searchParams.get("collectionYearMax");
  const selectedCollectionSeasonsQuery = searchParams.get("collectionSeasons");
  const selectedPriceMinQuery = searchParams.get("priceMin");
  const selectedPriceMaxQuery = searchParams.get("priceMax");

  const selectedCategories = useMemo(
    () => parseCategories(selectedCategoryQuery),
    [selectedCategoryQuery],
  );
  const selectedSort = useMemo(
    () => parseSort(selectedSortQuery),
    [selectedSortQuery],
  );
  const selectedCollection = selectedCollectionQuery ?? "";
  const selectedSizes = useMemo(
    () => parseSizes(selectedSizeQuery),
    [selectedSizeQuery],
  );
  const selectedColors = useMemo(
    () => parseColors(selectedColorQuery),
    [selectedColorQuery],
  );
  const selectedStock = useMemo(
    () => parseStockList(selectedStockQuery),
    [selectedStockQuery],
  );
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
  const selectedPriceMin = useMemo(
    () => parseIntQuery(selectedPriceMinQuery),
    [selectedPriceMinQuery],
  );
  const selectedPriceMax = useMemo(
    () => parseIntQuery(selectedPriceMaxQuery),
    [selectedPriceMaxQuery],
  );

  const [draftCollection, setDraftCollection] = useState(selectedCollection);
  const [draftCategories, setDraftCategories] =
    useState<ItemCategory[]>(selectedCategories);
  const [draftSizes, setDraftSizes] = useState<string[]>(selectedSizes);
  const [draftColors, setDraftColors] = useState<string[]>(selectedColors);
  const [draftStock, setDraftStock] = useState<StockValue[]>(selectedStock);
  const [draftCollectionYearMin, setDraftCollectionYearMin] = useState<
    number | ""
  >(selectedCollectionYearMin);
  const [draftCollectionYearMax, setDraftCollectionYearMax] = useState<
    number | ""
  >(selectedCollectionYearMax);
  const [draftCollectionSeasons, setDraftCollectionSeasons] = useState<
    CollectionSeason[]
  >(selectedCollectionSeasons);
  const [draftPriceRange, setDraftPriceRange] = useState<[number, number]>([
    0, 100,
  ]);

  useEffect(() => {
    if (variant !== "catalog") {
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

  const updateQuery = useCallback(
    (mutator: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(latestQueryRef.current);
      mutator(params);
      const query = params.toString();
      // 変化がなければ何もしない（自動適用デバウンスの空振り・ループを防ぐ）。
      if (query === latestQueryRef.current) {
        return;
      }
      latestQueryRef.current = query;
      const nextUrl = query.length > 0 ? `${pathname}?${query}` : pathname;
      router.push(nextUrl, { scroll: false });
    },
    [pathname, router],
  );

  // URL（searchParams）が変わるたびに latestQueryRef を同期し、
  // pushQuery 経由の更新後も updateQuery の楽観的連結が整合するようにする。
  useEffect(() => {
    latestQueryRef.current = searchParams.toString();
  }, [searchParams]);

  const sourceItems = useMemo(() => {
    if (variant === "home") {
      return props.items ?? fetchedItems;
    }
    return loadedItems;
  }, [variant, props, fetchedItems, loadedItems]);

  const hasMoreHomeItems =
    variant === "home" &&
    typeof fetchLimit === "number" &&
    sourceItems.length > fetchLimit;
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
      .filter(
        (year): year is number =>
          typeof year === "number" && Number.isFinite(year),
      );

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

    if (selectedCollectionYearMin === "") {
      setDraftCollectionYearMin(collectionYearBounds.min);
    }
    if (selectedCollectionYearMax === "") {
      setDraftCollectionYearMax(collectionYearBounds.max);
    }
  }, [
    isFilterDrawerOpen,
    selectedCollectionYearMin,
    selectedCollectionYearMax,
    collectionYearBounds.min,
    collectionYearBounds.max,
  ]);

  // 価格スライダーの上下限は「これまでに読み込んだ全商品の最大レンジ」を保持する。
  // 価格フィルタ適用後はサーバーが範囲内の商品だけを返すため、resolvedItems から
  // 都度算出すると上限が適用値まで縮み、最大価格まで再スライドできなくなる。
  // これを防ぐため、既知のレンジを広げる方向にのみ更新する。
  const priceBoundsRef = useRef<{ min: number; max: number } | null>(null);
  const priceBounds = useMemo(() => {
    const prices = resolvedItems
      .map((item) => item.price)
      .filter((price) => Number.isFinite(price));

    if (prices.length === 0) {
      return priceBoundsRef.current ?? { min: 0, max: 100000 };
    }

    const computed = { min: Math.min(...prices), max: Math.max(...prices) };
    const prev = priceBoundsRef.current;
    const next = prev
      ? {
          min: Math.min(prev.min, computed.min),
          max: Math.max(prev.max, computed.max),
        }
      : computed;
    priceBoundsRef.current = next;
    return next;
  }, [resolvedItems]);

  useEffect(() => {
    const min = selectedPriceMin === "" ? priceBounds.min : selectedPriceMin;
    const max = selectedPriceMax === "" ? priceBounds.max : selectedPriceMax;
    setDraftPriceRange([Math.min(min, max), Math.max(min, max)]);
  }, [
    priceBounds.min,
    priceBounds.max,
    selectedPriceMin,
    selectedPriceMax,
    isFilterDrawerOpen,
  ]);

  const displayItems = useMemo(() => {
    if (variant === "home") {
      return resolvedItems;
    }

    return resolvedItems.filter((item) => {
      const categoryOk =
        selectedCategories.length === 0 ||
        selectedCategories.includes(
          item.category.toUpperCase() as ItemCategory,
        );

      const collection = extractCollection(item);
      const collectionOk =
        !selectedCollection ||
        (collection &&
          collection.toLowerCase() === selectedCollection.toLowerCase());

      const sizeOk =
        selectedSizes.length === 0 ||
        (Array.isArray(item.sizes) &&
          selectedSizes.some((s) => item.sizes!.includes(s)));

      const colorOk =
        selectedColors.length === 0 ||
        selectedColors.some((c) =>
          extractColors(item).map(normalizeColor).includes(normalizeColor(c)),
        );

      const collectionMeta = parseItemCollectionMeta(item);
      const collectionYearMinOk =
        selectedCollectionYearMin === "" ||
        (typeof collectionMeta.year === "number" &&
          collectionMeta.year >= selectedCollectionYearMin);
      const collectionYearMaxOk =
        selectedCollectionYearMax === "" ||
        (typeof collectionMeta.year === "number" &&
          collectionMeta.year <= selectedCollectionYearMax);
      // 空配列 or 両方選択（AW+SS）は絞り込みなし。
      const collectionSeasonOk =
        selectedCollectionSeasons.length === 0 ||
        selectedCollectionSeasons.length === 2 ||
        (item.season != null &&
          selectedCollectionSeasons.includes(item.season));

      const priceMinOk =
        selectedPriceMin === "" || item.price >= selectedPriceMin;
      const priceMaxOk =
        selectedPriceMax === "" || item.price <= selectedPriceMax;

      // 空配列 or 両方選択（in+out）は絞り込みなし。
      const stockOk =
        selectedStock.length === 0 ||
        selectedStock.length === 2 ||
        (selectedStock.includes("in") ? isItemInStock(item) : !isItemInStock(item));

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
        params.set("collection", draftCollection);
      } else {
        params.delete("collection");
      }

      if (draftCategories.length > 0) {
        params.set("category", draftCategories.join(","));
      } else {
        params.delete("category");
      }

      if (draftSizes.length > 0) {
        params.set("size", draftSizes.join(","));
      } else {
        params.delete("size");
      }

      if (draftColors.length > 0) {
        params.set("color", draftColors.join(","));
      } else {
        params.delete("color");
      }

      if (draftStock.length > 0) {
        params.set("stock", draftStock.join(","));
      } else {
        params.delete("stock");
      }

      if (draftCollectionYearMin !== "") {
        if (draftCollectionYearMin !== collectionYearBounds.min) {
          params.set("collectionYearMin", String(draftCollectionYearMin));
        } else {
          params.delete("collectionYearMin");
        }
      } else {
        params.delete("collectionYearMin");
      }

      if (draftCollectionYearMax !== "") {
        if (draftCollectionYearMax !== collectionYearBounds.max) {
          params.set("collectionYearMax", String(draftCollectionYearMax));
        } else {
          params.delete("collectionYearMax");
        }
      } else {
        params.delete("collectionYearMax");
      }

      if (draftCollectionSeasons.length > 0) {
        params.set("collectionSeasons", draftCollectionSeasons.join(","));
      } else {
        params.delete("collectionSeasons");
      }

      const draftPriceMin = Math.min(draftPriceRange[0], draftPriceRange[1]);
      const draftPriceMax = Math.max(draftPriceRange[0], draftPriceRange[1]);

      if (draftPriceMin !== priceBounds.min) {
        params.set("priceMin", String(draftPriceMin));
      } else {
        params.delete("priceMin");
      }

      if (draftPriceMax !== priceBounds.max) {
        params.set("priceMax", String(draftPriceMax));
      } else {
        params.delete("priceMax");
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

  // デスクトップのサイドバー（ドラフト即時反映）では、フィルタ操作が
  // FILTER_APPLY_DEBOUNCE_MS の間止まったら自動でドラフトを適用する。
  // applyDraftFilters はドラフト値に依存する useCallback なので、操作のたびに
  // タイマーがリセットされ、最後の操作からの待機後に1回だけ適用される。
  // モバイル・タブレットは Drawer を開いて操作するため、開いている間は
  // 時間経過で適用せず、Drawer を閉じたとき（closeDrawerAndApplyFilters）に適用する。
  useEffect(() => {
    if (variant !== "catalog" || isFilterDrawerOpen) {
      return;
    }
    const timer = setTimeout(applyDraftFilters, FILTER_APPLY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [variant, isFilterDrawerOpen, applyDraftFilters]);

  const resetDraftFilters = useCallback(() => {
    setDraftCollection("");
    setDraftCategories([]);
    setDraftSizes([]);
    setDraftColors([]);
    setDraftStock([]);
    setDraftCollectionYearMin("");
    setDraftCollectionYearMax("");
    setDraftCollectionSeasons([]);
    setDraftPriceRange([priceBounds.min, priceBounds.max]);
  }, [priceBounds.max, priceBounds.min]);

  const mobileFilterStickyStyle = {
    top: "var(--site-header-height)",
    transform:
      "translateY(calc(var(--site-header-offset) - var(--site-header-height)))",
  } as const;

  // デスクトップのフィルターは常にヘッダー高さ分だけ下げた位置に固定する。
  // --site-header-offset（ヘッダー自動非表示でスクロール中に 0 へ変化）に追従させると
  // 右側のITEMをスクロールしたときにフィルターが上下に動いてしまうため、
  // 定数の --site-header-height に固定して動かさない。
  const desktopFilterStickyStyle = {
    top: "var(--site-header-height)",
  } as const;

  const renderSortSelect = (className: string) => (
    <div className={className}>
      <SingleSelect
        variant="dropdown"
        options={SORT_OPTIONS.map((option) => ({
          value: option.value,
          label: option.label,
        }))}
        value={selectedSort}
        onValueChange={(nextSort) => {
          updateQuery((params) => {
            params.set("sort", nextSort);
          });
        }}
        size="3xs"
        bordered={false}
        className="tracking-[0.06em]"
      />
    </div>
  );

  useEffect(() => {
    if (variant !== "catalog") {
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
          params.set("page", String(nextPage));
          params.set("pageSize", String(props.pageSize));

          const response = await fetch(`/api/items?${params.toString()}`, {
            cache: "no-store",
          });
          if (!response.ok) {
            throw new Error("Failed to fetch next items page");
          }

          const payload = (await response.json()) as ItemsApiPayload;
          setLoadedItems((prev) => {
            const existingKeys = new Set(prev.map(itemKey));
            const deduped = payload.items.filter(
              (item) => !existingKeys.has(itemKey(item)),
            );
            return [...prev, ...deduped];
          });
          setHasMore(payload.hasMore);
          setNextPage((prev) => prev + 1);
        } catch (fetchError) {
          console.error("Failed to fetch next items page:", fetchError);
        } finally {
          setIsFetchingMore(false);
        }
      },
      {
        rootMargin: "300px 0px 300px 0px",
        threshold: 0,
      },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [variant, hasMore, isFetchingMore, nextPage, props, searchParams]);

  const resolvedMobileLimit = variant === "home" ? 6 : undefined;
  const shouldLimitOnMobile = typeof resolvedMobileLimit === "number";
  const hasHiddenItemsOnTablet =
    shouldLimitOnMobile && resolvedItems.length > resolvedMobileLimit;

  const renderGrid = () => (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-[8px] sm:gap-[10px] md:gap-[13px] lg:gap-[21px]">
      {displayItems.map((item, index) => {
        const hideOnMobile =
          shouldLimitOnMobile && index >= resolvedMobileLimit!;
        const itemNameClassName = "font-brand tracking-tight";
        // I-4: 在庫切れ / カラースウォッチ / コレクション(SS/AW) を控えめに提示（catalogのみ）
        const showMeta = variant === "catalog";
        const soldOut = showMeta && !isItemInStock(item);
        const swatches = showMeta ? extractColorSwatches(item) : [];

        return (
          <Link
            key={item.id}
            href={`/item/${item.id}`}
            data-testid="item-card-link"
            className={`${hideOnMobile ? "hidden lg:block" : ""} mb-[8px] sm:mb-[10px] md:mb-[12px]`}
          >
            <div className="group cursor-pointer" data-testid="item-card">
              <div className="relative aspect-[3/4] bg-[#f5f5f5] mb-[2px] sm:mb-[6px] md:mb-[8px] overflow-hidden">
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
                  // I-8: 未スタイルの「No Image」を中央寄せのプレースホルダに
                  <div className="flex h-full w-full items-center justify-center text-[#999]">
                    <span className="tracking-widest" style={{ fontSize: "var(--lk-size-3xs)" }}>
                      NO IMAGE
                    </span>
                  </div>
                )}
                {soldOut ? (
                  <span
                    className="absolute top-0 left-0 bg-black text-white px-[8px] py-[3px] tracking-widest"
                    style={{ fontSize: "var(--lk-size-4xs)" }}
                  >
                    SOLD OUT
                  </span>
                ) : null}
              </div>
              <div>
                <div className="flex items-start justify-between gap-2">
                  <h3
                    className={itemNameClassName}
                    data-testid="item-name"
                    style={{ fontSize: "var(--lk-size-2xs)" }}
                  >
                    {item.name}
                  </h3>
                  {showMeta && item.season ? (
                    <span
                      className="flex-shrink-0 font-brand tracking-widest text-[#999]"
                      style={{ fontSize: "var(--lk-size-4xs)" }}
                    >
                      {item.season}
                    </span>
                  ) : null}
                </div>
                <p
                  data-testid="item-price"
                  className="text-black font-medium"
                  style={{ fontSize: "var(--lk-size-2xs)" }}
                >
                  ¥{item.price.toLocaleString("ja-JP")}
                </p>
                {swatches.length > 0 ? (
                  <div className="mt-[4px] flex items-center gap-[4px]" aria-label={`カラー ${swatches.length}色`}>
                    {swatches.slice(0, 4).map((swatch) => (
                      <span
                        key={swatch.name}
                        title={swatch.name}
                        className="inline-block h-[10px] w-[10px] rounded-full border border-black/15"
                        style={{ backgroundColor: swatch.hex ?? "transparent" }}
                      />
                    ))}
                    {swatches.length > 4 ? (
                      <span className="text-[#999]" style={{ fontSize: "var(--lk-size-4xs)" }}>
                        +{swatches.length - 4}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          </Link>
        );
      })}
    </div>
  );

  const renderMobileFilterBar = (interactive: boolean) => (
    <div
      data-filter-bar={interactive ? "floating" : "placeholder"}
      aria-hidden={interactive ? undefined : true}
      className={cn(
        "flex items-center justify-between border-b border-black/5 bg-white py-[13px]",
        !interactive && "pointer-events-none invisible",
      )}
    >
      <Button
        data-filter-button={interactive ? "floating" : "placeholder"}
        onClick={interactive ? () => setIsFilterDrawerOpen(true) : undefined}
        variant="text"
        size="3xs"
        className="tracking-[0.06em]"
        style={{ marginLeft: "calc(-1 * var(--pad-x) - 1px)" }}
        aria-haspopup={interactive ? "dialog" : undefined}
        aria-expanded={interactive ? isFilterDrawerOpen : undefined}
        tabIndex={interactive ? undefined : -1}
      >
        FILTER
      </Button>

      {interactive
        ? renderSortSelect("relative -mt-[3px] w-[9.75rem] sm:w-[10.5rem]")
        : null}
    </div>
  );

  const renderFilterSections = (menuSize: ComponentSize = "xs") => {
    const filterSectionKeys: DrawerSectionKey[] = [
      "category",
      "stock",
      "season",
      "price",
    ];
    if (availableColorSwatches.length > 0) {
      filterSectionKeys.splice(1, 0, "color");
    }
    if (availableSizes.length > 0) {
      filterSectionKeys.splice(filterSectionKeys.indexOf("season"), 0, "size");
    }
    const categoryOptions = [
      { value: "ALL", label: "ALL" },
      ...ITEM_CATEGORIES.filter((category) => category !== "ALL").map(
        (category) => ({ value: category, label: category }),
      ),
    ];
    const stockOptions = [
      { value: "ALL", label: "ALL" },
      { value: "in", label: "IN STOCK" },
      { value: "out", label: "OUT OF STOCK" },
    ];
    const sizeOptions = [
      { value: "ALL", label: "ALL" },
      ...availableSizes.map((size) => ({ value: size, label: size })),
    ];
    const seasonOptions = [
      { value: "ALL", label: "ALL" },
      ...(["AW", "SS"] as const).map((season) => ({
        value: season,
        label: season,
      })),
    ];
    const colorOptions = [
      { value: "ALL", label: "ALL" },
      ...availableColorSwatches.map((swatch) => ({
        value: swatch.name,
        label: swatch.name,
      })),
    ];
    const colorSwatchHexByName = new Map(
      availableColorSwatches.map((swatch) => [swatch.name, swatch.hex]),
    );

    const normalizeAllSelection = (
      values: string[],
      currentValues: string[],
    ) => {
      const nextWithoutAll = values.filter((value) => value !== "ALL");
      if (values.length === 0) {
        return [];
      }
      if (values.includes("ALL")) {
        return currentValues.length === 0 ? nextWithoutAll : [];
      }
      return nextWithoutAll;
    };

    const categoryValues =
      draftCategories.length === 0 ? ["ALL"] : draftCategories;
    const stockValues = draftStock.length === 0 ? ["ALL"] : draftStock;
    const sizeValues = draftSizes.length === 0 ? ["ALL"] : draftSizes;
    const seasonValues =
      draftCollectionSeasons.length === 0 ? ["ALL"] : draftCollectionSeasons;
    const colorValues = draftColors.length === 0 ? ["ALL"] : draftColors;

    return (
      <div className={cn("space-y-5", FILTER_SECTIONS_SPACING_CLASS)}>
        <Accordion
          items={[
            {
              key: "category",
              title: "CATEGORY",
              content: (
                <div className="space-y-3">
                  <MultiSelect
                    options={categoryOptions}
                    values={categoryValues}
                    onChange={(values) => {
                      const nextValues = normalizeAllSelection(
                        values,
                        draftCategories,
                      );
                      setDraftCategories(
                        nextValues.filter(
                          (value): value is ItemCategory => value !== "ALL",
                        ),
                      );
                    }}
                    variant="panel"
                    size={menuSize}
                    checkStyle="fill"
                    shape="square"
                    expandLabelHitArea={false}
                    className="space-y-2"
                  />
                </div>
              ),
            },
            ...(availableColorSwatches.length > 0
              ? [
                  {
                    key: "color",
                    title: "COLOR",
                    content: (
                      <div className="space-y-3">
                        <MultiSelect
                          options={colorOptions}
                          values={colorValues}
                          onChange={(values) => {
                            const nextValues = normalizeAllSelection(
                              values,
                              draftColors,
                            );
                            setDraftColors(
                              nextValues.filter(
                                (value): value is string => value !== "ALL",
                              ),
                            );
                          }}
                          variant="panel"
                          size={menuSize}
                          checkStyle="fill"
                          shape="square"
                          expandLabelHitArea={false}
                          className="space-y-2"
                          renderOptionLabel={(option) =>
                            option.value === "ALL" ? (
                              <span>{option.label}</span>
                            ) : (
                              <span className="inline-flex items-center gap-2">
                                <span
                                  aria-hidden="true"
                                  className="inline-block h-3 w-3 rounded-full border border-black/20"
                                  style={{
                                    backgroundColor:
                                      colorSwatchHexByName.get(option.value) ??
                                      "#ffffff",
                                  }}
                                />
                                <span>{option.label}</span>
                              </span>
                            )
                          }
                        />
                      </div>
                    ),
                  },
                ]
              : []),
            {
              key: "stock",
              title: "STOCK",
              content: (
                <div className="space-y-3">
                  <MultiSelect
                    options={stockOptions}
                    values={stockValues}
                    onChange={(values) => {
                      const nextValues = normalizeAllSelection(
                        values,
                        draftStock,
                      );
                      setDraftStock(
                        nextValues.filter(
                          (value): value is StockValue =>
                            value === "in" || value === "out",
                        ),
                      );
                    }}
                    variant="panel"
                    size={menuSize}
                    checkStyle="fill"
                    shape="square"
                    expandLabelHitArea={false}
                    className="space-y-2"
                  />
                </div>
              ),
            },
            ...(availableSizes.length > 0
              ? [
                  {
                    key: "size",
                    title: "SIZE",
                    content: (
                      <div className="space-y-3">
                        <MultiSelect
                          options={sizeOptions}
                          values={sizeValues}
                          onChange={(values) => {
                            const nextValues = normalizeAllSelection(
                              values,
                              draftSizes,
                            );
                            setDraftSizes(
                              nextValues.filter(
                                (value): value is string => value !== "ALL",
                              ),
                            );
                          }}
                          variant="panel"
                          size={menuSize}
                          checkStyle="fill"
                          shape="square"
                          expandLabelHitArea={false}
                          className="space-y-2"
                        />
                      </div>
                    ),
                  },
                ]
              : []),
            {
              key: "season",
              title: "SEASON",
              content: (
                <div className="space-y-3">
                  <MultiSelect
                    options={seasonOptions}
                    values={seasonValues}
                    onChange={(values) => {
                      const nextValues = normalizeAllSelection(
                        values,
                        draftCollectionSeasons,
                      );
                      setDraftCollectionSeasons(
                        nextValues.filter(
                          (value): value is CollectionSeason =>
                            value === "AW" || value === "SS",
                        ),
                      );
                    }}
                    variant="panel"
                    size={menuSize}
                    checkStyle="fill"
                    shape="square"
                    expandLabelHitArea={false}
                    className="space-y-2"
                  />
                </div>
              ),
            },
            {
              key: "price",
              title: "PRICE",
              content: (
                <div className="space-y-3">
                  <Slider
                    mode="range"
                    rangeValue={draftPriceRange}
                    min={priceBounds.min}
                    max={priceBounds.max}
                    step={1000}
                    onRangeChange={setDraftPriceRange}
                    valueDisplay={`¥${Math.min(draftPriceRange[0], draftPriceRange[1]).toLocaleString("ja-JP")} - ¥${Math.max(draftPriceRange[0], draftPriceRange[1]).toLocaleString("ja-JP")}`}
                  />
                </div>
              ),
            },
          ]}
          openMode="multiple"
          defaultOpenKeys={filterSectionKeys}
          highlightOnHover={false}
          size={menuSize}
          className="!max-w-none !overflow-visible !border-0"
        />
      </div>
    );
  };

  const renderFilterActions = (size: ComponentSize = "xs") => (
    <Button
      type="button"
      variant="secondary"
      size={size}
      onClick={resetDraftFilters}
      className="w-full tracking-[0.18em]"
    >
      RESET
    </Button>
  );

  // I-2: 全フィルタ解除（sort は維持）
  // searchParams（フック値）ベースでURL更新。latestQueryRef を参照しないため
  // チップ生成（render中）の closure が ref を捕捉しない（react-hooks/refs 回避）。
  // latestQueryRef は下の useEffect で searchParams から同期する。
  const pushQuery = (mutate: (params: URLSearchParams) => void) => {
    const params = new URLSearchParams(searchParams.toString());
    mutate(params);
    const query = params.toString();
    router.push(query.length > 0 ? `${pathname}?${query}` : pathname, {
      scroll: false,
    });
  };

  const clearAllFilters = () =>
    pushQuery((params) => {
      [
        "category",
        "collection",
        "size",
        "color",
        "stock",
        "collectionSeasons",
        "collectionYearMin",
        "collectionYearMax",
        "priceMin",
        "priceMax",
      ].forEach((key) => params.delete(key));
    });

  const removeListValue = (key: string, value: string) =>
    pushQuery((params) => {
      const current = (params.get(key) ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      const next = current.filter(
        (entry) => entry.toUpperCase() !== value.toUpperCase(),
      );
      if (next.length > 0) {
        params.set(key, next.join(","));
      } else {
        params.delete(key);
      }
    });

  // I-5: 適用中フィルタのチップ（×で個別解除）
  const appliedChips: { key: string; label: string; onRemove: () => void }[] = [];
  selectedCategories.forEach((c) =>
    appliedChips.push({ key: `cat-${c}`, label: c, onRemove: () => removeListValue("category", c) }),
  );
  selectedColors.forEach((c) =>
    appliedChips.push({ key: `col-${c}`, label: c, onRemove: () => removeListValue("color", c) }),
  );
  selectedSizes.forEach((s) =>
    appliedChips.push({ key: `size-${s}`, label: s, onRemove: () => removeListValue("size", s) }),
  );
  if (selectedCollection) {
    appliedChips.push({
      key: "collection",
      label: selectedCollection,
      onRemove: () => pushQuery((params) => params.delete("collection")),
    });
  }
  selectedCollectionSeasons.forEach((season) =>
    appliedChips.push({
      key: `season-${season}`,
      label: season,
      onRemove: () => removeListValue("collectionSeasons", season),
    }),
  );
  selectedStock.forEach((stock) =>
    appliedChips.push({
      key: `stock-${stock}`,
      label: stock === "in" ? "在庫あり" : "在庫切れ",
      onRemove: () => removeListValue("stock", stock),
    }),
  );
  if (selectedPriceMin !== "" || selectedPriceMax !== "") {
    const minLabel = (selectedPriceMin === "" ? priceBounds.min : selectedPriceMin).toLocaleString("ja-JP");
    const maxLabel = (selectedPriceMax === "" ? priceBounds.max : selectedPriceMax).toLocaleString("ja-JP");
    appliedChips.push({
      key: "price",
      label: `¥${minLabel}〜¥${maxLabel}`,
      onRemove: () =>
        pushQuery((params) => {
          params.delete("priceMin");
          params.delete("priceMax");
        }),
    });
  }

  // I-6: 追加読み込みのスケルトン（NEWS と統一）
  const renderSkeletonCards = (count = 4) => (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-[8px] sm:gap-[10px] md:gap-[13px] lg:gap-[21px] mt-[8px]">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="animate-pulse">
          <div className="aspect-[3/4] bg-black/8 mb-[8px]" />
          <div className="h-[10px] w-2/3 bg-black/8 mb-[6px]" />
          <div className="h-[10px] w-1/3 bg-black/5" />
        </div>
      ))}
    </div>
  );

  if (variant === "home") {
    if (isSelfFetch && error) {
      return (
        <section id="items" className="w-full pb-14 sm:pb-16 md:pb-20">
          <div className="element-width text-center py-10">
            <div className="text-xl text-red-500">{error}</div>
          </div>
        </section>
      );
    }

    return (
      <section id="items" className="section-space">
        <div className="element-width">
          <SectionTitle title="ITEMS" />

          {isSelfFetch && loading ? (
            <div className="text-center py-12 text-[#474747]">
              読み込み中...
            </div>
          ) : resolvedItems.length === 0 ? (
            <div className="text-center py-12 text-[#474747]">
              公開中のITEMがありません
            </div>
          ) : (
            <div id="sym:success">
              {renderGrid()}
              {(hasHiddenItemsOnTablet || hasMoreHomeItems) && (
                <div className="text-center mt-6 md:mt-8 lg:mt-12">
                  <Button href="/item" variant="secondary" size="xs">
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
      <div className="flex w-full">
        <aside
          className="hidden lg:flex flex-col w-[233px] xl:w-[288px] flex-shrink-0 sticky h-[calc(100vh-var(--site-header-height))] overflow-hidden"
          style={desktopFilterStickyStyle}
        >
          <div className={FILTER_SIDEBAR_SCROLL_CLASS}>
            {renderFilterSections("3xs")}
          </div>
          <div className={FILTER_SIDEBAR_ACTIONS_CLASS}>
            {renderFilterActions("xs")}
          </div>
        </aside>

        <div
          data-testid="item-content-column"
          className="flex-1 min-w-0 w-full max-w-full px-0 md:px-[21px] lg:pl-[34px] lg:pr-[21px] xl:pl-[55px] xl:pr-[34px] 2xl:pl-[89px] 2xl:pr-[55px] py-0 xl:py-[21px]"
        >
          <div className="sm:-mt-1 md:-mt-2 lg:hidden">
            {renderMobileFilterBar(false)}
          </div>
          <div
            className="fixed inset-x-0 z-30 lg:hidden bg-white transition-transform duration-300 ease-in-out before:pointer-events-none before:absolute before:inset-x-0 before:-top-px before:h-px before:bg-white before:content-['']"
            style={mobileFilterStickyStyle}
          >
            <div className="element-width px-5 md:px-[41px]">
              {renderMobileFilterBar(true)}
            </div>
          </div>

          <div className="hidden lg:flex mb-2 sm:mb-4 md:mb-6 items-center justify-end">
            {renderSortSelect("relative -mt-[3px] w-[10.5rem]")}
          </div>

          {renderGrid()}

          {displayItems.length === 0 && (
            <div className="text-center py-12">
              <p
                className="tracking-widest text-[#474747] mb-4"
                style={{ fontSize: "var(--lk-size-xs)" }}
              >
                商品が見つかりません
              </p>
              {appliedChips.length > 0 ? (
                <Button type="button" variant="secondary" size="xs" onClick={clearAllFilters}>
                  条件をリセット
                </Button>
              ) : null}
            </div>
          )}

          <div
            ref={sentinelRef}
            data-testid="item-infinite-sentinel"
            className="h-8"
          />
          {/* I-6: 追加読み込みはスケルトンに統一 */}
          {isFetchingMore && renderSkeletonCards()}
        </div>
      </div>

      <Drawer
        open={isFilterDrawerOpen}
        onClose={closeDrawerAndApplyFilters}
        side="left"
        size="md"
        className={FILTER_DRAWER_CLASS}
      >
        <div
          className="flex flex-col h-full"
          style={{
            paddingInline: "calc(var(--lk-size-sm) * var(--phi))",
            paddingTop: "calc(var(--lk-size-sm) * var(--sqrt-phi))",
          }}
        >
          <div className="flex justify-end pb-[13px]">
            <Button
              variant="text"
              size="xs"
              onClick={() => setIsFilterDrawerOpen(false)}
              aria-label="Close filter drawer"
            >
              <i className="ri-close-line" aria-hidden="true" />
            </Button>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden pb-[13px]">
            {renderFilterSections("xs")}
          </div>

          <div className="flex-shrink-0 space-y-[8px] bg-white pt-[13px] pb-[21px]">
            {renderFilterActions("xs")}
          </div>
        </div>
      </Drawer>
    </>
  );
}
