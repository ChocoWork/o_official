export type TabType = 'KPI' | 'NEWS' | 'ITEM' | 'LOOK' | 'USER' | 'ORDER';

import type { ReactNode } from 'react';
import { TabSegmentControl } from '@/components/ui/TabSegmentControl';

interface AdminTabsProps {
  activeTab: TabType;
  onTabChange: (tab: TabType) => void;
  tabs?: TabType[];
  rightContent?: ReactNode;
}

const allTabs: TabType[] = ['KPI', 'NEWS', 'ITEM', 'LOOK', 'USER', 'ORDER'];

export default function AdminTabs({ activeTab, onTabChange, tabs = allTabs, rightContent }: AdminTabsProps) {
  return (
    <div className="mb-8 border-b border-[#d5d0c9]">
      <div className="flex items-center justify-between gap-4">
        <div className="flex space-x-2 overflow-x-auto">
          <TabSegmentControl
            variant="tabs-standard"
            items={tabs.map((tab) => ({ key: tab, label: tab }))}
            activeKey={activeTab}
            onChange={(tab) => onTabChange(tab as TabType)}
           size="md"/>
        </div>
        {rightContent && <div className="shrink-0 pb-2">{rightContent}</div>}
      </div>
    </div>
  );
}