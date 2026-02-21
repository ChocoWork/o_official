type TabType = 'KPI' | 'NEWS' | 'ITEM' | 'LOOK' | 'USER' | 'ORDER';

import type { ReactNode } from 'react';

interface AdminTabProps {
  label: TabType;
  isActive?: boolean;
  onClick: (tab: TabType) => void;
}

function AdminTab({ label, isActive = false, onClick }: AdminTabProps) {
  const baseClasses = "px-6 py-3 text-sm tracking-widest transition-all cursor-pointer whitespace-nowrap font-acumin";
  const activeClasses = isActive ? "border-b-2 border-black text-black" : "text-[#474747] hover:text-black";

  return (
    <button className={`${baseClasses} ${activeClasses}`} onClick={() => onClick(label)}>
      {label}
    </button>
  );
}

interface AdminTabsProps {
  activeTab: TabType;
  onTabChange: (tab: TabType) => void;
  rightContent?: ReactNode;
}

export default function AdminTabs({ activeTab, onTabChange, rightContent }: AdminTabsProps) {
  return (
    <div className="mb-8 border-b border-[#d5d0c9]">
      <div className="flex items-center justify-between gap-4">
        <div className="flex space-x-2 overflow-x-auto">
          <AdminTab label="KPI" isActive={activeTab === 'KPI'} onClick={onTabChange} />
          <AdminTab label="NEWS" isActive={activeTab === 'NEWS'} onClick={onTabChange} />
          <AdminTab label="ITEM" isActive={activeTab === 'ITEM'} onClick={onTabChange} />
          <AdminTab label="LOOK" isActive={activeTab === 'LOOK'} onClick={onTabChange} />
          <AdminTab label="USER" isActive={activeTab === 'USER'} onClick={onTabChange} />
          <AdminTab label="ORDER" isActive={activeTab === 'ORDER'} onClick={onTabChange} />
        </div>
        {rightContent && <div className="shrink-0 pb-2">{rightContent}</div>}
      </div>
    </div>
  );
}