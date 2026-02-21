// ----------------- 管理ダッシュボード -----------------
'use client';

import { useState } from 'react';
import AdminTabs from '@/app/components/AdminTabs';
import KpiSection from '@/app/components/KpiSection';
import NewsSection from '@/app/components/NewsSection';
import ItemSection from '@/app/components/ItemSection';
import LookSection from '@/app/components/LookSection';
import UserSection from '@/app/components/UserSection';
import OrderSection from '@/app/components/OrderSection';

type TabType = 'KPI' | 'NEWS' | 'ITEM' | 'LOOK' | 'USER' | 'ORDER';

export default function AdminPage() {
  const [activeTab, setActiveTab] = useState<TabType>('KPI');

  const renderContent = () => {
    switch (activeTab) {
      case 'KPI':
        return <KpiSection />;
      case 'NEWS':
        return <NewsSection />;
      case 'ITEM':
        return <ItemSection />;
      case 'LOOK':
        return <LookSection />;
      case 'USER':
        return <UserSection />;
      case 'ORDER':
        return <OrderSection />;
      default:
        return <KpiSection />;
    }
  };

  return (
    <main className="pt-32 pb-20 px-6 lg:px-12">
      <div className="max-w-7xl mx-auto">
        <AdminTabs activeTab={activeTab} onTabChange={setActiveTab} />
        {renderContent()}
      </div>
    </main>
  );
}
