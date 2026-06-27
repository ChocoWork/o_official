'use client';

import { useCallback, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/Button/Button';
import { Card } from '@/components/ui/Card/Card';
import { Checkbox } from '@/components/ui/Checkbox/Checkbox';
import { Drawer } from '@/components/ui/Drawer/Drawer';
import { SectionTitle } from '@/components/ui/SectionTitle/SectionTitle';
import type { ComponentSize } from '@/components/ui/types';
import { PublicStockist } from '@/features/stockist/types';
import {
  getPrefectureFromAddress,
  getPrefectureShortLabel,
  STOCKIST_REGIONS,
} from '@/features/stockist/region';
import { cn } from '@/lib/utils';

type PublicStockistGridHomeProps = {
  variant: 'home';
  stockists: PublicStockist[];
  className?: string;
};

type PublicStockistGridCatalogProps = {
  variant: 'catalog';
  stockists: PublicStockist[];
};

type PublicStockistGridProps = PublicStockistGridHomeProps | PublicStockistGridCatalogProps;

export function PublicStockistGrid(props: PublicStockistGridProps) {
  if (props.variant === 'catalog') {
    return <CatalogGrid stockists={props.stockists} />;
  }
  return <HomeGrid stockists={props.stockists} className={props.className} />;
}

// 縦型カード: 店舗名 / 区切り線 / 詳細行。home・catalog の両方で共用する。
function StockistCard({
  shop,
  className,
}: {
  shop: PublicStockist;
  className?: string;
}) {
  return (
    <Card className={`stockist-card${className ? ` ${className}` : ''}`} hoverable size="sm">
      {/* Identity section */}
      <div className="stockist-card-identity">
        <h3 className="stockist-card-title">{shop.name}</h3>
      </div>
      {/* Divider */}
      <div className="stockist-card-divider" />
      {/* Detail rows */}
      <div className="stockist-card-details">
        <div className="stockist-card-row">
          <i className="ri-map-pin-line stockist-card-icon stockist-card-icon--pin" aria-hidden="true" />
          <a
            href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(shop.address)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="stockist-card-text underline-offset-4 hover:text-black hover:underline transition-colors"
          >
            {shop.address}
          </a>
        </div>
        {shop.phone ? (
          <div className="stockist-card-row stockist-card-row--compact hidden sm:flex">
            <i className="ri-phone-line stockist-card-icon" aria-hidden="true" />
            <a
              href={`tel:${shop.phone.replace(/[^\d+]/g, '')}`}
              className="stockist-card-text hover:text-black transition-colors"
            >
              {shop.phone}
            </a>
          </div>
        ) : null}
        <div className="stockist-card-row stockist-card-row--compact hidden sm:flex">
          <i className="ri-time-line stockist-card-icon" aria-hidden="true" />
          <p className="stockist-card-text">{shop.time}</p>
        </div>
        <div className="stockist-card-row stockist-card-row--compact hidden sm:flex">
          <i className="ri-calendar-line stockist-card-icon" aria-hidden="true" />
          <p className="stockist-card-text">{shop.holiday}</p>
        </div>
      </div>
    </Card>
  );
}

function HomeGrid({
  stockists,
  className,
}: {
  stockists: PublicStockist[];
  className?: string;
}) {
  // Home variant: hide items beyond index 3 on mobile, show all on tablet (md+)
  const mobileLimit = 3;
  // S-7: 件数に応じてカラム数を可変（少数は中央寄せ・列数を抑え余白過多を防ぐ）
  const count = stockists.length;
  const colsClass =
    count <= 1
      ? 'grid grid-cols-1 max-w-sm mx-auto'
      : count === 2
        ? 'grid grid-cols-1 sm:grid-cols-2 max-w-3xl mx-auto'
        : 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3';

  const renderGrid = () => {
    // S-5: 空状態（取扱店舗ゼロ件）に次アクションを提示
    if (count === 0) {
      return (
        <div className="text-center py-[42px] sm:py-[55px]">
          <p className="text-[#474747] mb-[16px] sm:mb-[21px]" style={{ fontSize: 'var(--lk-size-sm)' }}>
            現在、取扱店舗はございません。オンラインストアにて販売中です。
          </p>
          <Button href="/item" variant="secondary" size="md">VIEW COLLECTION</Button>
        </div>
      );
    }

    return (
      <div className={`stockist-grid-home ${colsClass}${className ? ` ${className}` : ''}`}>
        {stockists.map((shop, index) => (
          <StockistCard
            key={shop.id}
            shop={shop}
            className={index >= mobileLimit ? 'hidden md:block' : undefined}
          />
        ))}
      </div>
    );
  };

  return (
    <section id="stockist" className="section-space">
      <div className="element-width">
        <SectionTitle title="STOCKIST" />

        {renderGrid()}
      </div>
    </section>
  );
}

function parsePrefList(value: string | null): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const ALL_PREFECTURES: string[] = STOCKIST_REGIONS.flatMap((entry) => [
  ...entry.prefectures,
]);

function CatalogGrid({ stockists }: { stockists: PublicStockist[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isFilterDrawerOpen, setIsFilterDrawerOpen] = useState(false);

  // URL の pref（都道府県フルネームの csv）から有効な選択だけを取り出す。
  const selectedPrefectures = useMemo(() => {
    const requested = parsePrefList(searchParams.get('pref'));
    const valid = new Set(ALL_PREFECTURES);
    return requested.filter((pref) => valid.has(pref));
  }, [searchParams]);

  const selectedSet = useMemo(
    () => new Set(selectedPrefectures),
    [selectedPrefectures],
  );

  // 折りたたみ状態。初期表示では選択済み都道府県を含む地方だけ開く。
  const [expandedRegions, setExpandedRegions] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    for (const entry of STOCKIST_REGIONS) {
      if (
        entry.prefectures.length > 1 &&
        entry.prefectures.some((pref) => selectedSet.has(pref))
      ) {
        initial.add(entry.region);
      }
    }
    return initial;
  });

  const toggleExpand = useCallback((region: string) => {
    setExpandedRegions((prev) => {
      const next = new Set(prev);
      if (next.has(region)) {
        next.delete(region);
      } else {
        next.add(region);
      }
      return next;
    });
  }, []);

  // 各店舗の都道府県を住所から導出。
  const stockistPrefectures = useMemo(
    () =>
      stockists.map((shop) => ({
        shop,
        prefecture: getPrefectureFromAddress(shop.address),
      })),
    [stockists],
  );

  // 店舗が存在する都道府県のみを抽出。
  const availablePrefectures = useMemo(() => {
    const set = new Set<string>();
    for (const { prefecture } of stockistPrefectures) {
      if (prefecture) {
        set.add(prefecture);
      }
    }
    return set;
  }, [stockistPrefectures]);

  // 表示対象の地方（店舗が存在する都道府県のみを残し、空の地方は除外）。
  const visibleRegions = useMemo(
    () =>
      STOCKIST_REGIONS.map((entry) => ({
        region: entry.region,
        // region.ts 定義順を保ったまま、店舗が存在する都道府県だけに絞る。
        prefectures: entry.prefectures.filter((pref) => availablePrefectures.has(pref)),
        isSingle: entry.prefectures.length === 1,
      })).filter((entry) => entry.prefectures.length > 0),
    [availablePrefectures],
  );

  const setPrefectures = useCallback(
    (next: string[]) => {
      const params = new URLSearchParams(searchParams.toString());
      // フルネームの定義順を保ってクエリを安定させる。
      const ordered = ALL_PREFECTURES.filter((pref) => next.includes(pref));
      if (ordered.length > 0) {
        params.set('pref', ordered.join(','));
      } else {
        params.delete('pref');
      }
      const query = params.toString();
      router.push(query.length > 0 ? `${pathname}?${query}` : pathname, {
        scroll: false,
      });
    },
    [pathname, router, searchParams],
  );

  const togglePrefecture = useCallback(
    (prefecture: string) => {
      const next = new Set(selectedSet);
      if (next.has(prefecture)) {
        next.delete(prefecture);
      } else {
        next.add(prefecture);
      }
      setPrefectures([...next]);
    },
    [selectedSet, setPrefectures],
  );

  const toggleRegion = useCallback(
    (prefectures: readonly string[]) => {
      const fullySelected = prefectures.every((pref) => selectedSet.has(pref));
      const next = new Set(selectedSet);
      if (fullySelected) {
        prefectures.forEach((pref) => next.delete(pref));
      } else {
        prefectures.forEach((pref) => next.add(pref));
      }
      setPrefectures([...next]);
    },
    [selectedSet, setPrefectures],
  );

  const clearAll = useCallback(() => setPrefectures([]), [setPrefectures]);

  const displayStockists = useMemo(() => {
    if (selectedSet.size === 0) {
      return stockists;
    }
    return stockistPrefectures
      .filter(({ prefecture }) => prefecture !== null && selectedSet.has(prefecture))
      .map(({ shop }) => shop);
  }, [selectedSet, stockists, stockistPrefectures]);

  const renderAreaTree = (size: ComponentSize = 'xs') => (
    <div
      className="filter-sections"
      role="group"
      aria-label="エリア（地方・都道府県）で絞り込む"
    >
      <div className="flex items-center">
        <span aria-hidden="true" className="w-[20px] flex-shrink-0" />
        <Checkbox
          label="ALL"
          checked={selectedSet.size === 0}
          onChange={clearAll}
          size={size}
          shape="square"
          checkStyle="fill"
          expandLabelHitArea={false}
          className="w-full justify-start px-3 py-[3px] text-[#474747] tracking-widest font-medium"
        />
      </div>
      {visibleRegions.map((entry) => {
        // 北海道など単一都道府県の地方は親子に分けず1つのチェックボックスにする。
        if (entry.isSingle) {
          const prefecture = entry.prefectures[0];
          return (
            <div key={entry.region} className="flex items-center">
              <span aria-hidden="true" className="w-[20px] flex-shrink-0" />
              <Checkbox
                label={entry.region}
                checked={selectedSet.has(prefecture)}
                onChange={() => togglePrefecture(prefecture)}
                size={size}
                shape="square"
                checkStyle="fill"
                expandLabelHitArea={false}
                className="w-full justify-start px-3 py-[3px] text-[#474747] tracking-widest font-medium"
              />
            </div>
          );
        }

        const regionChecked = entry.prefectures.every((pref) => selectedSet.has(pref));
        const expanded = expandedRegions.has(entry.region);
        return (
          <div key={entry.region}>
            <div className="flex items-center">
              <button
                type="button"
                onClick={() => toggleExpand(entry.region)}
                aria-expanded={expanded}
                aria-label={`${entry.region}の都道府県を${expanded ? '折りたたむ' : '展開'}`}
                className="w-[20px] flex-shrink-0 flex items-center justify-center text-[#474747] hover:text-black"
              >
                <i
                  className={expanded ? 'ri-arrow-down-s-line' : 'ri-arrow-right-s-line'}
                  aria-hidden="true"
                />
              </button>
              <Checkbox
                label={entry.region}
                checked={regionChecked}
                onChange={() => toggleRegion(entry.prefectures)}
                size={size}
                shape="square"
                checkStyle="fill"
                expandLabelHitArea={false}
                className="w-full justify-start px-3 py-[3px] text-[#474747] tracking-widest font-medium"
              />
            </div>
            {expanded ? (
              <div className="pl-[40px]">
                {entry.prefectures.map((prefecture) => (
                  <Checkbox
                    key={prefecture}
                    label={getPrefectureShortLabel(prefecture)}
                    checked={selectedSet.has(prefecture)}
                    onChange={() => togglePrefecture(prefecture)}
                    size={size}
                    shape="square"
                    checkStyle="fill"
                    expandLabelHitArea={false}
                    className="w-full justify-start px-3 py-[3px] text-[#474747] tracking-widest"
                  />
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );

  const mobileFilterStickyStyle = {
    top: 'var(--site-header-height)',
    transform: 'translateY(calc(var(--site-header-offset) - var(--site-header-height)))',
  } as const;

  const desktopFilterStickyStyle = {
    top: 'var(--site-header-height)',
  } as const;

  const renderMobileFilterBar = (interactive: boolean) => (
    <div
      data-filter-bar={interactive ? 'floating' : 'placeholder'}
      aria-hidden={interactive ? undefined : true}
      className={cn(
        'flex items-center justify-between border-b border-black/5 bg-white py-[13px]',
        !interactive && 'pointer-events-none invisible',
      )}
    >
      <Button
        data-filter-button={interactive ? 'floating' : 'placeholder'}
        onClick={interactive ? () => setIsFilterDrawerOpen(true) : undefined}
        variant="text"
        size="3xs"
        className="tracking-[0.06em]"
        style={{ marginLeft: 'calc(-1 * var(--pad-x) - 1px)' }}
        aria-haspopup={interactive ? 'dialog' : undefined}
        aria-expanded={interactive ? isFilterDrawerOpen : undefined}
        tabIndex={interactive ? undefined : -1}
      >
        FILTER
      </Button>
    </div>
  );

  const renderGrid = () => {
    if (displayStockists.length === 0) {
      return (
        <div className="text-center py-[42px] sm:py-[55px]">
          <p className="text-[#474747] mb-[16px] sm:mb-[21px]" style={{ fontSize: 'var(--lk-size-sm)' }}>
            該当する取扱店舗がございません。
          </p>
          <Button type="button" variant="secondary" size="md" onClick={clearAll}>
            すべて見る
          </Button>
        </div>
      );
    }

    return (
      <div className="stockist-grid-catalog grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
        {displayStockists.map((shop) => (
          <StockistCard key={shop.id} shop={shop} />
        ))}
      </div>
    );
  };

  return (
    <>
      <div className="flex w-full">
        <aside
          className="hidden lg:flex flex-col w-[233px] xl:w-[288px] flex-shrink-0 sticky h-[calc(100vh-var(--site-header-height))] overflow-hidden"
          style={desktopFilterStickyStyle}
        >
          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden border-r border-black/5 px-[13px] xl:px-[21px] pt-[8px] xl:pt-[21px] pb-4">
            {renderAreaTree('3xs')}
          </div>
        </aside>

        <div className="flex-1 min-w-0 w-full max-w-full px-0 md:px-[21px] lg:pl-[34px] lg:pr-[21px] xl:pl-[55px] xl:pr-[34px] py-0 xl:py-[21px]">
          <div className="sm:-mt-1 md:-mt-2 lg:hidden">{renderMobileFilterBar(false)}</div>
          <div
            className="fixed inset-x-0 z-30 lg:hidden bg-white transition-transform duration-300 ease-in-out before:pointer-events-none before:absolute before:inset-x-0 before:-top-px before:h-px before:bg-white before:content-['']"
            style={mobileFilterStickyStyle}
          >
            <div className="element-width px-5 md:px-[41px]">{renderMobileFilterBar(true)}</div>
          </div>

          {renderGrid()}
        </div>
      </div>

      <Drawer
        open={isFilterDrawerOpen}
        onClose={() => setIsFilterDrawerOpen(false)}
        side="left"
        size="md"
        className="[scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
      >
        <div
          className="flex flex-col h-full"
          style={{
            paddingInline: 'calc(var(--lk-size-sm) * var(--phi))',
            paddingTop: 'calc(var(--lk-size-sm) * var(--sqrt-phi))',
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
            {renderAreaTree('xs')}
          </div>
        </div>
      </Drawer>
    </>
  );
}
