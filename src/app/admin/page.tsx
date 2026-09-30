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
import AttentionInbox from '@/components/AttentionInbox';
import OrderCancelDialog, { type OrderCancelValues } from '@/components/OrderCancelDialog';
import { BannerAlert } from '@/components/ui/BannerAlert/BannerAlert';
import { Button } from '@/components/ui/Button/Button';
import { DateTimePicker } from '@/components/ui/DateTimePicker/DateTimePicker';
import { SearchField } from '@/components/ui/SearchField/SearchField';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import type { OrderAttention } from '@/lib/orders/order-payment-types';
import { SHIPPING_CARRIERS, SHIPPING_CARRIER_IDS, type ShippingCarrierId } from '@/lib/orders/shipping-carriers';

const allAdminTabs: TabType[] = ['KPI', 'ACCOUNTING', 'NEWS', 'ITEM', 'LOOK', 'STOCKIST', 'USER', 'ORDER'];
const supporterTabs: TabType[] = ['ORDER'];
const ORDER_STATUS_FILTERS = [
  { label: 'すべて', value: 'all' },
  { label: '支払い手続き中', value: '支払い手続き中' },
  { label: '未決済', value: '未決済' },
  { label: '決済完了', value: '決済完了' },
  { label: '決済失敗', value: '決済失敗' },
  { label: '放棄', value: '放棄' },
  { label: 'キャンセル', value: 'キャンセル' },
  { label: '発送済み', value: '発送済み' },
] as const;

type OrderStatusFilterValue = (typeof ORDER_STATUS_FILTERS)[number]['value'];

type ForbiddenErrorBody = {
  reason?: string;
};


type RefundResponseBody = {
  refundStatus?: unknown;
  orderStatus?: unknown;
};

const REFUND_STATUSES = new Set(['pending', 'requires_action', 'succeeded', 'failed', 'canceled']);
const REFUND_ORDER_STATUSES = new Set(['paid', 'shipped', 'cancelled']);

// 取消・解決で Stripe の状態を確かめられなかった（503）。一覧を更新しても直らないので、再試行を案内する
const STRIPE_UNAVAILABLE_MESSAGE = 'Stripe の状態を確認できませんでした。時間をおいて再試行してください。';

