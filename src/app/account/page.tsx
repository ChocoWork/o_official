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
import { PREFECTURES } from "@/lib/constants/prefectures";
import { clientFetch } from "@/lib/client-fetch";
import { formatPhoneNumberInput } from "@/features/account/utils/profile-format.util";
import {
  formatPostalCodeInput,
  normalizePostalCode,
} from "@/features/checkout/utils/postal-code.util";
import "./account.css";

type AccountTab = "profile" | "shipping" | "orders";

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

type OrderSummary = {
  id: string;
  orderNumber: string;
  orderDate: string;
  status: string;
  totalAmount: string;
  itemCount: number;
  items: Array<{
    id: string;
    name: string;
    imageUrl?: string | null;
    color?: string | null;
    size?: string | null;
    quantity: number;
    amount: string;
  }>;
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
const accountTextXlStyle: React.CSSProperties = {
  fontSize: "var(--lk-size-xl)",
};
const accountPageTitleStyle: React.CSSProperties = {
  fontSize: "var(--lk-size-4xl)",
};

function normalizeAccountTab(tabParam: string | null): AccountTab {
  if (tabParam === "shipping" || tabParam === "address") {
    return "shipping";
  }

  if (tabParam === "orders") {
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
    setEditingAddressId("new");
    setProfileMessage(null);
    setProfileError(null);
  };

  const openEditAddress = (target: ShippingAddress) => {
    setAddressForm({
      postalCode: target.postalCode,
      prefecture: target.prefecture,
      city: target.city,
      address: target.address,
      building: target.building,
    });
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
    }

    setIsLoggingOut(false);
  };

  const hasSavedProfile =
    savedProfile.email.trim().length > 0 ||
    savedProfile.fullName.trim().length > 0 ||
    savedProfile.kanaName.trim().length > 0 ||
    savedProfile.phone.trim().length > 0;

  const isEditingAddress = editingAddressId !== null;

  if (!isAuthResolved) {
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
      <div className="max-w-3xl mx-auto text-center">
        <div className="w-20 h-20 flex items-center justify-center mx-auto mb-8">
          <i className="ri-user-line text-6xl text-[#474747]"></i>
        </div>
        <h1 className="mb-4" style={accountPageTitleStyle}>
          会員情報
        </h1>
        <p className="text-[#474747] mb-8" style={accountTextLgStyle}>
          会員情報を確認するにはログインが必要です
        </p>
        <Button href="/login" variant="primary" size="lg">
          ログイン
        </Button>
      </div>
    );
  }

  return (
    <div className="account-page w-full md:max-w-7xl md:mx-auto">
      <div className="account-layout">
        {/* sidebar: tablet and above */}
        <div className="hidden md:block">
          <TabSegmentControl
            items={[
              { key: "profile", label: "お客様情報" },
              { key: "shipping", label: "配送情報" },
              { key: "orders", label: "購入履歴" },
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
                <p className="text-[#474747] account-feedback">読み込み中...</p>
              ) : null}
              {profileMessage ? (
                <p className="text-green-700 account-feedback">
                  {profileMessage}
                </p>
              ) : null}
              {profileError ? (
                <p className="text-red-600 account-feedback">{profileError}</p>
              ) : null}

              {!isLoadingProfile && hasSavedProfile && !isEditingProfile ? (
                <div className="account-card account-groups">
                  <div className="account-field">
                    <p className="account-label">氏名</p>
                    <p className="account-value">
                      {savedProfile.fullName || "-"}
                    </p>
                  </div>
                  <div className="account-field">
                    <p className="account-label">フリガナ</p>
                    <p className="account-value">
                      {savedProfile.kanaName || "-"}
                    </p>
                  </div>
                  <div className="account-field">
                    <p className="account-label">メールアドレス</p>
                    <p className="account-value break-all">
                      {savedProfile.email || "-"}
                    </p>
                  </div>
                  <div className="account-field">
                    <p className="account-label">電話番号</p>
                    <p className="account-value">{savedProfile.phone || "-"}</p>
                  </div>
                  <div className="account-actions">
                    <Button size="sm" onClick={() => setIsEditingProfile(true)}>
                      変更する
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={handleProfileDelete}
                    >
                      削除する
                    </Button>
                  </div>
                </div>
              ) : null}

              {!isLoadingProfile && (!hasSavedProfile || isEditingProfile) ? (
                <form
                  className="account-form account-card"
                  onSubmit={handleProfileSave}
                >
                  <p className="account-label">氏名</p>
                  <TextField
                    type="text"
                    name="fullName"
                    autoComplete="name"
                    value={profileForm.fullName}
                    onChange={handleProfileFieldChange}
                    size="sm"
                  />
                  <p className="account-label">フリガナ</p>
                  <TextField
                    type="text"
                    name="kanaName"
                    value={profileForm.kanaName}
                    onChange={handleProfileFieldChange}
                    size="sm"
                  />
                  <p className="account-label">メールアドレス</p>
                  <TextField
                    className="bg-[#f5f5f5]"
                    type="email"
                    name="email"
                    value={profileForm.email}
                    readOnly
                    size="sm"
                  />
                  <p className="account-label">電話番号</p>
                  <TextField
                    type="tel"
                    name="phone"
                    autoComplete="tel"
                    inputMode="numeric"
                    value={profileForm.phone}
                    onChange={handleProfileFieldChange}
                    size="sm"
                  />
                  <div className="account-actions">
                    <Button
                      type="submit"
                      size="sm"
                      className="font-acumin"
                      disabled={isSavingProfile}
                    >
                      {isSavingProfile
                        ? "保存中..."
                        : hasSavedProfile
                          ? "変更を保存"
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
                <p className="text-[#474747] account-feedback">読み込み中...</p>
              ) : null}
              {profileMessage ? (
                <p className="text-green-700 account-feedback">
                  {profileMessage}
                </p>
              ) : null}
              {profileError ? (
                <p className="text-red-600 account-feedback">{profileError}</p>
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

                  {addresses.map((item) => (
                    <div key={item.id} className="account-card account-groups">
                      {item.isDefault ? (
                        <span className="account-status">メイン</span>
                      ) : null}
                      <div className="account-field">
                        <p className="account-label">郵便番号</p>
                        <p className="account-value">
                          {item.postalCode || "-"}
                        </p>
                      </div>
                      <div className="account-field">
                        <p className="account-label">住所</p>
                        <p className="account-value">
                          {formatAddressLines(item)}
                        </p>
                      </div>
                      <div className="account-actions">
                        {!item.isDefault ? (
                          <Button
                            type="button"
                            size="sm"
                            className="font-acumin"
                            onClick={() => handleSetMainAddress(item.id)}
                          >
                            メインにする
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          className="font-acumin"
                          onClick={() => openEditAddress(item)}
                        >
                          変更する
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          className="font-acumin"
                          onClick={() => handleAddressDelete(item.id)}
                        >
                          削除する
                        </Button>
                      </div>
                    </div>
                  ))}

                  <div className="account-actions">
                    <Button
                      type="button"
                      size="sm"
                      className="font-acumin"
                      onClick={openAddAddress}
                    >
                      住所を追加
                    </Button>
                  </div>
                </>
              ) : null}

              {!isLoadingProfile && isEditingAddress ? (
                <form
                  className="account-form account-card"
                  onSubmit={handleAddressSave}
                >
                  <p className="account-label">郵便番号</p>
                  <TextField
                    type="text"
                    name="postalCode"
                    autoComplete="postal-code"
                    inputMode="numeric"
                    value={addressForm.postalCode}
                    onChange={handleAddressFieldChange}
                    size="sm"
                  />
                  <p className="account-label">都道府県</p>
                  <SingleSelect
                    name="prefecture"
                    variant="dropdown"
                    block
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
                  <p className="account-label">市区町村</p>
                  <TextField
                    type="text"
                    name="city"
                    autoComplete="address-level2"
                    value={addressForm.city}
                    onChange={handleAddressFieldChange}
                    size="sm"
                  />
                  <p className="account-label">番地</p>
                  <TextField
                    type="text"
                    name="address"
                    autoComplete="street-address"
                    value={addressForm.address}
                    onChange={handleAddressFieldChange}
                    size="sm"
                  />
                  <p className="account-label">建物名・部屋番号</p>
                  <TextField
                    type="text"
                    name="building"
                    value={addressForm.building}
                    onChange={handleAddressFieldChange}
                    size="sm"
                  />
                  <div className="account-actions">
                    <Button type="submit" size="sm" disabled={isSavingProfile}>
                      {isSavingProfile
                        ? "保存中..."
                        : editingAddressId === "new"
                          ? "保存する"
                          : "変更を保存"}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
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
                <p className="text-[#474747] account-feedback">
                  注文履歴を読み込み中...
                </p>
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

              {orders.map((order) => (
                <article key={order.id} className="account-card account-groups">
                  <div className="account-order-head">
                    <div className="account-order-meta">
                      <p className="account-label">注文番号</p>
                      <p className="text-black" style={accountTextLgStyle}>
                        {order.orderNumber}
                      </p>
                    </div>
                    <div className="account-order-meta">
                      <p className="account-label">注文日</p>
                      <p className="account-value">{order.orderDate}</p>
                    </div>
                  </div>

                  <div className="account-order-items">
                    {order.items.map((item) => (
                      <div key={item.id} className="account-order-item">
                        {item.imageUrl ? (
                          <Image
                            src={item.imageUrl}
                            alt={item.name}
                            width={80}
                            height={80}
                            className="rounded object-cover"
                          />
                        ) : null}
                        <div className="account-order-lines">
                          <p className="account-value">{item.name}</p>
                          <div>
                            <p className="account-label">
                              {item.color} / {item.size}
                            </p>
                            <p className="account-label">
                              数量: {item.quantity}
                            </p>
                          </div>
                          <p className="account-value">{item.amount}</p>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="account-order-foot">
                    <span className="account-status">{order.status}</span>
                    <div className="account-order-meta">
                      <p className="account-label">商品点数</p>
                      <p className="text-black" style={accountTextXlStyle}>
                        {order.itemCount}点
                      </p>
                    </div>
                    <div className="account-order-meta">
                      <p className="account-label">合計</p>
                      <p className="text-black" style={accountTextXlStyle}>
                        {order.totalAmount}
                      </p>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          ) : null}

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
