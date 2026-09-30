import type { TabType } from "@/components/AdminTabs";

interface AdminSideNavProps {
  activeTab: TabType;
  onTabChange: (tab: TabType) => void;
  tabs: TabType[];
  /** タブごとの未処理の件数（ORDER の要対応・要確認）。0 なら出さない */
  badges?: Partial<Record<TabType, number>>;
}

// 各タブのアイコン（remixicon の細線ストローク）。
const TAB_ICONS: Record<TabType, string> = {
  KPI: "ri-bar-chart-2-line",
  ACCOUNTING: "ri-calculator-line",
  NEWS: "ri-article-line",
  ITEM: "ri-shopping-bag-line",
  LOOK: "ri-image-line",
  STOCKIST: "ri-map-pin-line",
  USER: "ri-user-line",
  ORDER: "ri-shopping-cart-line",
  CONTACT: "ri-mail-line",
};

// 左側の縦ナビ。薄いグレーの長方形パネル上にアイコン + ラベルを並べ、
// 選択中タブは濃いグレーで塗りつぶす。lg 未満は横スクロールの上部バー、lg 以上で縦積み。
// FREQ-315: 切り替え位置は公開 ITEM 一覧のフィルター（PublicItemGrid の
// hidden lg:flex ↔ lg:hidden）と同じ lg。サイト全体で「サイド↔上部」の境界を1つにする。
export default function AdminSideNav({
  activeTab,
  onTabChange,
  tabs,
  badges,
}: AdminSideNavProps) {
  return (
    <nav
      aria-label="管理メニュー"
      className="flex gap-1 overflow-x-auto bg-[#f4f4f4] p-2 lg:h-full lg:flex-col lg:overflow-visible"
    >
      {tabs.map((tab) => {
        const isActive = tab === activeTab;
        const count = badges?.[tab] ?? 0;

        return (
          <button
            key={tab}
            type="button"
            aria-current={isActive ? "page" : undefined}
            data-active={isActive ? "true" : undefined}
            onClick={() => onTabChange(tab)}
            className={[
              "flex shrink-0 items-center gap-3 border-l-0.75 px-3 py-2.5 text-left font-acumin lk-text-3xs tracking-widest transition-colors lg:w-full",
              isActive
                ? "border-black bg-[#e9e9e9] font-medium text-black"
                : "border-transparent text-[#474747] hover:bg-[#efefef] hover:text-black",
            ].join(" ")}
          >
            <i
              className={`${TAB_ICONS[tab]} lk-text-xl leading-none`}
              aria-hidden="true"
            />
            <span>{tab}</span>
            {count > 0 ? (
              <span className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-black px-1.5 font-acumin lk-text-4xs leading-5 text-white">
                <span aria-hidden="true">{count}</span>
                <span className="sr-only">{` 未処理 ${count}件`}</span>
              </span>
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}
