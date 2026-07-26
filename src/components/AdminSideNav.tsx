import type { TabType } from '@/components/AdminTabs';

interface AdminSideNavProps {
  activeTab: TabType;
  onTabChange: (tab: TabType) => void;
  tabs: TabType[];
}

// 各タブのアイコン（remixicon の細線ストローク）。
const TAB_ICONS: Record<TabType, string> = {
  KPI: 'ri-bar-chart-2-line',
  ACCOUNTING: 'ri-calculator-line',
  NEWS: 'ri-article-line',
  ITEM: 'ri-shopping-bag-line',
  LOOK: 'ri-image-line',
  STOCKIST: 'ri-map-pin-line',
  USER: 'ri-user-line',
  ORDER: 'ri-shopping-cart-line',
  CONTACT: 'ri-mail-line',
};

// 左側の縦ナビ。薄いグレーの長方形パネル上にアイコン + ラベルを並べ、
// 選択中タブは濃いグレーで塗りつぶす。mobile は横スクロール、md 以上で縦積み。
export default function AdminSideNav({ activeTab, onTabChange, tabs }: AdminSideNavProps) {
  return (
    <nav
      aria-label="管理メニュー"
      className="flex gap-1 overflow-x-auto bg-[#f4f4f4] p-2 md:h-full md:flex-col md:overflow-visible"
    >
      {tabs.map((tab) => {
        const isActive = tab === activeTab;

        return (
          <button
            key={tab}
            type="button"
            aria-current={isActive ? 'page' : undefined}
            data-active={isActive ? 'true' : undefined}
            onClick={() => onTabChange(tab)}
            className={[
              'flex shrink-0 items-center gap-3 border-l-[3px] px-3 py-2.5 text-left font-acumin text-xs tracking-widest transition-colors md:w-full',
              isActive
                ? 'border-black bg-[#e9e9e9] font-medium text-black'
                : 'border-transparent text-[#474747] hover:bg-[#efefef] hover:text-black',
            ].join(' ')}
          >
            <i className={`${TAB_ICONS[tab]} text-[17px] leading-none`} aria-hidden="true" />
            <span>{tab}</span>
          </button>
        );
      })}
    </nav>
  );
}
