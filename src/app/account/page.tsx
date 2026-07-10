"use client";

import Image from "next/image";
import Link from "next/link";
import React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useLogin } from "@/contexts/LoginContext";
import { Button } from "@/components/ui/Button/Button";
import { TabSegmentControl } from "@/components/ui/TabSegmentControl/TabSegmentControl";
import { TextField } from "@/components/ui/TextField/TextField";
import { SingleSelect } from "@/components/ui/SingleSelect/SingleSelect";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import AccountInquiries from "@/components/AccountInquiries";
import { formatOrderStatus } from "@/lib/orders/order-status";
import { PREFECTURES } from "@/lib/constants/prefectures";
import { clientFetch } from "@/lib/client-fetch";
import { formatPhoneNumberInput } from "@/features/account/utils/profile-format.util";
import {
  formatPostalCodeInput,
  normalizePostalCode,
} from "@/features/checkout/utils/postal-code.util";
import "./account.css";

type AccountTab = "profile" | "shipping" | "orders" | "inquiries";

type ProfileAddress = {
  postalCode: string;
  prefecture: string;
  city: string;
  address: string;
  building: string;
};

type ProfileForm = {
  email: string;
  fullName: string;
  kanaName: string;
  phone: string;
  address: ProfileAddress;
};

type ShippingAddress = ProfileAddress & {
  id: string;
  isDefault: boolean;
};

type OrderItem = {
  id: string;
  itemId: number | null;
  name: string;
  imageUrl?: string | null;
  color?: string | null;
  size?: string | null;
  quantity: number;
  amount: string;
  stockStatus: "in_stock" | "low_stock" | "sold_out" | "unknown";
};

type OrderSummary = {
  id: string;
  orderNumber: string;
  orderDate: string;
  status: string;
  totalAmount: string;
  itemCount: number;
  shippingFullName: string;
  shippingEmail: string;
  shippingPhone: string;
  shippingAddress: string;
  items: OrderItem[];
  detailHref: string;
};

const EMPTY_ADDRESS: ProfileAddress = {
  postalCode: "",
  prefecture: "",
  city: "",
  address: "",
  building: "",
};

const EMPTY_PROFILE: ProfileForm = {
  email: "",
  fullName: "",
  kanaName: "",
  phone: "",
  address: EMPTY_ADDRESS,
};

const accountTextXsStyle: React.CSSProperties = {
  fontSize: "var(--lk-size-xs)",
};
const accountTextMdStyle: React.CSSProperties = {
  fontSize: "var(--lk-size-md)",
};
const accountTextLgStyle: React.CSSProperties = {
  fontSize: "var(--lk-size-lg)",
};
const accountPageTitleStyle: React.CSSProperties = {
  fontSize: "var(--lk-size-4xl)",
};
// 未ログインゲートの見出しは画面の主役。対比のため通常の ACCOUNT 見出しより大きくする。
const accountGateTitleStyle: React.CSSProperties = {
  fontSize: "var(--lk-size-6xl)",
};

function normalizeAccountTab(tabParam: string | null): AccountTab {
  if (tabParam === "shipping" || tabParam === "address") {
    return "shipping";
  }

  if (tabParam === "orders" || tabParam === "inquiries") {
    return tabParam;
  }

  return "profile";
}

function formatAddressLines(address: ProfileAddress) {
  return (
    [address.prefecture, address.city, address.address, address.building]
      .filter(Boolean)
      .join("") || "-"
  );
}

// 注文日の年ごとに区切る（APIは注文日降順で返すため連続グループ化で足りる）
function groupOrdersByYear(orders: OrderSummary[]) {
  const groups: { year: string; orders: OrderSummary[] }[] = [];
  for (const order of orders) {
    const year = order.orderDate.slice(0, 4);
    const last = groups[groups.length - 1];
    if (last && last.year === year) {
      last.orders.push(order);
    } else {
      groups.push({ year, orders: [order] });
    }
  }
  return groups;
}

function defaultAddressFields(list: ShippingAddress[]): ProfileAddress {
  const def = list.find((item) => item.isDefault) ?? list[0];
  if (!def) {
    return EMPTY_ADDRESS;
  }
  return {
    postalCode: def.postalCode,
    prefecture: def.prefecture,
    city: def.city,
    address: def.address,
    building: def.building,
  };
}