async function readSafeOrderActionError(response: Response, fallback: string): Promise<string> {
  if (response.status !== 400 && response.status !== 409) {
    return fallback;
  }

  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error.length > 0 && body.error.length <= 200) {
      return body.error;
    }
  } catch {
    // Invalid or non-JSON error bodies are intentionally replaced with a generic message.
  }

  return fallback;
}

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
  const [ordersNoticeMessage, setOrdersNoticeMessage] = useState<string | null>(null);
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
  const [reviewOnly, setReviewOnly] = useState(false);
  const [attention, setAttention] = useState<OrderAttention | null>(null);
  // 読み込みの失敗と、要対応・要確認の操作が断られた理由。欄のすぐ下に出す（OrderSection のエラーは一覧の下で、読み直しで消える）
  const [attentionErrorMessage, setAttentionErrorMessage] = useState<string | null>(null);
  const [processingAttentionIds, setProcessingAttentionIds] = useState<string[]>([]);
  const [cancelTarget, setCancelTarget] = useState<OrderItem | null>(null);
  const [cancelSubmitting, setCancelSubmitting] = useState(false);

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
        '支払い手続き中': 'payment_in_progress',
        '未決済': 'pending',
        '決済完了': 'paid',
        '決済失敗': 'failed',
        '放棄': 'abandoned',
        'キャンセル': 'cancelled',
      };
      const apiStatus = statusMap[selectedStatus];
      if (apiStatus) {
        query.set('status', apiStatus);
      }

      if (reviewOnly) {
        query.set('review', 'only');
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
      return true;
    } catch (error) {
      console.error('Failed to fetch admin orders:', error);
      setOrdersErrorMessage(error instanceof Error ? error.message : '注文一覧の取得に失敗しました。');
      return false;
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
    reviewOnly,
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

  // 要対応・要確認（設計書 5-2）。サイドナビと KPI 画面の件数にも使うので、タブを移るたびに読み直す。
  // 読めなかったときに欄を出さないだけだと「未処理なし」に見え、開いている要対応を見落とすので、その旨を出す
  const fetchAttention = useCallback(async () => {
    try {
      const response = await clientFetch('/api/admin/order-attention', { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Failed to fetch order attention: ${response.status}`);
      }
      const json = (await response.json()) as { data?: Partial<OrderAttention> };
      const data = json.data;
      if (!data || !Array.isArray(data.exceptions) || !Array.isArray(data.reviews) || !data.counts) {
        throw new Error('Unexpected order attention response');
      }
      setAttention(data as OrderAttention);
      setAttentionErrorMessage(null);
    } catch (error) {
      console.error('Failed to fetch order attention:', error);
      setAttentionErrorMessage('要対応・要確認を読み込めませんでした。');
    }
  }, []);

  useEffect(() => {
    if (!canAccessAdmin || !isMfaVerified) {
      return;
    }

    void fetchAttention();
  }, [activeTab, canAccessAdmin, isMfaVerified, fetchAttention]);

  const attentionTotal = (attention?.counts.exceptions ?? 0) + (attention?.counts.reviews ?? 0);

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
        : orderStatusFilters.some((filter) => filter === order.status);
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

  const handleCancelOrder = (id: string) => {
    const order = orders.find((item) => item.id === id);
    if (!order) {
      return;
    }

    setOrdersNoticeMessage(null);
    setCancelTarget(order);
  };

  const submitCancelOrder = async (values: OrderCancelValues) => {
    const target = cancelTarget;
    if (!target) {
      return;
    }

    try {
      setOrdersErrorMessage(null);
      setCancelSubmitting(true);
      updateProcessingOrder(target.id, true);

      const response = await clientFetch(`/api/admin/orders/${target.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'cancelled',
          reason: values.reason,
          ...(values.note ? { note: values.note } : {}),
          notifyCustomer: values.notifyCustomer,
        }),
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('認証が必要です。再ログインしてください。');
        }
        if (response.status === 403) {
          throw new Error('注文ステータス更新の権限がありません。');
        }
        if (response.status === 503) {
          throw new Error(STRIPE_UNAVAILABLE_MESSAGE);
        }
        throw new Error(await readSafeOrderActionError(response, '注文ステータスの更新に失敗しました。'));
      }

      setOrders((prevOrders) =>
        prevOrders.map((order) =>
          order.id === target.id
            ? { ...order, status: 'キャンセル', canCancel: false, cancelBlockedUntil: null }
            : order,
        ),
      );
      setOrdersNoticeMessage('注文を取り消しました。');
      void fetchAttention();
    } catch (error) {
      console.error('Failed to cancel order:', error);
      setOrdersErrorMessage(error instanceof Error ? error.message : '注文ステータスの更新に失敗しました。');
    } finally {
      setCancelTarget(null);
      setCancelSubmitting(false);
      updateProcessingOrder(target.id, false);
    }
  };

  /**
   * 要対応・要確認の操作。成功したら欄と一覧を読み直す。断られたら理由を欄のすぐ下に出す（行は残し、押し直せる）。
   * 送っている間は id を操作中に置き、成功でも失敗でも finally で外す。
   */
  const runAttentionAction = async (id: string, request: () => Promise<Response>, successMessage: string) => {
    try {
      setOrdersErrorMessage(null);
      setOrdersNoticeMessage(null);
      setAttentionErrorMessage(null);
      setProcessingAttentionIds((prev) => [...prev, id]);

      const response = await request();
      if (!response.ok) {
        if (response.status === 403) {
          throw new Error('この操作の権限がありません。');
        }
        if (response.status === 503) {
          throw new Error(STRIPE_UNAVAILABLE_MESSAGE);
        }
        throw new Error(await readSafeOrderActionError(response, '操作に失敗しました。一覧を更新してください。'));
      }

      setOrdersNoticeMessage(successMessage);
      await Promise.all([fetchAttention(), fetchOrders()]);
    } catch (error) {
      console.error('Failed to update order attention:', error);
      setAttentionErrorMessage(error instanceof Error ? error.message : '操作に失敗しました。');
    } finally {
      setProcessingAttentionIds((prev) => prev.filter((itemId) => itemId !== id));
    }
  };

  const handleReviewOrder = (orderId: string) =>
    void runAttentionAction(
      orderId,
      () => clientFetch(`/api/admin/orders/${orderId}/review`, { method: 'POST' }),
      '確認済みにしました。',
    );

  const handleResolveException = ({ exceptionId, note }: { exceptionId: string; note: string }) =>
    void runAttentionAction(
      exceptionId,
      () =>
        clientFetch(`/api/admin/payment-exceptions/${exceptionId}/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(note ? { note } : {}),
        }),
      '解決済みにしました。',
    );

  const handleCancelAndResolve = ({ exceptionId, values }: { exceptionId: string; values: OrderCancelValues }) =>
    void runAttentionAction(
      exceptionId,
      () =>
        clientFetch(`/api/admin/payment-exceptions/${exceptionId}/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            note: values.note,
            cancelOrder: true,
            cancelReason: values.reason,
            notifyCustomer: values.notifyCustomer,
          }),
        }),
      '注文を取り消して解決しました。',
    );

  const openShipDialog = (id: string) => {
    setOrdersNoticeMessage(null);
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
      setOrdersNoticeMessage(null);
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
          throw new Error('発送できる状態ではありません。一覧を更新し、決済状態と配送先を確認してください。');
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
      setOrdersNoticeMessage(null);
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

        throw new Error(await readSafeOrderActionError(response, '返金処理に失敗しました。'));
      }

      const body = (await response.json()) as RefundResponseBody;
      if (
        typeof body.refundStatus !== 'string'
        || !REFUND_STATUSES.has(body.refundStatus)
        || typeof body.orderStatus !== 'string'
        || !REFUND_ORDER_STATUSES.has(body.orderStatus)
      ) {
        throw new Error('返金状態を確認できませんでした。');
      }

      const refreshed = await fetchOrders();
      if (!refreshed) {
        throw new Error('返金後の注文状態を確認できませんでした。一覧を再読み込みしてください。');
      }

      if (body.refundStatus === 'failed' || body.refundStatus === 'canceled') {
        throw new Error('返金が完了しませんでした。注文状態を確認してください。');
      }

      if (body.refundStatus === 'pending' || body.refundStatus === 'requires_action') {
        setOrdersNoticeMessage('返金処理を受け付けました。Stripeで完了後に注文状態が更新されます。');
      } else if (body.orderStatus === 'cancelled') {
        setOrdersNoticeMessage('全額返金が完了し、注文をキャンセルしました。');
      } else {
        setOrdersNoticeMessage('返金が完了しました。再取得した注文状態を表示しています。');
      }
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
          <div className="flex flex-wrap items-center justify-end gap-3">
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
            <div className="flex flex-wrap justify-end gap-2">
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
              <Button
                variant={reviewOnly ? 'primary' : 'secondary'}
                size="sm"
                className="font-acumin"
                aria-pressed={reviewOnly}
                onClick={() => {
                  setOrdersPage(1);
                  setReviewOnly((prev) => !prev);
                }}
              >
                要確認のみ
              </Button>
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
        return (
          <>
            {attentionTotal > 0 ? (
              <BannerAlert
                variant="warning"
                className="mb-6"
                message={`要対応${attention?.counts.exceptions ?? 0}件・要確認${attention?.counts.reviews ?? 0}件（ORDER で確認）`}
              />
            ) : null}
            <KpiSection data={kpiData} isLoading={isKpiLoading} errorMessage={kpiErrorMessage} onRetry={fetchKpi} />
          </>
        );
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
            <AttentionInbox
              attention={attention}
              processingIds={processingAttentionIds}
              onReview={handleReviewOrder}
              onResolve={handleResolveException}
              onCancelAndResolve={handleCancelAndResolve}
            />
            {attentionErrorMessage ? (
              <p role="alert" className="lk-text-sm text-red-700 font-acumin">{attentionErrorMessage}</p>
            ) : null}
            <div className="space-y-3 border-b border-black/10 pb-4">
              <div className="flex flex-wrap items-end gap-3">
                <label className="grid gap-1 lk-text-3xs font-acumin">
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
                <label className="grid gap-1 lk-text-3xs font-acumin">
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
                  <span className="lk-text-sm text-[#474747] font-acumin">~</span>
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
                <div className="flex items-center gap-2 lk-text-3xs font-acumin">
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
                <div className="flex items-center gap-2 lk-text-sm font-acumin ml-2">
                  <span className="w-3 h-3 bg-red-100 rounded-full" />
                  <span className="text-[#474747]">未決済: {pendingShipmentCount}</span>
                </div>
                <div className="flex items-center gap-2 lk-text-sm font-acumin">
                  <span className="w-3 h-3 bg-yellow-100 rounded-full" />
                  <span className="text-[#474747]">決済完了: {preparingShipmentCount}</span>
                </div>
              </div>
            </div>
            {periodErrorMessage ? <p className="lk-text-sm text-red-700 font-acumin">{periodErrorMessage}</p> : null}
            <OrderSection
              orders={displayedOrders}
              isLoading={isOrdersLoading}
              errorMessage={ordersErrorMessage}
              noticeMessage={ordersNoticeMessage}
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
                  <label htmlFor="ship-carrier" className="block font-acumin lk-text-3xs text-[#474747]">
                    配送業者
                  </label>
                  <select
                    id="ship-carrier"
                    value={shipCarrier}
                    onChange={(event) => setShipCarrier(event.target.value as ShippingCarrierId)}
                    className="mt-1 h-9 w-full border border-[#d4d4d4] bg-white px-2 font-acumin lk-text-3xs text-black"
                  >
                    {SHIPPING_CARRIER_IDS.map((id) => (
                      <option key={id} value={id}>
                        {SHIPPING_CARRIERS[id].label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="ship-tracking" className="block font-acumin lk-text-3xs text-[#474747]">
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
                    className="mt-1 h-9 w-full border border-[#d4d4d4] bg-white px-2 font-acumin lk-text-3xs text-black"
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
            <OrderCancelDialog
              open={cancelTarget !== null}
              title="注文を取り消す"
              targetLabel={cancelTarget?.id ?? ''}
              showNotifyOption={cancelTarget?.status !== '決済失敗'}
              noteRequired={false}
              submitting={cancelSubmitting}
              onClose={() => setCancelTarget(null)}
              onSubmit={(values) => void submitCancelOrder(values)}
            />
          </div>
        );
      default:
        return null;
    }
  };

  if (!isAuthResolved) {
    return (
      <div className="element-width">
        <p className="lk-text-sm text-[#474747] font-acumin">読み込み中...</p>
      </div>
    );
  }

  if (!isLoggedIn || !canAccessAdmin) {
    return (
      <div className="element-width">
        <h1 className="mb-4">アクセス権限がありません</h1>
        <p className="lk-text-sm text-[#474747] font-acumin">このページは Admin または Supporter のみ利用できます。</p>
      </div>
    );
  }

  if (!isMfaVerified) {
    return (
      <div className="element-width">
        <h1 className="mb-4">2要素認証が必要です</h1>
        <p className="lk-text-sm text-[#474747] font-acumin">
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
    <div className="w-full min-w-0 lg:-mx-5">
      <div className="flex min-w-0 flex-col gap-6 lg:flex-row lg:gap-0">
        <aside className="relative z-30 w-full min-w-0 lg:w-56 lg:shrink-0">
          <AdminSideNav
            activeTab={activeTab}
            onTabChange={handleTabChange}
            tabs={visibleTabs}
            badges={{ ORDER: attentionTotal }}
          />
        </aside>
        <div
          data-testid="admin-content-column"
          className="min-w-0 flex-1 md:px-8 lg:px-10 xl:px-14 2xl:px-20 3xl:px-24 4xl:px-32"
        >
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
          <p className="lk-text-sm text-[#474747] font-acumin">読み込み中...</p>
        </div>
      }
    >
      <AdminPageContent />
    </Suspense>
  );
}
