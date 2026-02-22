// ----------------- 管理ダッシュボード -----------------
'use client';

import Link from 'next/link';
import { useMemo, useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import AdminTabs from '@/app/components/AdminTabs';
import KpiSection from '@/app/components/KpiSection';
import NewsSection from '@/app/components/NewsSection';
import ItemSection from '@/app/components/ItemSection';
import LookSection from '@/app/components/LookSection';
import UserSection from '@/app/components/UserSection';
import OrderSection, { type OrderItem, type OrderStatus } from '@/app/components/OrderSection';

type TabType = 'KPI' | 'NEWS' | 'ITEM' | 'LOOK' | 'USER' | 'ORDER';

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
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState<TabType>('KPI');
  const [orders, setOrders] = useState<OrderItem[]>(initialOrders);

  useEffect(() => {
    const tab = searchParams.get('tab');
    if (tab && ['KPI', 'NEWS', 'ITEM', 'LOOK', 'USER', 'ORDER'].includes(tab)) {
      setActiveTab(tab as TabType);
    }
  }, [searchParams]);

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
        return (
          <Link
            href="/admin/news/create"
            className="px-8 py-3 bg-black text-white text-sm tracking-widest hover:bg-[#474747] transition-all cursor-pointer whitespace-nowrap font-acumin"
          >
            新規作成
          </Link>
        );
      case 'ITEM':
        return (
          <Link
            href="/admin/item/create"
            className="px-8 py-3 bg-black text-white text-sm tracking-widest hover:bg-[#474747] transition-all cursor-pointer whitespace-nowrap font-acumin"
          >
            新規作成
          </Link>
        );
      case 'LOOK':
        return (
          <Link
            href="/admin/look/create"
            className="px-8 py-3 bg-black text-white text-sm tracking-widest hover:bg-[#474747] transition-all cursor-pointer whitespace-nowrap font-acumin"
          >
            新規作成
          </Link>
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
        return <OrderSection orders={orders} onTransitStatus={handleTransitStatus} />;
      default:
        return <KpiSection />;
    }
  };

  return (
    <main className="pt-24 pb-20 px-6 lg:px-12">
      <div className="max-w-7xl mx-auto">
        <AdminTabs activeTab={activeTab} onTabChange={setActiveTab} rightContent={tabRightContent} />
        {renderContent()}
      </div>
    </main>
  );
}