function AccountPageContent() {
  const { isLoggedIn, isAuthResolved, logout } = useLogin();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeTabFromQuery = normalizeAccountTab(searchParams.get("tab"));

  const [activeTab, setActiveTab] =
    React.useState<AccountTab>(activeTabFromQuery);
  const [savedProfile, setSavedProfile] =
    React.useState<ProfileForm>(EMPTY_PROFILE);
  const [profileForm, setProfileForm] =
    React.useState<ProfileForm>(EMPTY_PROFILE);
  const [orders, setOrders] = React.useState<OrderSummary[]>([]);
  const [addresses, setAddresses] = React.useState<ShippingAddress[]>([]);
  const [addressForm, setAddressForm] =
    React.useState<ProfileAddress>(EMPTY_ADDRESS);
  const [originalAddressForm, setOriginalAddressForm] =
    React.useState<ProfileAddress>(EMPTY_ADDRESS);
  // null = 一覧表示, "new" = 追加フォーム, その他 = 該当idの編集フォーム
  const [editingAddressId, setEditingAddressId] = React.useState<string | null>(
    null,
  );
  const [isEditingProfile, setIsEditingProfile] = React.useState(false);
  const [isLoadingProfile, setIsLoadingProfile] = React.useState(true);
  const [isLoadingOrders, setIsLoadingOrders] = React.useState(false);
  const [isSavingProfile, setIsSavingProfile] = React.useState(false);
  const [profileMessage, setProfileMessage] = React.useState<string | null>(
    null,
  );
  const [profileError, setProfileError] = React.useState<string | null>(null);
  const [ordersError, setOrdersError] = React.useState<string | null>(null);
  const [logoutError, setLogoutError] = React.useState<string | null>(null);
  const [isLoggingOut, setIsLoggingOut] = React.useState(false);
  // AC-3 / AC-4: 破壊的操作の確認ダイアログ
  const [confirmProfileDelete, setConfirmProfileDelete] = React.useState(false);
  const [confirmAddressDeleteId, setConfirmAddressDeleteId] = React.useState<
    string | null
  >(null);
  const latestPostalLookupRef = React.useRef("");
  const rawTabFromQuery = searchParams.get("tab");

  const syncTabToUrl = React.useCallback(
    (nextTab: AccountTab) => {
      const nextParams = new URLSearchParams(searchParams.toString());
      nextParams.set("tab", nextTab);
      router.replace(`${pathname}?${nextParams.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const fetchProfile = React.useCallback(async () => {
    setIsLoadingProfile(true);
    setProfileError(null);

    try {
      const response = await clientFetch("/api/profile", { cache: "no-store" });
      if (!response.ok) {
        throw new Error("プロフィールの取得に失敗しました");
      }

      const data = (await response.json()) as Partial<ProfileForm> & {
        address?: Partial<ProfileAddress>;
      };
      const normalizedProfile: ProfileForm = {
        email: typeof data.email === "string" ? data.email : "",
        fullName: typeof data.fullName === "string" ? data.fullName : "",
        kanaName: typeof data.kanaName === "string" ? data.kanaName : "",
        phone: formatPhoneNumberInput(
          typeof data.phone === "string" ? data.phone : "",
        ),
        address: {
          postalCode: formatPostalCodeInput(
            typeof data.address?.postalCode === "string"
              ? data.address.postalCode
              : "",
          ),
          prefecture:
            typeof data.address?.prefecture === "string"
              ? data.address.prefecture
              : "",
          city: typeof data.address?.city === "string" ? data.address.city : "",
          address:
            typeof data.address?.address === "string"
              ? data.address.address
              : "",
          building:
            typeof data.address?.building === "string"
              ? data.address.building
              : "",
        },
      };

      setSavedProfile(normalizedProfile);
      setProfileForm(normalizedProfile);
    } catch (error) {
      console.error("Failed to fetch profile:", error);
      setProfileError("プロフィールを読み込めませんでした");
    } finally {
      setIsLoadingProfile(false);
    }
  }, []);

  const fetchAddresses = React.useCallback(async () => {
    try {
      const response = await clientFetch("/api/profile/addresses", {
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error("配送情報の取得に失敗しました");
      }

      const data = (await response.json()) as { addresses?: ShippingAddress[] };
      const list = Array.isArray(data.addresses)
        ? data.addresses.map((item) => ({
            id: item.id,
            postalCode: formatPostalCodeInput(item.postalCode ?? ""),
            prefecture: item.prefecture ?? "",
            city: item.city ?? "",
            address: item.address ?? "",
            building: item.building ?? "",
            isDefault: Boolean(item.isDefault),
          }))
        : [];
      setAddresses(list);
    } catch (error) {
      console.error("Failed to fetch addresses:", error);
    }
  }, []);

  const fetchOrders = React.useCallback(async () => {
    setIsLoadingOrders(true);
    setOrdersError(null);

    try {
      const response = await clientFetch("/api/orders", { cache: "no-store" });
      if (!response.ok) {
        throw new Error("注文履歴の取得に失敗しました");
      }

      const data = (await response.json()) as { data?: OrderSummary[] };
      setOrders(Array.isArray(data.data) ? data.data : []);
    } catch (error) {
      console.error("Failed to fetch orders:", error);
      setOrdersError("注文履歴を読み込めませんでした");
    } finally {
      setIsLoadingOrders(false);
    }
  }, []);

  React.useEffect(() => {
    setActiveTab(activeTabFromQuery);

    if (rawTabFromQuery && rawTabFromQuery !== activeTabFromQuery) {
      syncTabToUrl(activeTabFromQuery);
    }
  }, [activeTabFromQuery, rawTabFromQuery, syncTabToUrl]);

  React.useEffect(() => {
    if (!isAuthResolved || !isLoggedIn) {
      setIsLoadingProfile(false);
      return;
    }

    void fetchProfile();
    void fetchAddresses();
  }, [fetchProfile, fetchAddresses, isAuthResolved, isLoggedIn]);

  React.useEffect(() => {
    if (!isAuthResolved || !isLoggedIn || activeTab !== "orders") {
      return;
    }

    void fetchOrders();
  }, [activeTab, fetchOrders, isAuthResolved, isLoggedIn]);

  const handleTabChange = (tab: string) => {
    const nextTab = normalizeAccountTab(tab);
    setActiveTab(nextTab);
    syncTabToUrl(nextTab);
    setProfileMessage(null);
    setProfileError(null);
    setIsEditingProfile(false);
    setEditingAddressId(null);
  };

  const handleProfileFieldChange = (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const { name, value } = event.target;
    const nextValue = name === "phone" ? formatPhoneNumberInput(value) : value;
    setProfileForm((prev) => ({
      ...prev,
      [name]: nextValue,
    }));
  };

  const handleAddressFieldChange = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const { name, value } = event.target;
    const nextValue =
      name === "postalCode" ? formatPostalCodeInput(value) : value;

    setAddressForm((prev) => ({
      ...prev,
      [name]: nextValue,
    }));

    if (name !== "postalCode") {
      return;
    }

    const cleanedPostalCode = normalizePostalCode(value);
    latestPostalLookupRef.current = cleanedPostalCode;

    if (cleanedPostalCode.length !== 7) {
      return;
    }

    try {
      const response = await fetch(
        `/api/checkout/postal-code?postalCode=${cleanedPostalCode}`,
      );
      const data = (await response.json()) as {
        address?: Partial<ProfileAddress>;
      };

      if (
        !response.ok ||
        latestPostalLookupRef.current !== cleanedPostalCode ||
        !data.address
      ) {
        return;
      }

      setAddressForm((prev) => ({
        ...prev,
        postalCode: formatPostalCodeInput(cleanedPostalCode),
        prefecture: data.address?.prefecture || prev.prefecture,
        city: data.address?.city || prev.city,
        address: data.address?.address || prev.address,
        building: prev.building,
      }));
    } catch (error) {
      console.error("Postal code lookup error:", error);
    }
  };

  const persistProfile = async (nextProfile: ProfileForm = profileForm) => {
    // 住所は配送タブ(/api/profile/addresses)が管理。プロフィール保存では送らない。
    const payload = {
      fullName: nextProfile.fullName.trim(),
      kanaName: nextProfile.kanaName.trim(),
      phone: formatPhoneNumberInput(nextProfile.phone.trim()),
    };

    const response = await clientFetch("/api/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error("プロフィールの保存に失敗しました");
    }

    const data = (await response.json()) as ProfileForm;
    const normalizedProfile: ProfileForm = {
      email: typeof data.email === "string" ? data.email : nextProfile.email,
      fullName: typeof data.fullName === "string" ? data.fullName : "",
      kanaName: typeof data.kanaName === "string" ? data.kanaName : "",
      phone: formatPhoneNumberInput(
        typeof data.phone === "string" ? data.phone : "",
      ),
      address: {
        postalCode: formatPostalCodeInput(
          typeof data.address?.postalCode === "string"
            ? data.address.postalCode
            : "",
        ),
        prefecture:
          typeof data.address?.prefecture === "string"
            ? data.address.prefecture
            : "",
        city: typeof data.address?.city === "string" ? data.address.city : "",
        address:
          typeof data.address?.address === "string" ? data.address.address : "",
        building:
          typeof data.address?.building === "string"
            ? data.address.building
            : "",
      },
    };

    setSavedProfile(normalizedProfile);
    setProfileForm(normalizedProfile);
  };

  const persistAddresses = async (nextAddresses: ShippingAddress[]) => {
    const payload = {
      addresses: nextAddresses.map((item) => ({
        id: item.id,
        postalCode: normalizePostalCode(item.postalCode),
        prefecture: item.prefecture.trim(),
        city: item.city.trim(),
        address: item.address.trim(),
        building: item.building.trim(),
        isDefault: item.isDefault,
      })),
    };

    const response = await clientFetch("/api/profile/addresses", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error("配送情報の保存に失敗しました");
    }

    const data = (await response.json()) as { addresses?: ShippingAddress[] };
    const list = Array.isArray(data.addresses)
      ? data.addresses.map((item) => ({
          id: item.id,
          postalCode: formatPostalCodeInput(item.postalCode ?? ""),
          prefecture: item.prefecture ?? "",
          city: item.city ?? "",
          address: item.address ?? "",
          building: item.building ?? "",
          isDefault: Boolean(item.isDefault),
        }))
      : [];

    setAddresses(list);
    // プロフィールPOSTがミラー(profiles.address)を上書きしても整合するよう同期
    const nextDefault = defaultAddressFields(list);
    setSavedProfile((prev) => ({ ...prev, address: nextDefault }));
    setProfileForm((prev) => ({ ...prev, address: nextDefault }));
    return list;
  };

  const openAddAddress = () => {
    setAddressForm(EMPTY_ADDRESS);
    setOriginalAddressForm(EMPTY_ADDRESS);
    setEditingAddressId("new");
    setProfileMessage(null);
    setProfileError(null);
  };

  const openEditAddress = (target: ShippingAddress) => {
    const initial = {
      postalCode: target.postalCode,
      prefecture: target.prefecture,
      city: target.city,
      address: target.address,
      building: target.building,
    };
    setAddressForm(initial);
    setOriginalAddressForm(initial);
    setEditingAddressId(target.id);
    setProfileMessage(null);
    setProfileError(null);
  };

  const cancelAddressEdit = () => {
    setEditingAddressId(null);
    setAddressForm(EMPTY_ADDRESS);
    setProfileError(null);
  };

  const handleAddressSave = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsSavingProfile(true);
    setProfileMessage(null);
    setProfileError(null);

    try {
      let nextAddresses: ShippingAddress[];
      if (editingAddressId === "new") {
        const newAddress: ShippingAddress = {
          id: crypto.randomUUID(),
          ...addressForm,
          isDefault: addresses.length === 0,
        };
        nextAddresses = [...addresses, newAddress];
      } else {
        nextAddresses = addresses.map((item) =>
          item.id === editingAddressId ? { ...item, ...addressForm } : item,
        );
      }

      await persistAddresses(nextAddresses);
      setEditingAddressId(null);
      setAddressForm(EMPTY_ADDRESS);
      setProfileMessage("配送情報を保存しました");
    } catch (error) {
      console.error("Address save error:", error);
      setProfileError("配送情報を保存できませんでした");
    } finally {
      setIsSavingProfile(false);
    }
  };

  const handleProfileSave = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsSavingProfile(true);
    setProfileMessage(null);
    setProfileError(null);

    try {
      await persistProfile(profileForm);
      setIsEditingProfile(false);
      setProfileMessage("プロフィールを保存しました");
    } catch (error) {
      console.error("Profile save error:", error);
      setProfileError("プロフィールを保存できませんでした");
    } finally {
      setIsSavingProfile(false);
    }
  };

  const handleProfileDelete = async () => {
    setProfileMessage(null);
    setProfileError(null);

    try {
      setProfileForm((prev) => ({
        ...prev,
        fullName: "",
        kanaName: "",
        phone: "",
      }));

      const nextProfile = {
        ...profileForm,
        fullName: "",
        kanaName: "",
        phone: "",
      };
      setProfileForm(nextProfile);
      await persistProfile(nextProfile);
      setIsEditingProfile(false);
      setProfileMessage("プロフィールを削除しました");
    } catch (error) {
      console.error("Profile delete error:", error);
      setProfileError("プロフィールを削除できませんでした");
    }
  };

  const handleAddressDelete = async (id: string) => {
    setProfileMessage(null);
    setProfileError(null);

    try {
      const remaining = addresses.filter((item) => item.id !== id);
      // メインを削除したら先頭を自動メイン化
      const nextAddresses =
        remaining.length > 0 && !remaining.some((item) => item.isDefault)
          ? remaining.map((item, index) => ({
              ...item,
              isDefault: index === 0,
            }))
          : remaining;

      await persistAddresses(nextAddresses);
      setProfileMessage("配送情報を削除しました");
    } catch (error) {
      console.error("Address delete error:", error);
      setProfileError("配送情報を削除できませんでした");
    }
  };

  const handleSetMainAddress = async (id: string) => {
    setProfileMessage(null);
    setProfileError(null);

    try {
      const nextAddresses = addresses.map((item) => ({
        ...item,
        isDefault: item.id === id,
      }));
      await persistAddresses(nextAddresses);
      setProfileMessage("メインの配送先を変更しました");
    } catch (error) {
      console.error("Set main address error:", error);
      setProfileError("メインの配送先を変更できませんでした");
    }
  };

  const handleLogout = async () => {
    setIsLoggingOut(true);
    setLogoutError(null);

    const result = await logout();
    if (!result.success) {
      setLogoutError(result.error || "ログアウトに失敗しました");
      setIsLoggingOut(false);
      return;
    }

    // ログアウト後はアカウントページに留まらずホームへ遷移する。
    // ハードナビゲーションで完全リロードし、クリア済み Cookie で認証状態を再評価する。
    window.location.assign("/");
  };

  const hasSavedProfile =
    savedProfile.email.trim().length > 0 ||
    savedProfile.fullName.trim().length > 0 ||
    savedProfile.kanaName.trim().length > 0 ||
    savedProfile.phone.trim().length > 0;

  const isProfileChanged =
    profileForm.fullName.trim() !== savedProfile.fullName.trim() ||
    profileForm.kanaName.trim() !== savedProfile.kanaName.trim() ||
    profileForm.phone.trim() !== savedProfile.phone.trim();

  const isEditingAddress = editingAddressId !== null;

  // ログアウト直後は isLoggedIn=false になるが、ホームへのハードナビゲーションが
  // 完了するまで未ログインゲートを描画しない。一瞬ゲートが見える問題を防ぐ。
  if (!isAuthResolved || isLoggingOut) {
    return (
      <div className="max-w-3xl mx-auto text-center">
        <p className="text-[#474747] mb-8" style={accountTextLgStyle}>
          読み込み中...
        </p>
      </div>
    );
  }

  if (!isLoggedIn) {
    return (
      <div className="flex min-h-[calc(100dvh-6.5rem)] w-full flex-col items-center justify-center px-6 text-center">
        {/* ブランドフォント Didot（h1 既定）でエレガントに見せる */}
        <h1 className="mb-3 tracking-[0.2em]" style={accountGateTitleStyle}>
          ACCOUNT
        </h1>

        <p className="mb-9 text-black" style={accountTextLgStyle}>
          会員情報の確認には、ログインが必要です。
        </p>
        {/* 糸のモチーフ：一本の細いヘアライン（Le Fil des Heures＝時間の糸） */}
        <span aria-hidden="true" className="mb-6 block h-10 w-px bg-black/30" />

        <Button
          href="/login"
          variant="primary"
          size="lg"
          shape="rounded"
          className="min-w-[220px]"
        >
          ログイン
        </Button>
      </div>
    );
  }

  return (
    <div className="account-page w-full md:max-w-3xl md:mx-auto">
      {/* AC-5: ログイン後も現在地を示す h1 を表示 */}
      <h1
        className="mb-[21px] sm:mb-[26px] tracking-widest"
        style={accountPageTitleStyle}
      >
        ACCOUNT
      </h1>
      <div className="account-layout">
        {/* sidebar: tablet and above */}
        <div className="hidden md:block">
          <TabSegmentControl
            items={[
              { key: "profile", label: "お客様情報" },
              { key: "shipping", label: "配送情報" },
              { key: "orders", label: "購入履歴" },
              { key: "inquiries", label: "お問い合わせ" },
            ]}
            activeKey={activeTab}
            onChange={handleTabChange}
            orientation="vertical"
            size="md"
            className="space-y-2"
            itemStyle={accountTextMdStyle}
          />
          <div className="account-sidebar-logout">
            <Button
              type="button"
              variant="secondary"
              size="md"
              className="w-full font-acumin"
              onClick={handleLogout}
              disabled={isLoggingOut}
            >
              {isLoggingOut ? "ログアウト中..." : "ログアウト"}
            </Button>
            {logoutError ? (
              <p
                className="mt-3 text-red-600 font-acumin"
                style={accountTextXsStyle}
              >
                {logoutError}
              </p>
            ) : null}
          </div>
        </div>

        <div className="min-w-0">
          {/* mobile/tablet: tabs-standard tab bar */}
          <div className="account-mobile-tabs md:hidden">
            <TabSegmentControl
              items={[
                { key: "profile", label: "お客様情報" },
                { key: "shipping", label: "配送情報" },
                { key: "orders", label: "購入履歴" },
                { key: "inquiries", label: "お問い合わせ" },
              ]}
              activeKey={activeTab}
              onChange={handleTabChange}
              variant="tabs-standard"
              size="sm"
            />
          </div>

          {activeTab === "profile" ? (
            <div className="account-sections">
              {isLoadingProfile ? (
                <div
                  className="account-card account-groups animate-pulse"
                  aria-hidden="true"
                >
                  <div className="h-3 w-1/4 bg-black/8 mb-2" />
                  <div className="h-4 w-2/3 bg-black/8 mb-5" />
                  <div className="h-3 w-1/4 bg-black/8 mb-2" />
                  <div className="h-4 w-1/2 bg-black/8 mb-5" />
                  <div className="h-3 w-1/4 bg-black/8 mb-2" />
                  <div className="h-4 w-3/4 bg-black/8" />
                </div>
              ) : null}

              {!isLoadingProfile && hasSavedProfile && !isEditingProfile ? (
                <div className="account-profile-view">
                  <TextField
                    shape="underline"
                    size="sm"
                    leadingText="氏名"
                    value={savedProfile.fullName || "-"}
                    readOnly
                  />
                  <TextField
                    shape="underline"
                    size="sm"
                    leadingText="フリガナ"
                    value={savedProfile.kanaName || "-"}
                    readOnly
                  />
                  <TextField
                    shape="underline"
                    size="sm"
                    leadingText="メールアドレス"
                    value={savedProfile.email || "-"}
                    readOnly
                  />
                  <TextField
                    shape="underline"
                    size="sm"
                    leadingText="電話番号"
                    value={savedProfile.phone || "-"}
                    readOnly
                  />
                  <div className="account-actions">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setIsEditingProfile(true)}
                    >
                      編集
                    </Button>
                  </div>
                </div>
              ) : null}

              {!isLoadingProfile && (!hasSavedProfile || isEditingProfile) ? (
                <form
                  className="account-profile-view account-profile-edit"
                  onSubmit={handleProfileSave}
                >
                  <TextField
                    shape="underline"
                    size="sm"
                    leadingText="氏名"
                    type="text"
                    name="fullName"
                    autoComplete="name"
                    value={profileForm.fullName}
                    onChange={handleProfileFieldChange}
                  />
                  <TextField
                    shape="underline"
                    size="sm"
                    leadingText="フリガナ"
                    type="text"
                    name="kanaName"
                    value={profileForm.kanaName}
                    onChange={handleProfileFieldChange}
                  />
                  <TextField
                    shape="underline"
                    size="sm"
                    leadingText="メールアドレス"
                    type="email"
                    name="email"
                    value={profileForm.email}
                    readOnly
                  />
                  <TextField
                    shape="underline"
                    size="sm"
                    leadingText="電話番号"
                    type="tel"
                    name="phone"
                    autoComplete="tel"
                    inputMode="numeric"
                    value={profileForm.phone}
                    onChange={handleProfileFieldChange}
                  />
                  <div className="account-actions">
                    <Button
                      type="submit"
                      size="sm"
                      className="font-acumin"
                      disabled={
                        isSavingProfile ||
                        (hasSavedProfile && !isProfileChanged)
                      }
                    >
                      {isSavingProfile
                        ? "保存中..."
                        : hasSavedProfile
                          ? "保存"
                          : "保存する"}
                    </Button>
                    {hasSavedProfile ? (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className="font-acumin"
                        onClick={() => {
                          setProfileForm(savedProfile);
                          setIsEditingProfile(false);
                          setProfileError(null);
                        }}
                      >
                        キャンセル
                      </Button>
                    ) : null}
                  </div>
                </form>
              ) : null}
            </div>
          ) : null}

          {activeTab === "shipping" ? (
            <div className="account-sections">
              {isLoadingProfile ? (
                <div
                  className="account-card account-groups animate-pulse"
                  aria-hidden="true"
                >
                  <div className="h-3 w-1/4 bg-black/8 mb-2" />
                  <div className="h-4 w-2/3 bg-black/8 mb-5" />
                  <div className="h-3 w-1/4 bg-black/8 mb-2" />
                  <div className="h-4 w-3/4 bg-black/8" />
                </div>
              ) : null}

              {!isLoadingProfile && !isEditingAddress ? (
                <>
                  {addresses.length === 0 ? (
                    <div className="account-card account-groups">
                      <p className="text-black" style={accountTextLgStyle}>
                        登録済みの配送先はありません
                      </p>
                      <p className="text-[#474747]" style={accountTextMdStyle}>
                        配送先を追加すると購入時に選択できます。
                      </p>
                    </div>
                  ) : null}

                  {[...addresses]
                    .sort(
                      (a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0),
                    )
                    .map((item) => (
                      <div
                        key={item.id}
                        className="account-card account-address-row"
                      >
                        <div className="account-value account-address-value">
                          <span className="account-address-postal font-acumin">
                            {item.postalCode ? `〒${item.postalCode}` : "-"}
                          </span>
                          <span>{formatAddressLines(item)}</span>
                        </div>
                        <div className="account-address-buttons">
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            className="font-acumin"
                            onClick={() => openEditAddress(item)}
                          >
                            編集
                          </Button>
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            className="font-acumin"
                            onClick={() => setConfirmAddressDeleteId(item.id)}
                          >
                            削除
                          </Button>
                        </div>
                        {item.isDefault ? (
                          <span className="account-address-badge font-acumin">
                            MAIN
                          </span>
                        ) : (
                          <Button
                            type="button"
                            size="sm"
                            className="font-acumin account-address-main-btn"
                            onClick={() => handleSetMainAddress(item.id)}
                          >
                            MAINにする
                          </Button>
                        )}
                      </div>
                    ))}

                  <div className="account-actions">
                    <Button
                      type="button"
                      variant="subtle"
                      className="font-acumin"
                      onClick={openAddAddress}
                    >
                      + 住所を追加
                    </Button>
                  </div>
                </>
              ) : null}

              {!isLoadingProfile && isEditingAddress ? (
                <form
                  className="account-profile-view account-profile-edit account-address-edit"
                  onSubmit={handleAddressSave}
                >
                  <TextField
                    shape="underline"
                    size="sm"
                    leadingText="郵便番号"
                    type="text"
                    name="postalCode"
                    autoComplete="postal-code"
                    inputMode="numeric"
                    value={addressForm.postalCode}
                    onChange={handleAddressFieldChange}
                  />
                  {/* 都道府県は select だが、他フィールド（underline + leadingText）と
                      同じラベル左／値右の行に揃える */}
                  <div className="account-select-field">
                    <span className="account-select-field__label">
                      都道府県
                    </span>
                    <SingleSelect
                      name="prefecture"
                      aria-label="都道府県"
                      variant="dropdown"
                      bordered={false}
                      autoComplete="address-level1"
                      value={addressForm.prefecture}
                      onValueChange={(prefecture) =>
                        setAddressForm((prev) => ({ ...prev, prefecture }))
                      }
                      options={[
                        { value: "", label: "選択してください" },
                        ...PREFECTURES.map((p) => ({ value: p, label: p })),
                      ]}
                      size="sm"
                    />
                  </div>
                  <TextField
                    shape="underline"
                    size="sm"
                    leadingText="市区町村"
                    type="text"
                    name="city"
                    autoComplete="address-level2"
                    value={addressForm.city}
                    onChange={handleAddressFieldChange}
                  />
                  <TextField
                    shape="underline"
                    size="sm"
                    leadingText="番地"
                    type="text"
                    name="address"
                    autoComplete="street-address"
                    value={addressForm.address}
                    onChange={handleAddressFieldChange}
                  />
                  <TextField
                    shape="underline"
                    size="sm"
                    leadingText="建物名・部屋番号"
                    type="text"
                    name="building"
                    value={addressForm.building}
                    onChange={handleAddressFieldChange}
                  />
                  <div className="account-actions">
                    <Button
                      type="submit"
                      size="sm"
                      className="font-acumin"
                      disabled={
                        isSavingProfile ||
                        (editingAddressId !== "new" &&
                          addressForm.postalCode ===
                            originalAddressForm.postalCode &&
                          addressForm.prefecture ===
                            originalAddressForm.prefecture &&
                          addressForm.city === originalAddressForm.city &&
                          addressForm.address === originalAddressForm.address &&
                          addressForm.building === originalAddressForm.building)
                      }
                    >
                      {isSavingProfile
                        ? "保存中..."
                        : editingAddressId === "new"
                          ? "保存する"
                          : "保存"}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="font-acumin"
                      onClick={cancelAddressEdit}
                    >
                      キャンセル
                    </Button>
                  </div>
                </form>
              ) : null}
            </div>
          ) : null}

          {activeTab === "orders" ? (
            <div className="account-sections">
              {isLoadingOrders ? (
                <div className="space-y-4" aria-hidden="true">
                  {Array.from({ length: 2 }).map((_, i) => (
                    <div
                      key={i}
                      className="account-card account-groups animate-pulse"
                    >
                      <div className="h-3 w-1/3 bg-black/8 mb-2" />
                      <div className="h-4 w-1/2 bg-black/8 mb-5" />
                      <div className="h-16 w-full bg-black/5 mb-4" />
                      <div className="h-8 w-32 bg-black/8" />
                    </div>
                  ))}
                </div>
              ) : null}
              {ordersError ? (
                <p className="text-red-600 account-feedback">{ordersError}</p>
              ) : null}
              {!isLoadingOrders && !ordersError && orders.length === 0 ? (
                <div className="account-card account-groups">
                  <p className="text-black" style={accountTextLgStyle}>
                    注文履歴はまだありません
                  </p>
                  <p className="text-[#474747]" style={accountTextMdStyle}>
                    ご注文いただいた商品はこの画面に表示されます。
                  </p>
                </div>
              ) : null}

              {/* 年別タイムライン: 年見出し + 縦ライン（糸モチーフ）+ 注文行（連続の法則） */}
              {groupOrdersByYear(orders).map((group) => (
                <section key={group.year} className="account-order-year">
                  <h2 className="account-order-year-label font-acumin">
                    {group.year}
                  </h2>
                  <div className="account-order-year-body">
                    <ul className="account-order-timeline">
                      {group.orders.map((order) => {
                        const thumbnail = order.items.find(
                          (item) => item.imageUrl,
                        )?.imageUrl;
                        return (
                          <li key={order.id} className="account-order-entry">
                            <Link
                              href={order.detailHref}
                              className="account-order-entry-link"
                            >
                              {thumbnail ? (
                                <Image
                                  src={thumbnail}
                                  alt=""
                                  width={56}
                                  height={75}
                                  className="account-order-entry-thumb"
                                />
                              ) : (
                                <span
                                  className="account-order-entry-thumb"
                                  aria-hidden="true"
                                />
                              )}
                              <div className="account-order-entry-main">
                                <p className="account-order-entry-number font-acumin text-black">
                                  {order.orderNumber}
                                </p>
                                <p className="account-order-entry-text font-acumin text-black">
                                  {order.totalAmount}
                                </p>
                              </div>
                              <div className="account-order-entry-status">
                                <span className="account-status account-status-sm">
                                  {formatOrderStatus(order.status)}
                                </span>
                                <p className="account-order-entry-date font-acumin">
                                  {order.orderDate.replace(/[/-]/g, ".")}
                                  <i
                                    className="ri-arrow-right-line"
                                    aria-hidden="true"
                                  />
                                </p>
                              </div>
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                </section>
              ))}
            </div>
          ) : null}

          {activeTab === "inquiries" ? <AccountInquiries /> : null}

          {/* mobile/tablet: logout below content */}
          <div className="account-sidebar-logout md:hidden">
            <Button
              type="button"
              variant="secondary"
              size="md"
              className="w-full font-acumin"
              onClick={handleLogout}
              disabled={isLoggingOut}
            >
              {isLoggingOut ? "ログアウト中..." : "ログアウト"}
            </Button>
            {logoutError ? (
              <p
                className="mt-3 text-red-600 font-acumin"
                style={accountTextXsStyle}
              >
                {logoutError}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      {/* AC-7: フィードバックを操作地点に近い固定トーストで通知 */}
      {profileMessage ? (
        <div
          role="status"
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 max-w-[90vw] bg-black text-white px-5 py-3 shadow-lg flex items-center gap-3"
          style={accountTextMdStyle}
        >
          <span className="flex items-center gap-2">
            <span aria-hidden="true">✓</span>
            {profileMessage}
          </span>
          <button
            type="button"
            onClick={() => setProfileMessage(null)}
            aria-label="通知を閉じる"
            className="flex-shrink-0 opacity-70 hover:opacity-100 transition-opacity"
          >
            <i className="ri-close-line" aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {profileError ? (
        <div
          role="alert"
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 max-w-[90vw] border border-red-300 bg-white text-red-600 px-5 py-3 shadow-lg flex items-center gap-3"
          style={accountTextMdStyle}
        >
          <span>{profileError}</span>
          <button
            type="button"
            onClick={() => setProfileError(null)}
            aria-label="通知を閉じる"
            className="flex-shrink-0 opacity-70 hover:opacity-100 transition-opacity"
          >
            <i className="ri-close-line" aria-hidden="true" />
          </button>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmProfileDelete}
        title="プロフィール情報を消去しますか？"
        description="氏名・フリガナ・電話番号が消去されます。この操作は元に戻せません。"
        confirmLabel="消去する"
        onConfirm={() => {
          setConfirmProfileDelete(false);
          void handleProfileDelete();
        }}
        onCancel={() => setConfirmProfileDelete(false)}
      />
      <ConfirmDialog
        open={confirmAddressDeleteId !== null}
        title="この配送先を削除しますか？"
        description="この操作は元に戻せません。"
        onConfirm={() => {
          const id = confirmAddressDeleteId;
          setConfirmAddressDeleteId(null);
          if (id) void handleAddressDelete(id);
        }}
        onCancel={() => setConfirmAddressDeleteId(null)}
      />
    </div>
  );
}

export default function AccountPage() {
  return (
    <React.Suspense
      fallback={
        <div className="pb-10 sm:pb-14 px-6 lg:px-12">
          <div className="max-w-6xl mx-auto">
            <p className="text-[#474747]" style={accountTextMdStyle}>
              読み込み中...
            </p>
          </div>
        </div>
      }
    >
      <AccountPageContent />
    </React.Suspense>
  );
}
