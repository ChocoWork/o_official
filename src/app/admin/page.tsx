// ----------------- 管理ダッシュボード -----------------
'use client';

import { useMemo, useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import AdminTabs, { type TabType } from '@/app/components/AdminTabs';
import { useLogin } from '@/app/components/LoginContext';
import KpiSection from '@/app/components/KpiSection';
import NewsSection from '@/app/components/NewsSection';
import ItemSection from '@/app/components/ItemSection';
import LookSection from '@/app/components/LookSection';
import UserSection from '@/app/components/UserSection';
import OrderSection, { type OrderItem, type OrderStatus } from '@/app/components/OrderSection';
import { LinkButton } from '@/app/components/ui/LinkButton';

const allAdminTabs: TabType[] = ['KPI', 'NEWS', 'ITEM', 'LOOK', 'USER', 'ORDER'];
const supporterTabs: TabType[] = ['ORDER'];

const statusTransitionMap: Partial<Record<OrderStatus, OrderStatus>> = {
  未出荷: '準備中',
  準備中: '出荷完了',
  出荷完了: '配達完了',
};

const initialOrders: OrderItem[] = [
  {
    id: 'ORD-2025-0156',
    customerName: '中村 優子',
    customerEmail: 'nakamura@example.com',
    orderDate: '2025-01-15',
    itemCount: '3点',
    totalAmount: '¥78,000',
    status: '未出荷',
  },
  {
    id: 'ORD-2025-0155',
    customerName: '小林 大輔',
    customerEmail: 'kobayashi@example.com',
    orderDate: '2025-01-15',
    itemCount: '2点',
    totalAmount: '¥45,000',
    status: '準備中',
  },
  {
    id: 'ORD-2025-0154',
    customerName: '加藤 真理',
    customerEmail: 'kato@example.com',
    orderDate: '2025-01-14',
    itemCount: '4点',
    totalAmount: '¥128,000',
    status: '出荷完了',
  },
  {
    id: 'ORD-2025-0153',
    customerName: '吉田 翔太',
    customerEmail: 'yoshida@example.com',
    orderDate: '2025-01-14',
    itemCount: '1点',
    totalAmount: '¥35,000',
    status: '配達完了',
  },
  {
    id: 'ORD-2025-0152',
    customerName: '渡辺 美穂',
    customerEmail: 'watanabe@example.com',
    orderDate: '2025-01-13',
    itemCount: '3点',
    totalAmount: '¥92,000',
    status: '配達完了',
  },
  {
    id: 'ORD-2025-0151',
    customerName: '松本 健一',
    customerEmail: 'matsumoto@example.com',
    orderDate: '2025-01-12',
    itemCount: '2点',
    totalAmount: '¥56,000',
    status: 'キャンセル',
  },
];

export default function AdminPage() {
  const { isLoggedIn, isAuthResolved, userRole } = useLogin();
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState<TabType>('KPI');
  const [orders, setOrders] = useState<OrderItem[]>(initialOrders);

  const visibleTabs = useMemo<TabType[]>(() => {
    if (userRole === 'admin') {
      return allAdminTabs;
    }

    if (userRole === 'supporter') {
      return supporterTabs;
    }

    return [];
  }, [userRole]);

  const canAccessAdmin = visibleTabs.length > 0;

  useEffect(() => {
    if (!canAccessAdmin) {
      return;
    }

    const tab = searchParams.get('tab');
    if (tab && visibleTabs.includes(tab as TabType)) {
      setActiveTab(tab as TabType);
      return;
    }

    setActiveTab(visibleTabs[0]);
  }, [searchParams, visibleTabs, canAccessAdmin]);

  useEffect(() => {
    if (!canAccessAdmin) {
      return;
    }

    if (!visibleTabs.includes(activeTab)) {
      setActiveTab(visibleTabs[0]);
    }
  }, [activeTab, visibleTabs, canAccessAdmin]);

  const pendingShipmentCount = useMemo(
    () => orders.filter((order) => order.status === '未出荷').length,
    [orders],
  );

  const preparingShipmentCount = useMemo(
    () => orders.filter((order) => order.status === '準備中').length,
    [orders],
  );

  const handleTransitStatus = (id: string) => {
    setOrders((prevOrders) =>
      prevOrders.map((order) => {
        if (order.id !== id) return order;

        const nextStatus = statusTransitionMap[order.status];
        if (!nextStatus) return order;

        return {
          ...order,
          status: nextStatus,
        };
      }),
    );
  };

  const tabRightContent = (() => {
    switch (activeTab) {
      case 'NEWS':
        if (userRole !== 'admin') return null;
        return (
          <LinkButton href="/admin/news/create" variant="primary" size="md" className="font-acumin">
            新規作成
          </LinkButton>
        );
      case 'ITEM':
        if (userRole !== 'admin') return null;
        return (
          <LinkButton href="/admin/item/create" variant="primary" size="md" className="font-acumin">
            新規作成
          </LinkButton>
        );
      case 'LOOK':
        if (userRole !== 'admin') return null;
        return (
          <LinkButton href="/admin/look/create" variant="primary" size="md" className="font-acumin">
            新規作成
          </LinkButton>
        );
      case 'ORDER':
        return (
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 text-sm font-acumin">
              <span className="w-3 h-3 bg-red-100 rounded-full" />
              <span className="text-[#474747]">未出荷: {pendingShipmentCount}</span>
            </div>
            <div className="flex items-center gap-2 text-sm font-acumin">
              <span className="w-3 h-3 bg-yellow-100 rounded-full" />
              <span className="text-[#474747]">準備中: {preparingShipmentCount}</span>
            </div>
          </div>
        );
      default:
        return null;
    }
  })();

  const renderContent = () => {
    switch (activeTab) {
      case 'KPI':
        if (userRole !== 'admin') return null;
        return <KpiSection />;
      case 'NEWS':
        if (userRole !== 'admin') return null;
        return <NewsSection />;
      case 'ITEM':
        if (userRole !== 'admin') return null;
        return <ItemSection />;
      case 'LOOK':
        if (userRole !== 'admin') return null;
        return <LookSection />;
      case 'USER':
        if (userRole !== 'admin') return null;
        return <UserSection />;
      case 'ORDER':
        return <OrderSection orders={orders} onTransitStatus={handleTransitStatus} />;
      default:
        return null;
    }
  };

  if (!isAuthResolved) {
    return (
      <main className="pt-24 pb-20 px-6 lg:px-12">
        <div className="max-w-7xl mx-auto">
          <p className="text-sm text-[#474747] font-acumin">読み込み中...</p>
        </div>
      </main>
    );
  }

  if (!isLoggedIn || !canAccessAdmin) {
    return (
      <main className="pt-24 pb-20 px-6 lg:px-12">
        <div className="max-w-7xl mx-auto">
          <h1 className="text-2xl text-black mb-4 font-display">アクセス権限がありません</h1>
          <p className="text-sm text-[#474747] font-acumin">このページは Admin または Supporter のみ利用できます。</p>
        </div>
      </main>
    );
  }

  const handleTabChange = (tab: TabType) => {
    if (!visibleTabs.includes(tab)) {
      return;
    }

    setActiveTab(tab);
  };

  return (
    <main className="pt-24 pb-20 px-6 lg:px-12">
      <div className="max-w-7xl mx-auto">
        <AdminTabs activeTab={activeTab} onTabChange={handleTabChange} tabs={visibleTabs} rightContent={tabRightContent} />
        {renderContent()}
      </div>
    </main>
  );
}
