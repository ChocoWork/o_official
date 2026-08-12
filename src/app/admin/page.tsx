// ----------------- 管理ダッシュボード -----------------
'use client';

import { Suspense, useMemo, useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { type TabType } from '@/components/AdminTabs';
import AdminSideNav from '@/components/AdminSideNav';
import { useLogin } from '@/contexts/LoginContext';
import { clientFetch } from '@/lib/client-fetch';
import KpiSection, { type AdminKpiData } from '@/components/KpiSection';
import AccountingSection from '@/components/AccountingSection';
import NewsSection from '@/components/NewsSection';
import ItemSection from '@/components/ItemSection';
import LookSection from '@/components/LookSection';
import StockistSection from '@/components/StockistSection';
import UserSection from '@/components/UserSection';
import OrderSection, { type OrderItem } from '@/components/OrderSection';
import { Button } from '@/components/ui/Button/Button';
import { DateTimePicker } from '@/components/ui/DateTimePicker/DateTimePicker';
import { SearchField } from '@/components/ui/SearchField/SearchField';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { SHIPPING_CARRIERS, SHIPPING_CARRIER_IDS, type ShippingCarrierId } from '@/lib/orders/shipping-carriers';

const allAdminTabs: TabType[] = ['KPI', 'ACCOUNTING', 'NEWS', 'ITEM', 'LOOK', 'STOCKIST', 'USER', 'ORDER'];
const supporterTabs: TabType[] = ['ORDER'];
const ORDER_STATUS_FILTERS = [
  { label: 'すべて', value: 'all' },
  { label: '未決済', value: '未決済' },
  { label: '決済完了', value: '決済完了' },
  { label: '決済失敗', value: '決済失敗' },
  { label: 'キャンセル', value: 'キャンセル' },
] as const;

type OrderStatusFilterValue = (typeof ORDER_STATUS_FILTERS)[number]['value'];

type ForbiddenErrorBody = {
  reason?: string;
};

const ORDER_CSV_HEADERS = ['注文ID', '顧客名', '顧客メール', '注文日', '購入商品', '商品数', '合計金額', '決済状況'] as const;

function formatOrderItems(items: OrderItem['items']): string {
  return items.map((item) => `${item.name} x${item.quantity}`).join(' / ');
}

function escapeCsvValue(value: string): string {
  const escapedValue = value.replace(/"/g, '""');
  return `"${escapedValue}"`;
}

function AdminPageContent() {
  const { isLoggedIn, isAuthResolved, userRole, isMfaVerified } = useLogin();
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState<TabType>('KPI');
  const [kpiData, setKpiData] = useState<AdminKpiData | null>(null);
  const [isKpiLoading, setIsKpiLoading] = useState(false);
  const [kpiErrorMessage, setKpiErrorMessage] = useState<string | null>(null);
  const [orders, setOrders] = useState<OrderItem[]>([]);
  const [isOrdersLoading, setIsOrdersLoading] = useState(false);
  const [ordersErrorMessage, setOrdersErrorMessage] = useState<string | null>(null);
  const [ordersPage, setOrdersPage] = useState(1);
  const [ordersPageSize] = useState(20);
  const [ordersTotalPages, setOrdersTotalPages] = useState(1);
  const [ordersTotalCount, setOrdersTotalCount] = useState(0);
  const [periodFromInput, setPeriodFromInput] = useState('');
  const [periodToInput, setPeriodToInput] = useState('');
  const [periodFrom, setPeriodFrom] = useState('');
  const [periodTo, setPeriodTo] = useState('');
  const [periodErrorMessage, setPeriodErrorMessage] = useState<string | null>(null);
  const [orderStatusFilters, setOrderStatusFilters] = useState<OrderStatusFilterValue[]>(['all']);
  const [orderSearchKeyword, setOrderSearchKeyword] = useState('');
  const [orderReference, setOrderReference] = useState('');
  const [orderAmountMin, setOrderAmountMin] = useState('');
  const [orderAmountMax, setOrderAmountMax] = useState('');
  const [processingOrderIds, setProcessingOrderIds] = useState<string[]>([]);
  const [shipOrderId, setShipOrderId] = useState<string | null>(null);
  const [shipCarrier, setShipCarrier] = useState<ShippingCarrierId>('yamato');
  const [shipTrackingNumber, setShipTrackingNumber] = useState('');

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

  const fetchKpi = useCallback(async () => {
    try {
      setIsKpiLoading(true);
      setKpiErrorMessage(null);

      const response = await clientFetch('/api/admin/kpi', {
        cache: 'no-store',
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('認証が必要です。再ログインしてください。');
        }

        if (response.status === 403) {
          let forbiddenReason: string | undefined;

          try {
            const body = (await response.clone().json()) as ForbiddenErrorBody;
            forbiddenReason = typeof body.reason === 'string' ? body.reason : undefined;
          } catch {
            forbiddenReason = undefined;
          }

          if (forbiddenReason === 'MFA required') {
            throw new Error('KPIを表示するには2要素認証が必要です。再ログイン後に2FA認証を完了してください。');
          }

          throw new Error('KPIを表示する権限がありません。');
        }

        throw new Error('KPIの取得に失敗しました。');
      }

      const json = (await response.json()) as { data: AdminKpiData };
      setKpiData(json.data);
    } catch (error) {
      console.error('Failed to fetch admin KPI:', error);
      setKpiErrorMessage(error instanceof Error ? error.message : 'KPIの取得に失敗しました。');
    } finally {
      setIsKpiLoading(false);
    }
  }, []);

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

  const fetchOrders = useCallback(async (nextPage?: number) => {
    try {
      setIsOrdersLoading(true);
      setOrdersErrorMessage(null);

      const page = nextPage ?? ordersPage;
      const query = new URLSearchParams({
        page: String(page),
        pageSize: String(ordersPageSize),
      });

      if (periodFrom) {
        query.set('from', periodFrom);
      }

      if (periodTo) {
        query.set('to', periodTo);
      }

      if (orderSearchKeyword.trim()) {
        query.set('counterparty', orderSearchKeyword.trim());
      }

      if (orderReference.trim()) {
        query.set('reference', orderReference.trim());
      }

      if (orderAmountMin) {
        query.set('amountMin', orderAmountMin);
      }

      if (orderAmountMax) {
        query.set('amountMax', orderAmountMax);
      }

      const selectedStatus = orderStatusFilters.length === 1 ? orderStatusFilters[0] : 'all';
      const statusMap: Partial<Record<OrderStatusFilterValue, string>> = {
        '未決済': 'pending',
        '決済完了': 'paid',
        '決済失敗': 'failed',
        'キャンセル': 'cancelled',
      };
      const apiStatus = statusMap[selectedStatus];
      if (apiStatus) {
        query.set('status', apiStatus);
      }

      const response = await clientFetch(`/api/admin/orders?${query.toString()}`, {
        cache: 'no-store',
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('認証が必要です。再ログインしてください。');
        }

        if (response.status === 403) {
          throw new Error('注文一覧を表示する権限がありません。');
        }

        throw new Error('注文一覧の取得に失敗しました。');
      }

      const json = (await response.json()) as {
        data: OrderItem[];
        pagination: {
          page: number;
          pageSize: number;
          total: number;
          totalPages: number;
        };
      };

      setOrders(json.data ?? []);
      setOrdersPage(json.pagination?.page ?? page);
      setOrdersTotalPages(json.pagination?.totalPages ?? 1);
      setOrdersTotalCount(json.pagination?.total ?? 0);
    } catch (error) {
      console.error('Failed to fetch admin orders:', error);
      setOrdersErrorMessage(error instanceof Error ? error.message : '注文一覧の取得に失敗しました。');
    } finally {
      setIsOrdersLoading(false);
    }
  }, [
    ordersPage,
    ordersPageSize,
    periodFrom,
    periodTo,
    orderSearchKeyword,
    orderReference,
    orderAmountMin,
    orderAmountMax,
    orderStatusFilters,
  ]);

  useEffect(() => {
    if (!canAccessAdmin) {
      return;
    }

    if (activeTab !== 'ORDER') {
      return;
    }

    void fetchOrders();
  }, [activeTab, canAccessAdmin, fetchOrders]);

  useEffect(() => {
    if (!canAccessAdmin || userRole !== 'admin' || !isMfaVerified) {
      return;
    }

    if (activeTab !== 'KPI') {
      return;
    }

    void fetchKpi();
  }, [activeTab, canAccessAdmin, fetchKpi, isMfaVerified, userRole]);

  const pendingShipmentCount = useMemo(
    () => orders.filter((order) => order.status === '未決済').length,
    [orders],
  );

  const preparingShipmentCount = useMemo(
    () => orders.filter((order) => order.status === '決済完了').length,
    [orders],
  );

  const displayedOrders = useMemo(() => {
    const normalizedKeyword = orderSearchKeyword.trim().toLowerCase();
    const hasAllFilter = orderStatusFilters.includes('all');

    return orders.filter((order) => {
      const matchesStatus = hasAllFilter
        ? true
        : (orderStatusFilters as readonly string[]).includes(order.status);
      const matchesKeyword =
        normalizedKeyword.length === 0
          ? true
          : [order.id, order.customerName, order.customerEmail].some((value) =>
              value.toLowerCase().includes(normalizedKeyword),
            );

      return matchesStatus && matchesKeyword;
    });
  }, [orders, orderSearchKeyword, orderStatusFilters]);

  const handleStatusFilterToggle = (nextFilter: OrderStatusFilterValue) => {
    setOrderStatusFilters((prev) => {
      if (nextFilter === 'all') {
        return ['all'];
      }

      const nextValues = prev.filter((value) => value !== 'all');

      if (nextValues.includes(nextFilter)) {
        const filteredValues = nextValues.filter((value) => value !== nextFilter);
        return filteredValues.length > 0 ? filteredValues : ['all'];
      }

      return [...nextValues, nextFilter];
    });
  };

  const updateProcessingOrder = (id: string, shouldAdd: boolean) => {
    setProcessingOrderIds((prev) => {
      if (shouldAdd) {
        if (prev.includes(id)) {
          return prev;
        }
        return [...prev, id];
      }

      return prev.filter((itemId) => itemId !== id);
    });
  };

  const handleCancelOrder = async (id: string) => {
    if (!window.confirm('この注文をキャンセルしますか？')) {
      return;
    }

    try {
      setOrdersErrorMessage(null);
      updateProcessingOrder(id, true);

      const response = await clientFetch(`/api/admin/orders/${id}/status`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'cancelled' }),
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('認証が必要です。再ログインしてください。');
        }

        if (response.status === 403) {
          throw new Error('注文ステータス更新の権限がありません。');
        }

        throw new Error('注文ステータスの更新に失敗しました。');
      }

      setOrders((prevOrders) =>
        prevOrders.map((order) =>
          order.id === id
            ? {
                ...order,
                status: 'キャンセル',
              }
            : order,
        ),
      );
    } catch (error) {
      console.error('Failed to cancel order:', error);
      setOrdersErrorMessage(error instanceof Error ? error.message : '注文ステータスの更新に失敗しました。');
    } finally {
      updateProcessingOrder(id, false);
    }
  };

  const openShipDialog = (id: string) => {
    setShipCarrier('yamato');
    setShipTrackingNumber('');
    setShipOrderId(id);
  };

  const handleShipOrder = async () => {
    const id = shipOrderId;
    if (!id) return;

    if (!/^[0-9A-Za-z-]{1,64}$/.test(shipTrackingNumber.trim())) {
      setOrdersErrorMessage('追跡番号は英数字とハイフンで入力してください。');
      return;
    }

    try {
      setOrdersErrorMessage(null);
      updateProcessingOrder(id, true);
      setShipOrderId(null);

      const response = await clientFetch(`/api/admin/orders/${id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'shipped',
          carrier: shipCarrier,
          trackingNumber: shipTrackingNumber.trim(),
        }),
      });

      if (!response.ok) {
        if (response.status === 409) {
          throw new Error('発送できる状態ではありません。一覧を更新して状態を確認してください。');
        }
        if (response.status === 403) {
          throw new Error('注文ステータス更新の権限がありません。');
        }
        throw new Error('発送状態の更新に失敗しました。');
      }

      setOrders((prevOrders) =>
        prevOrders.map((order) => (order.id === id ? { ...order, status: '発送済み' } : order)),
      );
    } catch (error) {
      console.error('Failed to ship order:', error);
      setOrdersErrorMessage(error instanceof Error ? error.message : '発送状態の更新に失敗しました。');
    } finally {
      updateProcessingOrder(id, false);
    }
  };

  const handleRefundOrder = async (id: string) => {
    if (!window.confirm('この注文を全額返金しますか？')) {
      return;
    }

    try {
      setOrdersErrorMessage(null);
      updateProcessingOrder(id, true);

      const response = await clientFetch(`/api/admin/orders/${id}/refund`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ reason: 'requested_by_customer' }),
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('認証が必要です。再ログインしてください。');
        }

        if (response.status === 403) {
          throw new Error('返金操作の権限がありません。');
        }

        throw new Error('返金処理に失敗しました。');
      }

      setOrders((prevOrders) =>
        prevOrders.map((order) =>
          order.id === id
            ? {
                ...order,
                status: 'キャンセル',
                canRefund: false,
              }
            : order,
        ),
      );
    } catch (error) {
      console.error('Failed to refund order:', error);
      setOrdersErrorMessage(error instanceof Error ? error.message : '返金処理に失敗しました。');
    } finally {
      updateProcessingOrder(id, false);
    }
  };

  const handleApplyPeriodFilter = () => {
    if (periodFromInput && periodToInput && periodFromInput > periodToInput) {
      setPeriodErrorMessage('期間指定が不正です。開始日は終了日以前にしてください。');
      return;
    }

    setPeriodErrorMessage(null);
    setPeriodFrom(periodFromInput);
    setPeriodTo(periodToInput);
    setOrdersPage(1);
  };

  const handleClearPeriodFilter = () => {
    setPeriodFromInput('');
    setPeriodToInput('');
    setPeriodFrom('');
    setPeriodTo('');
    setPeriodErrorMessage(null);
    setOrdersPage(1);
  };

  const handleExportOrdersCsv = () => {
    // only export orders that are in the “決済完了” status
    const filtered = displayedOrders.filter((o) => o.status === '決済完了');

    const csvRows = filtered.map((order) => {
      const row = [
        order.id,
        order.customerName,
        order.customerEmail,
        order.orderDate,
        formatOrderItems(order.items),
        order.itemCount,
        order.totalAmount,
        order.status,
      ];

      return row.map((value) => escapeCsvValue(value)).join(',');
    });

    const csvContent = [ORDER_CSV_HEADERS.join(','), ...csvRows].join('\n');
    const bom = '\uFEFF';
    const blob = new Blob([`${bom}${csvContent}`], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);

    anchor.href = url;
    anchor.download = `orders_${date}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    window.URL.revokeObjectURL(url);
  };

  const tabRightContent = (() => {
    switch (activeTab) {
      case 'NEWS':
        if (userRole !== 'admin') return null;
        return (
          <Button href="/admin/news/create" variant="primary" size="sm" className="font-acumin">
            新規作成
          </Button>
        );
      case 'ITEM':
        if (userRole !== 'admin') return null;
        return (
          <Button href="/admin/item/create" variant="primary" size="sm" className="font-acumin">
            新規作成
          </Button>
        );
      case 'LOOK':
        if (userRole !== 'admin') return null;
        return (
          <Button href="/admin/look/create" variant="primary" size="sm" className="font-acumin">
            新規作成
          </Button>
        );
      case 'STOCKIST':
        if (userRole !== 'admin') return null;
        return (
          <Button href="/admin/stockist/create" variant="primary" size="sm" className="font-acumin">
            新規作成
          </Button>
        );
      case 'ORDER':
        return (
          <div className="flex items-center justify-end gap-3 whitespace-nowrap">
            <div className="w-64 shrink-0 xl:w-72">
              <SearchField
                label="取引先"
                placeholder="顧客名 / メール"
                value={orderSearchKeyword}
                onChange={(event) => {
                  setOrdersPage(1);
                  setOrderSearchKeyword(event.target.value);
                }}
                showClearButton
                onClear={() => setOrderSearchKeyword('')}
                size='sm'
                className="font-acumin"
              />
            </div>
            <div className="flex shrink-0 gap-2">
              {ORDER_STATUS_FILTERS.map((statusFilter) => (
                <Button
                  key={statusFilter.value}
                  variant={orderStatusFilters.includes(statusFilter.value) ? 'primary' : 'secondary'}
                  size="sm"
                  className="font-acumin"
                  onClick={() => handleStatusFilterToggle(statusFilter.value)}
                >
                  {statusFilter.label}
                </Button>
              ))}
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
        return <KpiSection data={kpiData} isLoading={isKpiLoading} errorMessage={kpiErrorMessage} onRetry={fetchKpi} />;
      case 'ACCOUNTING':
        if (userRole !== 'admin') return null;
        return <AccountingSection />;
      case 'NEWS':
        if (userRole !== 'admin') return null;
        return <NewsSection />;
      case 'ITEM':
        if (userRole !== 'admin') return null;
        return <ItemSection />;
      case 'LOOK':
        if (userRole !== 'admin') return null;
        return <LookSection />;
      case 'STOCKIST':
        if (userRole !== 'admin') return null;
        return <StockistSection />;
      case 'USER':
        if (userRole !== 'admin') return null;
        return <UserSection />;
      case 'ORDER':
        return (
          <div className="space-y-4">
            <div className="space-y-3 border-b border-black/10 pb-4">
              <div className="flex flex-wrap items-end gap-3">
                <label className="grid gap-1 text-xs font-acumin">
                  金額（下限）
                  <input
                    aria-label="金額（下限）"
                    type="number"
                    min="0"
                    step="1"
                    value={orderAmountMin}
                    onChange={(event) => {
                      setOrdersPage(1);
                      setOrderAmountMin(event.target.value);
                    }}
                    className="h-8 w-32 border border-black/25 px-2"
                  />
                </label>
                <label className="grid gap-1 text-xs font-acumin">
                  金額（上限）
                  <input
                    aria-label="金額（上限）"
                    type="number"
                    min="0"
                    step="1"
                    value={orderAmountMax}
                    onChange={(event) => {
                      setOrdersPage(1);
                      setOrderAmountMax(event.target.value);
                    }}
                    className="h-8 w-32 border border-black/25 px-2"
                  />
                </label>
                <div className="w-56">
                  <SearchField
                    label="注文・決済ID"
                    placeholder="注文ID / pi_..."
                    value={orderReference}
                    onChange={(event) => {
                      setOrdersPage(1);
                      setOrderReference(event.target.value);
                    }}
                    showClearButton
                    onClear={() => setOrderReference('')}
                    size="sm"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <DateTimePicker
                    id="orders-from"
                    label=""
                    mode="date"
                    value={periodFromInput}
                    onChange={(event) => setPeriodFromInput(event.target.value)}
                    size="sm"
                    className="w-full"
                  />
                  <span className="text-sm text-[#474747] font-acumin">~</span>
                  <DateTimePicker
                    id="orders-to"
                    label=""
                    mode="date"
                    value={periodToInput}
                    onChange={(event) => setPeriodToInput(event.target.value)}
                    size="sm"
                    className="w-full"
                  />
                </div>
                <Button variant="secondary" size="sm" className="font-acumin" onClick={handleApplyPeriodFilter}>
                  期間適用
                </Button>
                <Button variant="secondary" size="sm" className="font-acumin" onClick={handleClearPeriodFilter}>
                  期間クリア
                </Button>
                <Button variant="secondary" size="sm" className="font-acumin" onClick={handleExportOrdersCsv}>
                  表示中の注文をCSV出力
                </Button>
                <div className="flex items-center gap-2 text-xs font-acumin">
                  <span className="text-[#474747]">{ordersTotalCount}件（表示 {displayedOrders.length}件）</span>
                  <span className="text-[#474747]">{ordersPage} / {ordersTotalPages}ページ</span>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="font-acumin"
                    onClick={() => setOrdersPage((prev) => Math.max(1, prev - 1))}
                    disabled={ordersPage <= 1 || isOrdersLoading}
                  >
                    前へ
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="font-acumin"
                    onClick={() => setOrdersPage((prev) => Math.min(ordersTotalPages, prev + 1))}
                    disabled={ordersPage >= ordersTotalPages || isOrdersLoading}
                  >
                    次へ
                  </Button>
                </div>
                <div className="flex items-center gap-2 text-sm font-acumin ml-2">
                  <span className="w-3 h-3 bg-red-100 rounded-full" />
                  <span className="text-[#474747]">未決済: {pendingShipmentCount}</span>
                </div>
                <div className="flex items-center gap-2 text-sm font-acumin">
                  <span className="w-3 h-3 bg-yellow-100 rounded-full" />
                  <span className="text-[#474747]">決済完了: {preparingShipmentCount}</span>
                </div>
              </div>
            </div>
            {periodErrorMessage ? <p className="text-sm text-red-700 font-acumin">{periodErrorMessage}</p> : null}
            <OrderSection
              orders={displayedOrders}
              isLoading={isOrdersLoading}
              errorMessage={ordersErrorMessage}
              onCancelOrder={handleCancelOrder}
              onRefundOrder={userRole === 'admin' ? handleRefundOrder : undefined}
              onShipOrder={openShipDialog}
              processingOrderIds={processingOrderIds}
            />
            <Dialog
              open={shipOrderId !== null}
              onClose={() => setShipOrderId(null)}
              title="発送済みにする"
            >
              <div className="space-y-3">
                <div>
                  <label htmlFor="ship-carrier" className="block font-acumin text-xs text-[#474747]">
                    配送業者
                  </label>
                  <select
                    id="ship-carrier"
                    value={shipCarrier}
                    onChange={(event) => setShipCarrier(event.target.value as ShippingCarrierId)}
                    className="mt-1 h-9 w-full border border-[#d4d4d4] bg-white px-2 font-acumin text-xs text-black"
                  >
                    {SHIPPING_CARRIER_IDS.map((id) => (
                      <option key={id} value={id}>
                        {SHIPPING_CARRIERS[id].label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="ship-tracking" className="block font-acumin text-xs text-[#474747]">
                    追跡番号
                  </label>
                  <input
                    id="ship-tracking"
                    type="text"
                    inputMode="numeric"
                    maxLength={64}
                    value={shipTrackingNumber}
                    onChange={(event) => setShipTrackingNumber(event.target.value)}
                    placeholder="1234-5678-9012"
                    className="mt-1 h-9 w-full border border-[#d4d4d4] bg-white px-2 font-acumin text-xs text-black"
                  />
                </div>
                <div className="flex gap-2 pt-1">
                  <Button
                    variant="secondary"
                    size="sm"
                    className="w-full font-acumin"
                    onClick={() => setShipOrderId(null)}
                  >
                    キャンセル
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    className="w-full font-acumin"
                    onClick={() => void handleShipOrder()}
                  >
                    発送する
                  </Button>
                </div>
              </div>
            </Dialog>
          </div>
        );
      default:
        return null;
    }
  };

  if (!isAuthResolved) {
    return (
      <div className="element-width">
        <p className="text-sm text-[#474747] font-acumin">読み込み中...</p>
      </div>
    );
  }

  if (!isLoggedIn || !canAccessAdmin) {
    return (
      <div className="element-width">
        <h1 className="mb-4">アクセス権限がありません</h1>
        <p className="text-sm text-[#474747] font-acumin">このページは Admin または Supporter のみ利用できます。</p>
      </div>
    );
  }

  if (!isMfaVerified) {
    return (
      <div className="element-width">
        <h1 className="mb-4">2要素認証が必要です</h1>
        <p className="text-sm text-[#474747] font-acumin">
          管理画面へのアクセスには 2FA の有効化と認証が必要です。設定済みの場合は再度ログインしてください。
        </p>
      </div>
    );
  }

  const handleTabChange = (tab: TabType) => {
    if (!visibleTabs.includes(tab)) {
      return;
    }

    setActiveTab(tab);
  };

  return (
    <div className="w-full min-w-0 md:-mx-5">
      <div className="flex min-w-0 flex-col gap-6 md:flex-row md:gap-0">
        <aside className="relative z-30 w-full min-w-0 md:w-56 md:shrink-0">
          <AdminSideNav activeTab={activeTab} onTabChange={handleTabChange} tabs={visibleTabs} />
        </aside>
        <div className="min-w-0 flex-1 md:px-8">
          {tabRightContent ? <div className="mb-6 flex justify-end">{tabRightContent}</div> : null}
          {renderContent()}
        </div>
      </div>
    </div>
  );
}

export default function AdminPage() {
  return (
    <Suspense
      fallback={
        <div className="element-width">
          <p className="text-sm text-[#474747] font-acumin">読み込み中...</p>
        </div>
      }
    >
      <AdminPageContent />
    </Suspense>
  );
}
