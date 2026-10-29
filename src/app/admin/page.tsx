// ----------------- 管理ダッシュボード -----------------
'use client';

import { Suspense, useMemo, useState, useEffect, useCallback, useRef } from 'react';
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
import ContactSection from '@/components/ContactSection';
import DiscountSection from '@/components/DiscountSection';
import UserSection from '@/components/UserSection';
import ShopSettingsSection from '@/components/ShopSettingsSection';
import { BannerAlert } from '@/components/ui/BannerAlert/BannerAlert';
import { Button } from '@/components/ui/Button/Button';
import { useOrderAttention } from '@/hooks/useOrderAttention';

type ForbiddenErrorBody = {
  reason?: string;
};

// SETTINGS（ショップの設定）は店長だけ。サポートの人の supporterTabs には足さない（窓口も権限 admin.settings.manage で守る）
// INVENTORY（在庫一覧表・発注一覧表への入口）と PACKING（荷作り表への入口）は店長とサポートの人の両方に同じ中身を出す。権限の無い人が開いた先は、各頁の権限の文（窓口と DB が守る）
// ORDER（注文一覧表への入口。G-4）も同じ。注文の一覧・要対応の欄・各操作は /admin/orders と /admin/orders/[id] にある
// CONTACT（問い合わせの一覧・返信。FR-ADMIN-009）も店長とサポートの人の両方に出す。権限の無い人は窓口（admin.contact.read/manage）が 403 を返す
// DISCOUNT（割引の一覧。グループ H / FREQ-547）も CONTACT の直後に両方へ出す。権限の無い人（サポートの人の初期）は一覧が権限の文を出し、窓口（admin.discounts.read）が 403 を返す
const allAdminTabs: TabType[] = ['KPI', 'ACCOUNTING', 'NEWS', 'ITEM', 'LOOK', 'STOCKIST', 'USER', 'ORDER', 'INVENTORY', 'PACKING', 'CONTACT', 'DISCOUNT', 'SETTINGS'];
const supporterTabs: TabType[] = ['ORDER', 'INVENTORY', 'PACKING', 'CONTACT', 'DISCOUNT'];

function AdminPageContent() {
  const { isLoggedIn, isAuthResolved, userRole, isMfaVerified } = useLogin();
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState<TabType>('KPI');
  const [kpiData, setKpiData] = useState<AdminKpiData | null>(null);
  const [isKpiLoading, setIsKpiLoading] = useState(false);
  const [kpiErrorMessage, setKpiErrorMessage] = useState<string | null>(null);

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
      // 関数で渡す。最初の描画では上の effect が URL の tab を先に積むので、その値（サポートの人の tab=INVENTORY など）を上書きしない
      setActiveTab((current) => (visibleTabs.includes(current) ? current : visibleTabs[0]));
    }
  }, [activeTab, visibleTabs, canAccessAdmin]);

  // 要対応・要確認（設計書 5-2）の件数。サイドナビのバッジと KPI 画面の帯に使う。欄と操作は注文一覧表（/admin/orders）にある
  const attentionEnabled = canAccessAdmin && isMfaVerified;
  const { attention, reload: reloadAttention } = useOrderAttention({ enabled: attentionEnabled });

  // タブを移るたびに読み直す（開きっぱなしの間も、サイドナビのバッジと KPI の帯を新しく保つ）。
  // 最初の読みは hook が頁を開いた時に行うので、最初のタブの値では読まない
  const attentionTabRef = useRef(activeTab);
  useEffect(() => {
    if (attentionTabRef.current === activeTab) {
      return;
    }

    attentionTabRef.current = activeTab;
    if (attentionEnabled) {
      void reloadAttention();
    }
  }, [activeTab, attentionEnabled, reloadAttention]);

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
      // LOOK の「新規作成」は LookSection が窓口の meta.canManage で出す（役でなく権限。SEC-LOOK-019-AC-04）
      case 'STOCKIST':
        if (userRole !== 'admin') return null;
        return (
          <Button href="/admin/stockist/create" variant="primary" size="sm" className="font-acumin">
            新規作成
          </Button>
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
      case 'INVENTORY':
        return (
          <nav aria-label="在庫・発注メニュー" className="flex flex-wrap gap-3">
            <Button href="/admin/inventory" variant="secondary">在庫一覧表</Button>
            <Button href="/admin/purchase-orders" variant="secondary">発注一覧表</Button>
          </nav>
        );
      case 'PACKING':
        return (
          <nav aria-label="荷作りメニュー" className="flex flex-wrap gap-3">
            <Button href="/admin/packing" variant="secondary">荷作り表</Button>
          </nav>
        );
      case 'SETTINGS':
        if (userRole !== 'admin') return null;
        return (
          <div className="space-y-6">
            <nav aria-label="設定メニュー">
              <Button href="/admin/settings/permissions" variant="secondary">権限</Button>
            </nav>
            <ShopSettingsSection />
          </div>
        );
      case 'ORDER':
        return (
          <nav aria-label="注文メニュー" className="flex flex-wrap gap-3">
            <Button href="/admin/orders" variant="secondary">注文一覧表</Button>
          </nav>
        );
      case 'CONTACT':
        return <ContactSection />;
      case 'DISCOUNT':
        return <DiscountSection />;
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
