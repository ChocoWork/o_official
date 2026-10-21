// ----------------- 管理ダッシュボード -----------------
'use client';

import { Fragment, Suspense, useMemo, useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
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
import ShopSettingsSection from '@/components/ShopSettingsSection';
import OrderSection, { type OrderItem } from '@/components/OrderSection';
import AttentionInbox from '@/components/AttentionInbox';
import OrderCancelDialog, { type OrderCancelValues } from '@/components/OrderCancelDialog';
import OrderCancelRequestDialog, { type RemoveItemsRequest } from '@/components/OrderCancelRequestDialog';
import OrderShipDialog from '@/components/OrderShipDialog';
import OrderCompletionDialog from '@/components/OrderCompletionDialog';
import OrderHistoryDialog from '@/components/OrderHistoryDialog';
import OrderPaidCancelDialog from '@/components/OrderPaidCancelDialog';
import OrderRefundDialog from '@/components/OrderRefundDialog';
import OrderReturnsDialog from '@/components/OrderReturnsDialog';
import { BannerAlert } from '@/components/ui/BannerAlert/BannerAlert';
import { Button } from '@/components/ui/Button/Button';
import { DateTimePicker } from '@/components/ui/DateTimePicker/DateTimePicker';
import { SearchField } from '@/components/ui/SearchField/SearchField';
import { SingleSelect } from '@/components/ui/SingleSelect/SingleSelect';
import { COMPLETION_RECORDED_MESSAGE } from '@/lib/orders/fulfillment/fulfillment-client';
import { PAYMENT_STATUS_LABELS } from '@/lib/orders/payment-status';
import type { OrderAttention, OrderStatus } from '@/lib/orders/order-payment-types';
import type { RefundAcceptedResponse } from '@/lib/orders/refund/refund-types';
import { RETURN_DISPLAY_STATUS_LABELS } from '@/lib/orders/returns/return-messages';
import { RETURN_DISPLAY_STATUSES, type ReturnDisplayStatus } from '@/lib/orders/returns/return-types';

type AdminOrderAttention = OrderAttention & {
  emailSending?: { paused: boolean; reasonLabel: string | null } | null;
};

// SETTINGS（ショップの設定）は店長だけ。サポートの人の supporterTabs には足さない（窓口も権限 admin.settings.manage で守る）
const allAdminTabs: TabType[] = ['KPI', 'ACCOUNTING', 'NEWS', 'ITEM', 'LOOK', 'STOCKIST', 'USER', 'ORDER', 'SETTINGS'];
const supporterTabs: TabType[] = ['ORDER'];
// 絞り込みは DB の状態で行う（段階で絞ると、ページを分けて読む作りが崩れる。設計書 4-4）。value は窓口の status にそのまま送る
const ORDER_STATUS_FILTERS = [
  { label: 'すべて', value: 'all' },
  { label: '支払い手続き中', value: 'payment_in_progress' },
  { label: '未決済', value: 'pending' },
  { label: '発送待ち（受注生産中・発送準備中）', value: 'paid' },
  { label: '発送済み（配送中・配達済み）', value: 'shipped' },
  { label: '決済失敗', value: 'failed' },
  { label: '放棄', value: 'abandoned' },
  { label: 'キャンセル', value: 'cancelled' },
] as const satisfies ReadonlyArray<{ label: string; value: 'all' | OrderStatus }>;

type OrderStatusFilterValue = (typeof ORDER_STATUS_FILTERS)[number]['value'];

// 返品の絞り込みは窓口に頼む（DB の注文の状態の絞り込みとは別。設計書 8-1）。value は窓口の return にそのまま送る。
// 言葉は返品の状態の表（return-messages.ts）から引き、ここでは作らない
type ReturnFilterValue = 'all' | ReturnDisplayStatus;
const RETURN_FILTER_OPTIONS: Array<{ label: string; value: ReturnFilterValue }> = [
  { label: 'すべて', value: 'all' },
  ...RETURN_DISPLAY_STATUSES.map((status) => ({ label: RETURN_DISPLAY_STATUS_LABELS[status], value: status })),
];

function isReturnFilterValue(value: string): value is ReturnFilterValue {
  return RETURN_FILTER_OPTIONS.some((option) => option.value === value);
}

/** 一覧の窓口が返す、一覧の上の一行の件数。返品がある注文の数（返品の数ではない。同じ注文に返品が2つあっても1件）で、全体の数。今のページの数ではない */
type ReturnAttention = { requested: number; refundWaiting: number };

type ForbiddenErrorBody = {
  reason?: string;
};


// 返金・キャンセルを受け付けた後に、一覧の上へ出す知らせ。保留は、お金が戻り終えるまで注文の状態が変わらない
const REFUND_NOTICES = {
  pending: '返金を受け付けました。お金が戻ると、注文の状態が変わります。',
  succeeded: '返金しました。',
} as const;
const PAID_CANCEL_NOTICES = {
  pending: 'キャンセルを受け付けました。返金が済むと、注文がキャンセルになります。',
  succeeded: '注文をキャンセルし、返金しました。',
} as const;

// 取消・解決で Stripe の状態を確かめられなかった（503）。一覧を更新しても直らないので、再試行を案内する
const STRIPE_UNAVAILABLE_MESSAGE = 'Stripe の状態を確認できませんでした。時間をおいて再試行してください。';

// 要対応・要確認の操作で、通信が切れた時の文（fetch の英語の文を出さない。届いたか分からないので、欄を読み直させる）
const ATTENTION_NETWORK_ERROR_MESSAGE = '通信できませんでした。一覧を更新してください。';

// 品を外して解決を待つ申し込み（「品を外す」で画面を開いてから、返金・キャンセルが受け付けられるまで）。
// 画面を閉じた時と、一覧の「返金」などの別の操作を始めた時は外す（後で別の返金をしても、この申し込みを解決しないため）
type PendingCancelResolve = {
  cancelRequestId: string;
  orderId: string;
  mode: RemoveItemsRequest['mode'];
  lines: RemoveItemsRequest['lines'];
};

// 一覧の上の一行に並べる物。返品の数（押すと返品の絞り込み）に続けて、開いているキャンセルの申し込みの数（押すとその絞り込み）を並べる
type AttentionPiece =
  | { kind: 'return'; filter: 'requested' | 'refund_waiting'; label: string }
  | { kind: 'cancel_request'; label: string };

// 品を外した返金・キャンセルの後の、申し込みの解決（C-5）。解決の知らせは、返金・取消の知らせに続けて同じ段落に出す
const CANCEL_REQUEST_RESOLVED_NOTICE = 'キャンセルの申し込みを解決しました。';
const CANCEL_REQUEST_RESOLVE_FAILED_MESSAGE =
  '返金・キャンセルは記録しましたが、申し込みを解決済みにできませんでした。キャンセルの申し込みの画面で「解決済みにする」を押してください。';

// readableStatuses: 窓口が日本語の文を返す断りの番号。配送の要対応を閉じる窓口は 404（見つかりません）も日本語の文を返す
async function readSafeOrderActionError(
  response: Response,
  fallback: string,
  readableStatuses: readonly number[] = [400, 409],
): Promise<string> {
  if (!readableStatuses.includes(response.status)) {
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

const ORDER_CSV_HEADERS = ['注文ID', '顧客名', '顧客メール', '注文日', '購入商品', '商品数', '合計金額', '進み具合', '支払い', '返金額', '返品'] as const;

// 返品の交換で足された品の行の印（一覧の購入商品の欄と同じ言葉。C-5）
const EXCHANGE_ITEM_CSV_SUFFIX = '（交換の品）';

// 発送準備中の数だけ書く。もう送った品と、まだ作っている品を詰めないため（設計書 9-1）。交換の品の行は末尾に「（交換の品）」を付ける
function formatOrderItems(items: OrderItem['items']): string {
  return items
    .filter((item) => item.readyUnshipped > 0)
    .map((item) => `${item.name} x${item.readyUnshipped}${item.lineKind === 'exchange' ? EXCHANGE_ITEM_CSV_SUFFIX : ''}`)
    .join(' / ');
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
  const [completionOrderId, setCompletionOrderId] = useState<string | null>(null);
  const [historyOrderId, setHistoryOrderId] = useState<string | null>(null);
  const [reviewOnly, setReviewOnly] = useState(false);
  const [attention, setAttention] = useState<AdminOrderAttention | null>(null);
  // 読み込みの失敗と、要対応・要確認の操作が断られた理由。欄のすぐ下に出す（OrderSection のエラーは一覧の下で、読み直しで消える）
  const [attentionErrorMessage, setAttentionErrorMessage] = useState<string | null>(null);
  const [processingAttentionIds, setProcessingAttentionIds] = useState<string[]>([]);
  const [cancelTarget, setCancelTarget] = useState<OrderItem | null>(null);
  const [cancelSubmitting, setCancelSubmitting] = useState(false);
  const [refundOrderId, setRefundOrderId] = useState<string | null>(null);
  const [paidCancelOrderId, setPaidCancelOrderId] = useState<string | null>(null);
  const [returnFilter, setReturnFilter] = useState<ReturnFilterValue>('all');
  const [returnAttention, setReturnAttention] = useState<ReturnAttention | null>(null);
  const [returnsOrderId, setReturnsOrderId] = useState<string | null>(null);
  const [cancelRequestFilter, setCancelRequestFilter] = useState(false);
  const [cancelRequestAttention, setCancelRequestAttention] = useState(0);
  const [cancelRequestOrderId, setCancelRequestOrderId] = useState<string | null>(null);
  const [pendingResolve, setPendingResolve] = useState<PendingCancelResolve | null>(null);

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

  // 伝票番号を直す・配達済みにする・配送の要対応を閉じる（窓口の権限は admin.orders.manage）。店長とサポートの人だけ。
  // 返金の権限（店長だけ）とは別に決め、返金の入口は広げない
  const canManageDelivery = userRole === 'admin' || userRole === 'supporter';

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

  // 一覧を読んだ番号。絞り込みやページを続けて変えると読みが重なるので、使うのは最後に始めた読みの答えだけにする
  // （遅れて返った古い条件の答えが、新しい条件の一覧を上書きしないため）
  const ordersRequestSeq = useRef(0);

  const fetchOrders = useCallback(async (nextPage?: number) => {
    const requestId = ++ordersRequestSeq.current;
    const isLatestRequest = () => requestId === ordersRequestSeq.current;

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

      // 2つ以上選んだ時は status を送らず、下の displayedOrders が DB の状態（orderStatus）で絞る
      const selectedStatus = orderStatusFilters.length === 1 ? orderStatusFilters[0] : 'all';
      if (selectedStatus !== 'all') {
        query.set('status', selectedStatus);
      }

      if (reviewOnly) {
        query.set('review', 'only');
      }

      if (cancelRequestFilter) {
        query.set('cancelRequest', 'open');
      }

      if (returnFilter !== 'all') {
        query.set('return', returnFilter);
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
        returnAttention?: ReturnAttention;
        cancelRequestAttention?: number;
      };

      // 後から始めた読みがあれば、この答えは捨てる（一覧・件数・ページ・一行の数・誤り・読み込み中の表示は、その新しい読みが決める）
      if (isLatestRequest()) {
        setOrders(json.data ?? []);
        setOrdersPage(json.pagination?.page ?? page);
        setOrdersTotalPages(json.pagination?.totalPages ?? 1);
        setOrdersTotalCount(json.pagination?.total ?? 0);
        setReturnAttention(json.returnAttention ?? null);
        const nextCancelRequestAttention = json.cancelRequestAttention ?? 0;
        setCancelRequestAttention(nextCancelRequestAttention);
        // 開いている申し込みが無くなったら絞り込みを外す（0件の数は出さないので、外す手段が無いまま空の一覧が残るため）
        if (nextCancelRequestAttention === 0) {
          setCancelRequestFilter(false);
        }
      }
      return true;
    } catch (error) {
      console.error('Failed to fetch admin orders:', error);
      if (isLatestRequest()) {
        setOrdersErrorMessage(error instanceof Error ? error.message : '注文一覧の取得に失敗しました。');
      }
      return false;
    } finally {
      // 捨てた読みが読み込み中の表示を消すと、新しい読みの途中なのに古い一覧が見える
      if (isLatestRequest()) {
        setIsOrdersLoading(false);
      }
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
    returnFilter,
    cancelRequestFilter,
  ]);

  // 窓口の返事を待つ間に絞り込みやページが変わっても、返事の後の読み直しは今の条件で頼む。
  // 操作を始めた時点の fetchOrders は古い条件を閉じ込めているので、返事の後は、この ref に置いた最新の関数を呼ぶ
  const fetchOrdersRef = useRef(fetchOrders);
  useLayoutEffect(() => {
    fetchOrdersRef.current = fetchOrders;
  }, [fetchOrders]);

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
      const json = (await response.json()) as { data?: Partial<AdminOrderAttention> };
      const data = json.data;
      if (!data || !Array.isArray(data.exceptions) || !Array.isArray(data.reviews) || !data.counts) {
        throw new Error('Unexpected order attention response');
      }
      setAttention(data as AdminOrderAttention);
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

  // 配送の要対応も店が動く物なので、サイドナビの印と KPI の帯の数に入れる（窓口が付けない昔の形は 0 件）
  const deliveryAttentionCount = attention?.counts.deliveries ?? 0;
  const attentionTotal =
    (attention?.counts.exceptions ?? 0) + (attention?.counts.reviews ?? 0) + deliveryAttentionCount;

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
    () => orders.filter((order) => order.orderStatus === 'pending').length,
    [orders],
  );

  // 発送待ち＝DB の状態が決済完了（受注生産中・発送準備中。一部を送った注文も含む）
  const awaitingShipmentCount = useMemo(
    () => orders.filter((order) => order.orderStatus === 'paid').length,
    [orders],
  );

  const displayedOrders = useMemo(() => {
    const normalizedKeyword = orderSearchKeyword.trim().toLowerCase();
    const hasAllFilter = orderStatusFilters.includes('all');

    return orders.filter((order) => {
      const matchesStatus = hasAllFilter
        ? true
        : orderStatusFilters.some((filter) => filter === order.orderStatus);
      const matchesKeyword =
        normalizedKeyword.length === 0
          ? true
          : [order.id, order.customerName, order.customerEmail].some((value) =>
              value.toLowerCase().includes(normalizedKeyword),
            );

      return matchesStatus && matchesKeyword;
    });
  }, [orders, orderSearchKeyword, orderStatusFilters]);

  // 支払い済みの注文のキャンセルは返金を伴うので、返金と同じく店長だけに出す（設計書 5-4。返金のボタンも店長だけ）。
  // 一覧の窓口は役割に関係なく canCancel を返すので、ここで店長でない人の分を false にする。
  // 件数と CSV は displayedOrders のまま。ボタンを出すかだけを役割で変える。未入金の注文の取消は、サポートの人もできる
  const listedOrders = useMemo(
    () =>
      userRole === 'admin'
        ? displayedOrders
        : displayedOrders.map((order) => (order.cancelKind === 'paid' ? { ...order, canCancel: false } : order)),
    [displayedOrders, userRole],
  );

  // 一覧の上の一行の中身。0件の数は出さず（段1は返品の申し込みがいつも0件なので、返金待ちだけが出る。P13）、両方0件なら空
  const returnAttentionPieces = useMemo(() => {
    if (!returnAttention) {
      return [];
    }
    const pieces: Array<{ filter: 'requested' | 'refund_waiting'; count: number }> = [
      { filter: 'requested', count: returnAttention.requested },
      { filter: 'refund_waiting', count: returnAttention.refundWaiting },
    ];
    return pieces
      .filter((piece) => piece.count > 0)
      .map((piece) => ({ filter: piece.filter, label: `${RETURN_DISPLAY_STATUS_LABELS[piece.filter]} ${piece.count}件` }));
  }, [returnAttention]);

  // 一行に並べる物。返品の数に続けて、開いているキャンセルの申し込みの数を並べる（0件は出さない）
  const attentionPieces = useMemo<AttentionPiece[]>(
    () => [
      ...returnAttentionPieces.map((piece): AttentionPiece => ({ kind: 'return', filter: piece.filter, label: piece.label })),
      ...(cancelRequestAttention > 0
        ? [{ kind: 'cancel_request', label: `キャンセルの申し込み ${cancelRequestAttention}件` } satisfies AttentionPiece]
        : []),
    ],
    [returnAttentionPieces, cancelRequestAttention],
  );

  // 絞り込みを変えたら1ページ目から読む（ほかの絞り込みと同じ）
  const handleReturnFilterChange = (value: string) => {
    setOrdersPage(1);
    setReturnFilter(isReturnFilterValue(value) ? value : 'all');
  };

  // 一行の数を押すと、その絞り込みにする。数は全体の注文の数なので、ほかの絞り込み（状態・要確認のみ・取引先・注文・決済ID・金額・期間）は
  // 全部外して、数と一覧を合わせる（Shopify の件数のリンクと同じ）。同じ数をもう一度押すと、返品の絞り込みだけを外す（押している印は aria-pressed）。
  // handleClearPeriodFilter は下で定義している（押した時に呼ぶので、並びは関係ない）
  const handleReturnAttentionToggle = (filter: ReturnDisplayStatus) => {
    setOrdersPage(1);
    if (returnFilter === filter) {
      setReturnFilter('all');
      return;
    }
    setReturnFilter(filter);
    setCancelRequestFilter(false);
    setOrderStatusFilters(['all']);
    setReviewOnly(false);
    setOrderSearchKeyword('');
    setOrderReference('');
    setOrderAmountMin('');
    setOrderAmountMax('');
    handleClearPeriodFilter();
  };

  // キャンセルの申し込みの数を押すと、その絞り込みにする。数は全体の注文の数なので、返品の数と同じく、ほかの絞り込みを全部外して
  // 数と一覧を合わせる。もう一度押すと、この絞り込みだけを外す（押している印は aria-pressed）。
  // handleClearPeriodFilter は下で定義している（押した時に呼ぶので、並びは関係ない）
  const handleCancelRequestAttentionToggle = () => {
    setOrdersPage(1);
    if (cancelRequestFilter) {
      setCancelRequestFilter(false);
      return;
    }
    setCancelRequestFilter(true);
    setReturnFilter('all');
    setOrderStatusFilters(['all']);
    setReviewOnly(false);
    setOrderSearchKeyword('');
    setOrderReference('');
    setOrderAmountMin('');
    setOrderAmountMax('');
    handleClearPeriodFilter();
  };

  const handleStatusFilterToggle = (nextFilter: OrderStatusFilterValue) => {
    setOrderStatusFilters((prev) => {
      if (nextFilter === 'all') {
        return ['all'];
      }

      // 放棄は status を送って初めて読める（既定の一覧は放棄を除き、2つ以上の選択は status を送らない）。
      // 他の状態と一緒に選ばせない: 選ぶと他の選択が外れ、他の状態を選ぶと放棄が外れる
      if (nextFilter === 'abandoned') {
        return prev.includes('abandoned') ? ['all'] : ['abandoned'];
      }

      const nextValues = prev.filter((value) => value !== 'all' && value !== 'abandoned');

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
    setPendingResolve(null);
    // 支払い済みの注文のキャンセルは返金を伴うので、材料を読む新しい画面を開く。未入金の注文の取消は今の画面のまま
    if (order.cancelKind === 'paid') {
      setPaidCancelOrderId(order.id);
      return;
    }
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
      // キャンセルの申し込みの「品を外す」から開いた取消なら、取り消せた後に申し込みを解決する
      const resolveTarget = pendingResolve?.mode === 'unpaid_cancel' && pendingResolve.orderId === target.id ? pendingResolve : null;
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
            ? { ...order, status: 'キャンセル', orderStatus: 'cancelled', canCancel: false, cancelBlockedUntil: null }
            : order,
        ),
      );
      const cancelledNotice = '注文を取り消しました。';
      setOrdersNoticeMessage(cancelledNotice);
      if (resolveTarget) {
        setPendingResolve(null);
        void resolveCancelRequest(resolveTarget, { refundId: null, orderCancelled: true }, cancelledNotice);
      }
      void fetchAttention();
    } catch (error) {
      console.error('Failed to cancel order:', error);
      setOrdersErrorMessage(error instanceof Error ? error.message : '注文ステータスの更新に失敗しました。');
    } finally {
      // 閉じるのは、この送信の注文の画面だけ。送信中に画面を閉じて別の注文の画面を開いていたら、その画面は閉じない
      setCancelTarget((current) => (current?.id === target.id ? null : current));
      setPendingResolve((current) => (current?.mode === 'unpaid_cancel' && current.orderId === target.id ? null : current));
      setCancelSubmitting(false);
      updateProcessingOrder(target.id, false);
    }
  };

  /**
   * 要対応・要確認の操作。成功したら欄と一覧を読み直す。断られたら理由を欄のすぐ下に出す（行は残し、押し直せる）。
   * 送っている間は id を操作中に置き、成功でも失敗でも finally で外す。
   */
  const runAttentionAction = async (
    id: string,
    request: () => Promise<Response>,
    successMessage: string,
    failure: { readableStatuses?: readonly number[]; rateLimitedMessage?: string } = {},
  ) => {
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
        if (response.status === 429 && failure.rateLimitedMessage) {
          throw new Error(failure.rateLimitedMessage);
        }
        throw new Error(
          await readSafeOrderActionError(response, '操作に失敗しました。一覧を更新してください。', failure.readableStatuses),
        );
      }

      setOrdersNoticeMessage(successMessage);
      await Promise.all([fetchAttention(), fetchOrdersRef.current()]);
    } catch (error) {
      console.error('Failed to update order attention:', error);
      // 通信が切れた（fetch の TypeError。英語の文）時は日本語の文にする。要対応・要確認のどの操作も、この catch を通る
      setAttentionErrorMessage(
        error instanceof TypeError ? ATTENTION_NETWORK_ERROR_MESSAGE : error instanceof Error ? error.message : '操作に失敗しました。',
      );
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
    setShipOrderId(id);
  };

  const openCompletionDialog = (id: string) => {
    setOrdersNoticeMessage(null);
    setCompletionOrderId(id);
  };

  // 発送・仕上がりの画面は自分で窓口を呼ぶ。成功したら、ここで一覧を読み直す（手元で言葉を書き換えない）。
  // 閉じるのは、その操作の注文の画面だけ（返事を待つ間に別の注文の画面を開いていたら、その画面は閉じない）
  const handleShipped = (id: string) => {
    setShipOrderId((current) => (current === id ? null : current));
    void fetchOrdersRef.current();
  };

  const handleCompletionRecorded = (id: string) => {
    setCompletionOrderId((current) => (current === id ? null : current));
    setOrdersNoticeMessage(COMPLETION_RECORDED_MESSAGE);
    void fetchOrdersRef.current();
  };

  // 履歴の画面で発送か仕上がりを取り消した・伝票番号を直した・配達済みにした（結果が分からない時も）。履歴の画面は開いたまま、一覧を読み直す。
  // 伝票番号を直す・配達済みにすると、開いていた配送の要対応が閉じるので、要対応の欄も読み直す
  const handleFulfillmentChanged = () => {
    void fetchOrdersRef.current();
    void fetchAttention();
  };

  // 配送の要対応を対応済みにする。成功したら欄と一覧を読み直し、全部閉じれば「配送」の組が消える（もう閉じてあった時も同じ）
  const handleResolveDelivery = (attentionId: string) =>
    void runAttentionAction(
      attentionId,
      () =>
        clientFetch(`/api/admin/order-attention/deliveries/${attentionId}/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
      '対応済みにしました。',
      // 窓口は、見つからない（404）も日本語の文で返す。回数の制限（429）は、画面の案内（計画の C-4）にする
      { readableStatuses: [400, 404, 409], rateLimitedMessage: 'しばらくしてから、もう一度お試しください。' },
    );

  // 返金の画面を開く。返金は画面の中で窓口を呼ぶ（確認の文を出して残りを全部返す作りはやめた）
  const handleRefundOrder = (id: string) => {
    setOrdersNoticeMessage(null);
    setPendingResolve(null);
    setRefundOrderId(id);
  };

  // 返金の画面・支払い済みのキャンセルの画面は自分で窓口を呼ぶ。受け付けたら、ここで知らせを出して、一覧と要対応を読み直す
  // （手元で言葉を書き換えない。返金で自動で解決する要対応があるので、要対応も読み直す）。
  // 2つの画面は送っている間は閉じられないので、受け付けた時に開いているのは、その操作の画面
  const handleRefunded = (result: RefundAcceptedResponse) => {
    setRefundOrderId(null);
    const refundNotice = result.status === 'succeeded' ? REFUND_NOTICES.succeeded : REFUND_NOTICES.pending;
    setOrdersNoticeMessage(refundNotice);
    // キャンセルの申し込みの「品を外す」から開いた画面なら、返金の番号で申し込みを解決する
    resolveAfterRefund('refund', result.refundId, refundNotice);
    void fetchOrdersRef.current();
    void fetchAttention();
  };

  const handlePaidCancelled = (result: RefundAcceptedResponse) => {
    setPaidCancelOrderId(null);
    const cancelNotice = result.status === 'succeeded' ? PAID_CANCEL_NOTICES.succeeded : PAID_CANCEL_NOTICES.pending;
    setOrdersNoticeMessage(cancelNotice);
    resolveAfterRefund('paid_cancel', result.refundId, cancelNotice);
    void fetchOrdersRef.current();
    void fetchAttention();
  };

  // 答えが分からないまま画面を閉じた。返金が頼まれたかもしれないので、一覧だけ読み直す（知らせは出さない）
  const handleRefundUncertain = () => {
    void fetchOrdersRef.current();
  };

  // 返品の画面を開く（一覧の「返品」と、要対応の返品の返金の失敗の「もう一度返金する」から）。受け取り・返金・取消などは画面の中で
  // 窓口を呼ぶ。何かを変えたら、ここで一覧と要対応を読み直し（返品の返金が失敗すると要対応が増える）、閉じた時にも一覧を読み直す
  // （答えが分からないまま閉じた時など、変えたかどうかを画面が知らせない場合のため）
  const handleShowReturns = (id: string) => {
    setOrdersNoticeMessage(null);
    setReturnsOrderId(id);
  };

  const handleReturnsChanged = () => {
    void fetchOrdersRef.current();
    void fetchAttention();
  };

  const handleReturnsClosed = () => {
    setReturnsOrderId(null);
    void fetchOrdersRef.current();
  };

  // キャンセルの申し込みの画面を開く（一覧の「キャンセルの申し込み」のボタンから。店長もサポートの人も）
  const handleShowCancelRequest = (id: string) => {
    setOrdersNoticeMessage(null);
    setCancelRequestOrderId(id);
  };

  // お断り・解決済みにした。開いている申し込みは注文に1つだけなので、続けて扱う物が無い。画面を閉じ、知らせを出して一覧を読み直す
  // （開いている申し込みの印と、一覧の上の一行の数が変わるため）
  const handleCancelRequestChanged = (notice: string) => {
    setCancelRequestOrderId(null);
    setOrdersNoticeMessage(notice);
    void fetchOrdersRef.current();
  };

  /**
   * 品を外した返金・キャンセルが受け付けられた後に、その申し込みを解決する窓口を呼ぶ（P11）。baseNotice は返金・取消の知らせで、
   * 解決の知らせを同じ段落に続ける。失敗しても返金・キャンセルは済んでいて、申し込みは開いたまま残る。申し込みの画面の「解決済みにする」で
   * 閉じられるので、その案内（C-5）を出す。どちらの場合も、開いている申し込みの印と一行の数が変わるので一覧を読み直す
   */
  const resolveCancelRequest = async (
    pending: PendingCancelResolve,
    outcome: { refundId: string | null; orderCancelled: boolean },
    baseNotice: string,
  ) => {
    let resolved = false;
    try {
      const response = await clientFetch(`/api/admin/cancel-requests/${pending.cancelRequestId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(outcome),
      });
      if (!response.ok) {
        throw new Error(`Failed to resolve cancel request: ${response.status}`);
      }
      resolved = true;
    } catch (error) {
      console.error('Failed to resolve cancel request:', error);
    }
    // 一覧の読み直し（fetchOrders）は、先頭で誤りの文を消す。先に読み直しを始めてから文を出す
    // （逆にすると、出した失敗の文がその場で消え、返金は済んだのに申し込みが開いたままであることを知らせられない）
    void fetchOrdersRef.current();
    if (resolved) {
      setOrdersNoticeMessage(`${baseNotice}${CANCEL_REQUEST_RESOLVED_NOTICE}`);
    } else {
      setOrdersErrorMessage(CANCEL_REQUEST_RESOLVE_FAILED_MESSAGE);
    }
  };

  // 返金の画面・支払い済みのキャンセルの画面が受け付けられた。「品を外す」から開いた画面（同じ種類の mode）なら、答えの返金の番号で
  // 申し込みを解決する。一覧の「返金」などから開いた画面は pendingResolve が空なので、何もしない
  const resolveAfterRefund = (mode: 'refund' | 'paid_cancel', refundId: string, baseNotice: string) => {
    if (!pendingResolve || pendingResolve.mode !== mode) {
      return;
    }
    setPendingResolve(null);
    void resolveCancelRequest(pendingResolve, { refundId, orderCancelled: false }, baseNotice);
  };

  // 「品を外す」。画面は重ねない（Esc で下の画面が閉じる）ので、申し込みの画面を閉じてから、取消・支払い済みのキャンセル・返金の画面を開く。
  // 解決は、その画面で返金・キャンセルが受け付けられた後に呼ぶ（pendingResolve）。取消の画面は一覧の行から作るので、行が一覧に無い時は
  // 開かず、申し込みの画面を閉じて一覧を読み直し、案内を出す（何も言わずに終えると、押しても何も変わらず理由も出ない）
  const handleRemoveItems = (request: RemoveItemsRequest) => {
    const orderId = cancelRequestOrderId;
    const order = orders.find((item) => item.id === orderId);
    if (!orderId) {
      return;
    }
    if (request.mode === 'unpaid_cancel' && !order) {
      setCancelRequestOrderId(null);
      // 読み直し（fetchOrders）は先頭で誤りの文を消すので、先に読み直しを始めてから文を入れる（resolveCancelRequest と同じ）
      void fetchOrdersRef.current();
      setOrdersErrorMessage('操作に失敗しました。一覧を更新してください。');
      return;
    }
    setOrdersNoticeMessage(null);
    setOrdersErrorMessage(null);
    setCancelRequestOrderId(null);
    setPendingResolve({ cancelRequestId: request.cancelRequestId, orderId, mode: request.mode, lines: request.lines });
    if (request.mode === 'unpaid_cancel') {
      setCancelTarget(order ?? null);
    } else if (request.mode === 'paid_cancel') {
      setPaidCancelOrderId(orderId);
    } else {
      setRefundOrderId(orderId);
    }
  };

  // 返金・キャンセルの画面を閉じた（しなかった）。解決を待つ申し込みも外す（後で一覧の「返金」などで返金しても、この申し込みを解決しないため）
  const closeRefundDialog = () => {
    setRefundOrderId(null);
    setPendingResolve(null);
  };

  const closePaidCancelDialog = () => {
    setPaidCancelOrderId(null);
    setPendingResolve(null);
  };

  const closeCancelDialog = () => {
    setCancelTarget(null);
    setPendingResolve(null);
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
    // 発送待ち（DB の状態が決済完了）の注文だけ書き出す。商品の欄は発送準備中の数（formatOrderItems）
    const filtered = displayedOrders.filter((o) => o.orderStatus === 'paid');

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
        order.paymentStatusKey ? PAYMENT_STATUS_LABELS[order.paymentStatusKey] : '',
        order.refundedAmountLabel ?? '',
        // 返品の状態の言葉だけを書く（小さな印は書かない）。返品の無い注文は空
        order.returnSummary?.displayStatus ? RETURN_DISPLAY_STATUS_LABELS[order.returnSummary.displayStatus] : '',
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
                  aria-pressed={orderStatusFilters.includes(statusFilter.value)}
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
                message={`要対応${attention?.counts.exceptions ?? 0}件・要確認${attention?.counts.reviews ?? 0}件${deliveryAttentionCount > 0 ? `・配送 ${deliveryAttentionCount}件` : ''}（ORDER で確認）`}
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
      case 'SETTINGS':
        if (userRole !== 'admin') return null;
        return <ShopSettingsSection />;
      case 'ORDER':
        return (
          <div className="space-y-4">
            {attention?.emailSending?.paused === true ? (
              <BannerAlert
                variant="error"
                title="お客様への注文のメールの送信を止めています"
                description={`原因: ${attention.emailSending.reasonLabel ?? '不明'}。原因を直すと、15分ごとに1件ずつ試して自動で再開します（1日の送信の上限の時は日本時間 9時から）。手順は「注文のメールの手順書」の「送信の一時停止」にあります。`}
              />
            ) : null}
            <AttentionInbox
              attention={attention}
              processingIds={processingAttentionIds}
              onReview={handleReviewOrder}
              onResolve={handleResolveException}
              onCancelAndResolve={handleCancelAndResolve}
              onRetryRefund={userRole === 'admin' ? handleRefundOrder : undefined}
              onRetryReturnRefund={userRole === 'admin' ? handleShowReturns : undefined}
              onOpenDeliveryHistory={setHistoryOrderId}
              onResolveDelivery={canManageDelivery ? handleResolveDelivery : undefined}
            />
            {attentionErrorMessage ? (
              <p role="alert" className="lk-text-sm text-red-700 font-acumin">{attentionErrorMessage}</p>
            ) : null}
            {attentionPieces.length > 0 ? (
              <div data-testid="return-attention" className="flex flex-wrap items-center gap-x-1 lk-text-sm text-[#474747] font-acumin">
                {attentionPieces.map((piece, index) => (
                  <Fragment key={piece.kind === 'return' ? piece.filter : piece.kind}>
                    {index > 0 ? <span aria-hidden="true">・</span> : null}
                    <Button
                      variant="link"
                      size="sm"
                      className="font-acumin"
                      aria-pressed={piece.kind === 'return' ? returnFilter === piece.filter : cancelRequestFilter}
                      onClick={() => (piece.kind === 'return' ? handleReturnAttentionToggle(piece.filter) : handleCancelRequestAttentionToggle())}
                    >
                      {piece.label}
                    </Button>
                  </Fragment>
                ))}
              </div>
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
                <div className="w-44">
                  <SingleSelect
                    label="返品"
                    size="sm"
                    options={RETURN_FILTER_OPTIONS}
                    value={returnFilter}
                    onChange={(event) => handleReturnFilterChange(event.target.value)}
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
                  <span className="text-[#474747]">発送待ち: {awaitingShipmentCount}</span>
                </div>
              </div>
            </div>
            {periodErrorMessage ? <p className="lk-text-sm text-red-700 font-acumin">{periodErrorMessage}</p> : null}
            <OrderSection
              orders={listedOrders}
              isLoading={isOrdersLoading}
              errorMessage={ordersErrorMessage}
              noticeMessage={ordersNoticeMessage}
              onCancelOrder={handleCancelOrder}
              onRefundOrder={userRole === 'admin' ? handleRefundOrder : undefined}
              onShipOrder={openShipDialog}
              onRecordCompletion={openCompletionDialog}
              onShowHistory={setHistoryOrderId}
              onShowReturns={handleShowReturns}
              onShowCancelRequest={handleShowCancelRequest}
              canRefundReturn={userRole === 'admin'}
              processingOrderIds={processingOrderIds}
            />
            <OrderShipDialog
              orderId={shipOrderId}
              onClose={() => setShipOrderId(null)}
              onShipped={() => {
                if (shipOrderId) handleShipped(shipOrderId);
              }}
            />
            <OrderCompletionDialog
              orderId={completionOrderId}
              onClose={() => setCompletionOrderId(null)}
              onRecorded={() => {
                if (completionOrderId) handleCompletionRecorded(completionOrderId);
              }}
            />
            <OrderHistoryDialog
              orderId={historyOrderId}
              onClose={() => setHistoryOrderId(null)}
              onChanged={handleFulfillmentChanged}
              canManageDelivery={canManageDelivery}
            />
            <OrderRefundDialog
              orderId={refundOrderId}
              prefillBeforeShipment={
                pendingResolve?.mode === 'refund' && pendingResolve.orderId === refundOrderId ? pendingResolve.lines : undefined
              }
              onClose={closeRefundDialog}
              onRefunded={handleRefunded}
              onUncertain={handleRefundUncertain}
            />
            <OrderPaidCancelDialog
              orderId={paidCancelOrderId}
              onClose={closePaidCancelDialog}
              onCancelled={handlePaidCancelled}
              onUncertain={handleRefundUncertain}
            />
            {cancelRequestOrderId ? (
              <OrderCancelRequestDialog
                orderId={cancelRequestOrderId}
                open
                canRefund={userRole === 'admin'}
                onClose={() => setCancelRequestOrderId(null)}
                onChanged={handleCancelRequestChanged}
                onRemoveItems={handleRemoveItems}
              />
            ) : null}
            {returnsOrderId ? (
              <OrderReturnsDialog
                orderId={returnsOrderId}
                canRefund={userRole === 'admin'}
                open
                onClose={handleReturnsClosed}
                onChanged={handleReturnsChanged}
              />
            ) : null}
            <OrderCancelDialog
              open={cancelTarget !== null}
              title="注文を取り消す"
              targetLabel={cancelTarget?.id ?? ''}
              showNotifyOption={cancelTarget?.status !== '決済失敗'}
              noteRequired={false}
              submitting={cancelSubmitting}
              onClose={closeCancelDialog}
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
