"use client";

import React, { Suspense, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import Link from "next/link";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { loadStripe, type Appearance } from "@stripe/stripe-js";
import {
  CheckoutProvider,
  PaymentElement,
  useCheckout,
  type StripeUseCheckoutResult,
} from "@stripe/react-stripe-js/checkout";
import { Button } from "@/components/ui/Button/Button";
import { Checkbox } from "@/components/ui/Checkbox/Checkbox";
import { useCart } from "@/contexts/CartContext";
import { useLogin } from "@/contexts/LoginContext";
import { clientFetch } from "@/lib/client-fetch";
import { formatPhoneNumberInput } from "@/features/account/utils/profile-format.util";
import {
  formatPostalCodeInput,
  isCompletePostalCode,
  normalizePostalCode,
} from "@/features/checkout/utils/postal-code.util";
import { calculateCheckoutAmountsFromSubtotal } from "@/features/checkout/services/checkout-pricing.service";
import {
  mapPaymentMethodLabel,
  toCheckoutRequestPaymentMethod,
  toRecordedPaymentMethod,
} from "@/features/checkout/services/payment-method.service";
import { GuestRegisterPrompt } from "@/features/checkout/components/GuestRegisterPrompt";
import { SingleSelect } from "@/components/ui/SingleSelect/SingleSelect";
import { LiveMessage } from "@/components/ui/LiveMessage/LiveMessage";
import { TextField } from "@/components/ui/TextField/TextField";
import { PREFECTURES } from "@/lib/constants/prefectures";
import "./checkout.css";

const stripePromise = loadStripe(
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "",
);

// clientSecret を「後から解決する Promise」として CheckoutProvider に渡すための入れ物。
// Promise.withResolvers は iOS Safari 17.4 未満に無いため自前で用意する。
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

// Stripe Payment Element appearance (ブランドトークンに合わせたカスタマイズ)
const stripeAppearance: Appearance = {
  theme: "stripe",
  variables: {
    colorBackground: "#ffffff",
    colorText: "#000000",
    colorPrimary: "#000000",
    colorTextSecondary: "#474747",
    colorDanger: "#dc2626",
    fontFamily: "acumin-pro, sans-serif",
    fontSizeBase: "13px",
    fontWeightNormal: "400",
    fontWeightMedium: "600",
    borderRadius: "0.375rem",
    spacingUnit: "3px",
  },
  rules: {
    ".Input": {
      border: "1px solid rgba(0,0,0,0.2)",
      borderRadius: "0.375rem",
      backgroundColor: "#ffffff",
      color: "#000000",
      fontFamily: "acumin-pro, sans-serif",
      padding: "0.5rem 0.75rem",
    },
    ".Input:focus": {
      borderColor: "#000000",
      boxShadow: "0 0 0 3px rgba(0,0,0,0.15)",
    },
    ".Input::placeholder": {
      color: "rgba(0,0,0,0.4)",
    },

    ".Label": {
      color: "#474747",
      fontWeight: "600",
      fontSize: "0.6875rem",
      letterSpacing: "0.05em",
    },

    ".Button": {
      backgroundColor: "#000000",
      color: "#ffffff",
      borderRadius: "0.375rem",
      fontFamily: "acumin-pro, sans-serif",
      fontWeight: "600",
      padding: "0.5rem 0.75rem",
    },
    ".Button:hover": {
      backgroundColor: "#474747",
    },

    ".Error": {
      color: "#dc2626",
      fontWeight: "600",
    },

    ".Tab": {
      borderRadius: "0.375rem",
      border: "1px solid rgba(0,0,0,0.2)",
      backgroundColor: "#ffffff",
      color: "#000000",
      padding: "0.5rem 0.75rem",
    },
    ".Tab--selected": {
      backgroundColor: "#000000",
      color: "#ffffff",
    },

    ".Checkbox": {
      borderColor: "rgba(0,0,0,0.2)",
      borderRadius: "0.375rem",
      backgroundColor: "#ffffff",
    },
    ".Checkbox:checked": {
      backgroundColor: "#000000",
      borderColor: "#000000",
    },
  },
};

const CHECKOUT_STEPS = [
  { id: 1, label: "注文を確定する" },
  { id: 2, label: "ご注文内容の確認" },
];

// 必須欄の DOM 出現順。未入力時はこの順で最初の欄へカーソルと画面を移す。
const SHIPPING_FIELD_ORDER = [
  "fullName",
  "kanaName",
  "email",
  "phone",
  "postalCode",
  "prefecture",
  "city",
  "address",
] as const;

type CheckoutProfileResponse = {
  email?: string;
  fullName?: string;
  kanaName?: string;
  phone?: string;
  address?: {
    postalCode?: string;
    prefecture?: string;
    city?: string;
    address?: string;
    building?: string;
  };
};

type SavedAddress = {
  id: string;
  postalCode: string;
  prefecture: string;
  city: string;
  address: string;
  building: string;
  isDefault: boolean;
};

// プルダウンの「新規」選択肢を表すセンチネル値
const NEW_ADDRESS_VALUE = "__new__";

// 決済の準備に失敗した理由を出す場所。押せないボタンから aria-describedby で指す（FREQ-385）
const CHECKOUT_SESSION_ERROR_ID = "checkout-session-error-message";

type ShippingFormFields = {
  email: string;
  fullName: string;
  kanaName: string;
  postalCode: string;
  prefecture: string;
  city: string;
  address: string;
  building: string;
  phone: string;
};

// 注文に必要な配送先が揃っているか（fieldErrors を更新しない純粋判定）
function isShippingComplete(form: ShippingFormFields): boolean {
  if (!form.email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email))
    return false;
  if (!form.fullName.trim()) return false;
  if (!form.postalCode.trim() || !/^\d{3}-?\d{4}$/.test(form.postalCode))
    return false;
  if (!form.prefecture) return false;
  if (!form.city.trim()) return false;
  if (!form.address.trim()) return false;
  if (
    !form.phone.trim() ||
    !/^[\d\-+()]{10,}$/.test(form.phone.replace(/\s/g, ""))
  )
    return false;
  return true;
}

/**
 * サーバが持つ配送先スナップショットの版番号を取り込む（FREQ-365）。
 *
 * 配送先はデバウンス同期・確定直前の同期・別タブの create-session から書き換わる。
 * 書き込みは「この版と一致するときだけ」適用されるので、遅れて届いた古い内容が
 * 新しい内容を消すことがない。版番号は増える一方なので、古い応答では巻き戻さない。
 */
function adoptShippingRevision(
  ref: React.MutableRefObject<number>,
  value: unknown,
): void {
  const next = Number(value);
  if (Number.isFinite(next) && next > ref.current) {
    ref.current = next;
  }
}

// 配送先の同一性キー（再生成の要否判定用）
function shippingKeyOf(form: ShippingFormFields): string {
  return [
    form.email,
    form.fullName,
    form.kanaName,
    form.postalCode,
    form.prefecture,
    form.city,
    form.address,
    form.building,
    form.phone,
  ].join("|");
}

// カート空表示（ORDER SUMMARY の2分岐で共通利用）
function EmptyCartMessage() {
  return (
    <p className="text-gray-500" style={{ fontSize: "var(--lk-size-sm)" }}>
      カートに商品がありません
    </p>
  );
}

// cart data for order summary (mirrors cart/page.tsx)
interface CartItem {
  id: string;
  item_id: number;
  quantity: number;
  color: string | null;
  size: string | null;
  added_at: string;
  items: {
    id: number;
    name: string;
    price: number;
    image_url: string;
    category: string;
  } | null;
}

// ここから CheckoutPageContent までの部品は、画面の関数の外（モジュールの最上位）に置く。
// 画面の関数の中で定義すると、再描画のたびに別の部品として作り直され、入力中のコード・
// 表示中の案内・フォーカスが消える（FREQ-372。React 公式: 部品の定義は入れ子にしない）。

// プロモーションコード入力 (Stripe Checkout の promotion code を適用/解除)
function PromoCodeField() {
  const checkout = useCheckout();
  const inputId = useId();
  const errorId = useId();
  const [code, setCode] = useState("");
  const [applying, setApplying] = useState(false);
  const [promoError, setPromoError] = useState<string | null>(null);

  if (checkout.type !== "success") {
    return null;
  }

  const applied = checkout.checkout.discountAmounts?.[0] ?? null;

  const handleApply = async () => {
    const trimmed = code.trim();
    if (!trimmed) return;
    setApplying(true);
    setPromoError(null);
    try {
      const result = await checkout.checkout.applyPromotionCode(trimmed);
      if (result.type === "error") {
        setPromoError(result.error.message ?? "コードを適用できませんでした。");
        return;
      }
      setCode("");
    } finally {
      setApplying(false);
    }
  };

  const handleRemove = async () => {
    setApplying(true);
    setPromoError(null);
    try {
      await checkout.checkout.removePromotionCode();
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="checkout-section">
      {/* 見出しを入力欄に結びつける（FREQ-373）。適用済みのときは入力欄が無いので結びつけない */}
      <label className="checkout-label" htmlFor={applied ? undefined : inputId}>
        プロモーションコード
      </label>
      {applied ? (
        <div
          className="checkout-box flex items-center justify-between"
          style={{ gap: "var(--gap-group)" }}
        >
          <span className="checkout-value">
            {applied.promotionCode ?? applied.displayName}
          </span>
          <Button
            type="button"
            variant="text"
            size="xs"
            onClick={handleRemove}
            disabled={applying}
          >
            削除
          </Button>
        </div>
      ) : (
        <div className="checkout-promo">
          <div className="checkout-promo-field">
            <TextField
              id={inputId}
              placeholder="コードを入力"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              size="sm"
              aria-invalid={promoError ? true : undefined}
              aria-describedby={promoError ? errorId : undefined}
            />
          </div>
          <Button
            type="button"
            size="sm"
            onClick={handleApply}
            disabled={applying || !code.trim()}
          >
            {applying ? "適用中..." : "適用"}
          </Button>
        </div>
      )}
      {/* 適用できなかった理由（FREQ-374）。入れ物は常に置き、中身だけを入れ替える（LiveMessage） */}
      <LiveMessage
        id={errorId}
        className="text-red-600"
        style={{ fontSize: "var(--lk-size-2xs)" }}
      >
        {promoError}
      </LiveMessage>
    </div>
  );
}

// Stripe を正とした金額内訳 (小計 / 値引 / 送料 / 合計)。税込みのため消費税行なし。
function StripeOrderTotals() {
  const checkout = useCheckout();
  if (checkout.type !== "success") {
    return null;
  }
  const t = checkout.checkout.total;
  const hasDiscount = t.discount.minorUnitsAmount > 0;

  return (
    <div
      className="checkout-rows"
      style={{
        paddingTop: "var(--card-pad)",
        borderTop: "1px solid rgb(0 0 0 / 0.1)",
      }}
    >
      <div className="checkout-row">
        <span className="checkout-row-muted">小計</span>
        <span>{t.subtotal.amount}</span>
      </div>
      {hasDiscount && (
        <div className="checkout-row">
          <span className="checkout-row-muted">値引</span>
          <span>-{t.discount.amount}</span>
        </div>
      )}
      <div className="checkout-row">
        <span className="checkout-row-muted">配送料</span>
        <span>
          {t.shippingRate.minorUnitsAmount === 0
            ? "無料"
            : t.shippingRate.amount}
        </span>
      </div>
      <div className="checkout-total-row">
        <span className="checkout-total-label">合計</span>
        <span className="checkout-total">{t.total.amount}</span>
      </div>
    </div>
  );
}

// 「確認へ進む」。押したときの処理（決済の確定）は親の handleConfirmPayment が持つ。
function ConfirmPaymentButton({
  onConfirm,
  sessionLoading,
  confirming,
  hasClientSecret,
}: {
  onConfirm: (checkout: StripeUseCheckoutResult) => void;
  sessionLoading: boolean;
  confirming: boolean;
  hasClientSecret: boolean;
}) {
  const checkout = useCheckout();

  // 決済フォームの初期化が終わるまでは押させない（FREQ-367）。
  // 押せてしまうと「初期化が完了していません」を返すだけで先へ進めず、客には何が
  // 起きたのか分からない。押せる状態＝決済に進める状態に揃える。
  // 押せない理由が伝わらないと迷わせるので、表示も「準備中」に変える。
  const isCheckoutReady = checkout.type === "success";

  return (
    <Button
      type="button"
      size="lg"
      className="flex-1"
      onClick={() => onConfirm(checkout)}
      disabled={
        sessionLoading || confirming || !hasClientSecret || !isCheckoutReady
      }
    >
      {confirming
        ? "決済処理中..."
        : isCheckoutReady
          ? "確認へ進む"
          : "決済フォームを準備中..."}
    </Button>
  );
}

// 注文明細 (カート商品リスト)。フックなしの共有表示。
function OrderItems({ cartItems }: { cartItems: CartItem[] }) {
  return (
    <div className="checkout-items">
      {cartItems.map((item) => {
        const product = item.items;
        if (!product) return null;

        return (
          <div className="checkout-item" key={item.id}>
            <div className="w-20 h-24 shrink-0 overflow-hidden relative">
              <Image
                alt={product.name}
                className="image"
                src={product.image_url}
                width={400}
                height={500}
              />
            </div>
            <div className="checkout-item-lines">
              <p className="checkout-value">{product.name}</p>
              <div>
                <p className="checkout-label">
                  {item.color} / {item.size}
                </p>
                <p className="checkout-label">数量: {item.quantity}</p>
              </div>
              <p className="checkout-value">
                ¥{product.price.toLocaleString()}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// セッション未生成時のカート由来の金額内訳 (値引なし・税込み)。
function CartTotals({
  subtotal,
  shipping,
  total,
}: {
  subtotal: number;
  shipping: number;
  total: number;
}) {
  return (
    <div className="checkout-rows">
      <div className="checkout-row">
        <span className="checkout-row-muted">小計</span>
        <span>¥{subtotal.toLocaleString()}</span>
      </div>
      <div className="checkout-row">
        <span className="checkout-row-muted">配送料</span>
        <span>{shipping === 0 ? "無料" : `¥${shipping.toLocaleString()}`}</span>
      </div>
      <div className="checkout-total-row">
        <span className="checkout-total-label">合計</span>
        <span className="checkout-total">¥{total.toLocaleString()}</span>
      </div>
    </div>
  );
}

// 配送先カード (住所のみ)。読み取り専用表示。
function AddressCard({
  address,
}: {
  address: Pick<
    ShippingFormFields,
    "postalCode" | "prefecture" | "city" | "address" | "building"
  >;
}) {
  return (
    <div className="checkout-card">
      {address.postalCode && <p>〒{address.postalCode}</p>}
      <p>
        {address.prefecture}
        {address.city}
        {address.address}
      </p>
      {address.building && <p>{address.building}</p>}
    </div>
  );
}

function CheckoutPageContent() {
  const mdTextStyle: React.CSSProperties = { fontSize: "var(--lk-size-md)" };

  const [cartItems, setCartItems] = useState<CartItem[]>([]);
  const [cartLoading, setCartLoading] = useState(true);

  // Server and UI must share the same pricing policy to avoid checkout amount mismatch.
  const subtotal = cartItems.reduce(
    (sum, item) => sum + (item.items?.price ?? 0) * item.quantity,
    0,
  );
  const checkoutAmounts = calculateCheckoutAmountsFromSubtotal(subtotal);
  const shipping = checkoutAmounts.shippingAmount;
  const tax = checkoutAmounts.taxAmount;
  const total = checkoutAmounts.totalAmount;

  React.useEffect(() => {
    const fetchCart = async () => {
      try {
        const res = await fetch("/api/cart");
        if (res.ok) {
          const data: CartItem[] = await res.json();
          setCartItems(data.filter((ci) => ci.items !== null));
        }
      } catch (err) {
        console.error("カート取得エラー", err);
      } finally {
        setCartLoading(false);
      }
    };
    fetchCart();
  }, []);

  const [step, setStep] = useState<number>(1);
  // 決済フォームで選ばれている手段（change イベントの value.type を丸めずに持つ）。
  // カード以外を stripe_card に丸めると、Link や銀行振込でも確認画面に「カード」と出る（FREQ-371）。
  const [selectedPaymentType, setSelectedPaymentType] = useState<string | null>(
    null,
  );
  // 注文に記録される値（確認画面の表示に使う）と、API に送る値（3手段のみ）
  const recordedPaymentMethod = toRecordedPaymentMethod(selectedPaymentType);
  const paymentMethod = toCheckoutRequestPaymentMethod(selectedPaymentType);
  const [customSessionLoading, setCustomSessionLoading] = useState(false);
  const [customCheckoutClientSecret, setCustomCheckoutClientSecret] = useState<
    string | null
  >(null);
  const [customCheckoutSessionId, setCustomCheckoutSessionId] = useState<
    string | null
  >(null);
  // CheckoutProvider は初回描画から置き、clientSecret は決済セッションの取得時に解決する（FREQ-358）。
  // 取得のたびに Provider を差し込むと左列の入力欄が再マウントされ、入力中のフォーカスや
  // 日本語変換が失われる。再試行で取得した場合も同じ Promise を解決する（Provider は作り直さない）。
  const [clientSecretDeferred] = useState(() => createDeferred<string>());
  const checkoutProviderOptions = React.useMemo(
    () => ({
      clientSecret: clientSecretDeferred.promise,
      elementsOptions: { appearance: stripeAppearance },
    }),
    [clientSecretDeferred],
  );
  // 確認ステップ表示用に確定時の金額(Stripe値引反映後)を保持
  const [confirmedSummary, setConfirmedSummary] = useState<{
    subtotal: string;
    discount: string;
    shipping: string;
    total: string;
    discountMinor: number;
  } | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [sessionErrorRetryable, setSessionErrorRetryable] = useState(true);
  const [sessionErrorCorrelationId, setSessionErrorCorrelationId] = useState<
    string | null
  >(null);
  // 在庫切れや 422 など、待っても直らない理由で決済の準備が失敗した状態。
  // ここで代替の「確認へ進む」を押せると、原因の案内が「準備しています」に置き換わり、
  // 再試行ボタンも出ないまま待たせることになる（FREQ-385）。
  const sessionBlocked = Boolean(checkoutError) && !sessionErrorRetryable;
  const [profileSaveError, setProfileSaveError] = useState<string | null>(null);
  const [confirmingPayment, setConfirmingPayment] = useState(false);
  const [confirmingOrder, setConfirmingOrder] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [completedOrderId, setCompletedOrderId] = useState<string | null>(null);
  // 決済から戻ったとき、確定を送った決済セッションを覚える（FREQ-378）。state だと次の描画まで反映されず、
  // 先に依存（updateCartCount）が変わった描画で effect が走り直して二重に送ることがあった。ref は即座に変わる
  const finalizedSessionIdRef = useRef<string | null>(null);
  const latestPostalLookupRef = useRef("");
  const router = useRouter();
  const searchParams = useSearchParams();
  const { updateCartCount } = useCart();
  const { isLoggedIn } = useLogin();
  const [shippingForm, setShippingForm] = useState({
    email: "",
    fullName: "",
    kanaName: "",
    postalCode: "",
    prefecture: "",
    city: "",
    address: "",
    building: "",
    phone: "",
    saveProfile: false,
  });
  // お客様情報の編集トグル (ログイン済+設定済の読み取り表示 ⇔ 編集フォーム)
  const [editingCustomer, setEditingCustomer] = useState(false);
  const [savingCustomer, setSavingCustomer] = useState(false);
  const [customerError, setCustomerError] = useState<string | null>(null);
  // 編集開始前のお客様情報（キャンセルで復元）
  const customerSnapshotRef = useRef<{
    fullName: string;
    kanaName: string;
    phone: string;
  } | null>(null);
  const {
    email,
    fullName,
    kanaName,
    postalCode,
    prefecture,
    city,
    address,
    building,
    phone,
  } = shippingForm;

  // 保存済み配送先（複数住所から選択）
  const [savedAddresses, setSavedAddresses] = useState<SavedAddress[]>([]);
  const [selectedAddressId, setSelectedAddressId] = useState<string>("");
  // 現在のセッションのドラフトに反映済みの配送先キー（「新規」入力時の同期判定）
  const [syncedShippingKey, setSyncedShippingKey] = useState<string | null>(
    null,
  );
  // サーバが持つ配送先の版番号（FREQ-365）。同期のたびに最新化する。
  const shippingRevisionRef = React.useRef(0);

  // フィールドごとのバリデーションエラー (FR-CHECKOUT-004)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  React.useEffect(() => {
    const fetchProfileDefaults = async () => {
      try {
        const response = await clientFetch("/api/profile", {
          cache: "no-store",
        });
        if (!response.ok) {
          return;
        }

        const data = (await response.json()) as CheckoutProfileResponse;

        setShippingForm((prev) => ({
          ...prev,
          email:
            prev.email || (typeof data.email === "string" ? data.email : ""),
          fullName:
            prev.fullName ||
            (typeof data.fullName === "string" ? data.fullName : ""),
          kanaName:
            prev.kanaName ||
            (typeof data.kanaName === "string" ? data.kanaName : ""),
          postalCode:
            prev.postalCode ||
            formatPostalCodeInput(
              typeof data.address?.postalCode === "string"
                ? data.address.postalCode
                : "",
            ),
          prefecture:
            prev.prefecture ||
            (typeof data.address?.prefecture === "string"
              ? data.address.prefecture
              : ""),
          city:
            prev.city ||
            (typeof data.address?.city === "string" ? data.address.city : ""),
          address:
            prev.address ||
            (typeof data.address?.address === "string"
              ? data.address.address
              : ""),
          building:
            prev.building ||
            (typeof data.address?.building === "string"
              ? data.address.building
              : ""),
          phone:
            prev.phone ||
            formatPhoneNumberInput(
              typeof data.phone === "string" ? data.phone : "",
            ),
        }));
      } catch (error) {
        console.error("プロフィール初期値の取得に失敗しました", error);
      }
    };

    void fetchProfileDefaults();
  }, []);

  React.useEffect(() => {
    const fetchSavedAddresses = async () => {
      try {
        const response = await clientFetch("/api/profile/addresses", {
          cache: "no-store",
        });
        if (!response.ok) {
          return;
        }

        const data = (await response.json()) as { addresses?: SavedAddress[] };
        const list = Array.isArray(data.addresses) ? data.addresses : [];
        setSavedAddresses(list);

        const initial = list.find((item) => item.isDefault) ?? list[0];
        if (initial) {
          setSelectedAddressId(initial.id);
        }
      } catch (error) {
        console.error("保存済み配送先の取得に失敗しました", error);
      }
    };

    void fetchSavedAddresses();
  }, []);

  const handleSelectSavedAddress = (id: string) => {
    setSelectedAddressId(id);

    // 「新規」選択時は住所欄をクリアして編集フォームを表示する。
    // セッションは破棄せず、決済フォーム/プロモ表示を維持したまま編集させる
    // （入力済み住所がドラフトへ反映されるまでは Confirm をゲート: syncedShippingKey）。
    if (id === NEW_ADDRESS_VALUE) {
      setShippingForm((prev) => ({
        ...prev,
        postalCode: "",
        prefecture: "",
        city: "",
        address: "",
        building: "",
      }));
      setFieldErrors((prev) => ({
        ...prev,
        postalCode: "",
        prefecture: "",
        city: "",
        address: "",
      }));
      setSyncedShippingKey(null);
      setCheckoutError(null);
      return;
    }

    const target = savedAddresses.find((item) => item.id === id);
    if (!target) {
      return;
    }

    setShippingForm((prev) => ({
      ...prev,
      postalCode: formatPostalCodeInput(target.postalCode ?? ""),
      prefecture: target.prefecture ?? "",
      city: target.city ?? "",
      address: target.address ?? "",
      building: target.building ?? "",
    }));
    setFieldErrors((prev) => ({
      ...prev,
      postalCode: "",
      prefecture: "",
      city: "",
      address: "",
    }));
    // セッションは維持し、ドラフトのみ同期 effect で更新（画面全体の再読み込みを避ける）。
    // 同期完了まで Confirm をゲートするためキーをリセット。
    setSyncedShippingKey(null);
  };

  const validateShippingForm = (): Record<string, string> => {
    const errors: Record<string, string> = {};
    if (!shippingForm.email.trim()) {
      errors.email = "メールアドレスを入力してください";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(shippingForm.email)) {
      errors.email = "正しいメールアドレスを入力してください";
    }
    if (!shippingForm.fullName.trim()) {
      errors.fullName = "氏名を入力してください";
    }
    if (!shippingForm.kanaName.trim()) {
      errors.kanaName = "フリガナを入力してください";
    }
    if (!shippingForm.postalCode.trim()) {
      errors.postalCode = "郵便番号を入力してください";
    } else if (!/^\d{3}-?\d{4}$/.test(shippingForm.postalCode)) {
      errors.postalCode = "正しい郵便番号を入力してください（例: 123-4567）";
    }
    if (!shippingForm.prefecture) {
      errors.prefecture = "都道府県を選択してください";
    }
    if (!shippingForm.city.trim()) {
      errors.city = "市区町村を入力してください";
    }
    if (!shippingForm.address.trim()) {
      errors.address = "番地を入力してください";
    }
    if (!shippingForm.phone.trim()) {
      errors.phone = "電話番号を入力してください";
    } else if (
      !/^[\d\-+()]{10,}$/.test(shippingForm.phone.replace(/\s/g, ""))
    ) {
      errors.phone = "正しい電話番号を入力してください";
    }
    setFieldErrors(errors);
    return errors;
  };

  // 未入力・不正の必須欄のうち DOM 順で最初のものへカーソルと画面を移す。
  const focusFirstError = (errors: Record<string, string>) => {
    const target = SHIPPING_FIELD_ORDER.find((name) => errors[name]);
    if (!target) {
      return;
    }
    const moveTo = (element: HTMLElement) => {
      // focus 単体だと瞬間ジャンプになるのでスクロールは分けて滑らかに動かす
      element.focus({ preventScroll: true });
      element.scrollIntoView({ behavior: "smooth", block: "center" });
    };
    const element = document.getElementById(target);
    if (element) {
      moveTo(element);
      return;
    }
    if (
      target === "postalCode" ||
      target === "prefecture" ||
      target === "city" ||
      target === "address"
    ) {
      // 保存済み住所選択中は住所入力欄が DOM にない。新規入力フォームを開いてから移る。
      flushSync(() => setSelectedAddressId(NEW_ADDRESS_VALUE));
    } else {
      // お客様情報が読み取り表示のときは入力欄が DOM にない。編集フォームを開いてから移る。
      flushSync(() => setEditingCustomer(true));
    }
    const opened = document.getElementById(target);
    if (opened) {
      moveTo(opened);
    }
  };

  const createCustomCheckoutSession = React.useCallback(async () => {
    setCheckoutError(null);
    setSessionErrorRetryable(true);
    setSessionErrorCorrelationId(null);
    setCustomSessionLoading(true);

    try {
      const displayedAmounts = {
        subtotalAmount: subtotal,
        shippingAmount: shipping,
        taxAmount: tax,
        totalAmount: total,
      };

      const response = await clientFetch("/api/checkout/create-session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          uiMode: "custom",
          paymentMethod,
          displayedAmounts,
          shipping: {
            email,
            fullName,
            kanaName,
            postalCode,
            prefecture,
            city,
            address,
            building,
            phone,
          },
        }),
      });

      if (!response.ok) {
        const errorData: {
          error?: string;
          message?: string;
          correlationId?: string;
          retryable?: boolean;
        } = await response.json().catch(() => ({}));

        // 在庫切れエラーは専用のメッセージを表示 (FR-CHECKOUT-007)
        if (errorData.error === "out_of_stock" && errorData.message) {
          setSessionErrorRetryable(false);
          throw new Error(errorData.message);
        }

        setSessionErrorRetryable(errorData.retryable ?? true);
        setSessionErrorCorrelationId(errorData.correlationId ?? null);
        throw new Error(
          errorData.message ?? "決済セッションの初期化に失敗しました。",
        );
      }

      const data: {
        clientSecret?: string;
        checkoutSessionId?: string;
        shippingRevision?: number;
      } = await response.json();
      if (!data.clientSecret || !data.checkoutSessionId) {
        throw new Error(
          "決済セッションの初期化に必要な client_secret が取得できませんでした。",
        );
      }

      const normalizedClientSecret = decodeURIComponent(data.clientSecret);
      setCustomCheckoutClientSecret(normalizedClientSecret);
      clientSecretDeferred.resolve(normalizedClientSecret);
      setCustomCheckoutSessionId(data.checkoutSessionId);
      // サーバが持つ配送先の版番号。以降の同期はこの版と一致するときだけ適用される。
      adoptShippingRevision(shippingRevisionRef, data.shippingRevision);
      // POST した配送先と同一キーを「同期済み」として記録（Confirm ゲート解除用）
      setSyncedShippingKey(
        shippingKeyOf({
          email,
          fullName,
          kanaName,
          postalCode,
          prefecture,
          city,
          address,
          building,
          phone,
        }),
      );
    } catch (error) {
      setCheckoutError(
        error instanceof Error
          ? error.message
          : "決済セッションの初期化に失敗しました。",
      );
      // ref はここでは戻さない。自動リトライ（キーストロークごとの再送信）を防ぐため、
      // リセットは「再試行する」ボタンの明示的な操作でのみ行う。
    } finally {
      setCustomSessionLoading(false);
    }
  }, [
    clientSecretDeferred,
    paymentMethod,
    subtotal,
    shipping,
    tax,
    total,
    email,
    fullName,
    kanaName,
    postalCode,
    prefecture,
    city,
    address,
    building,
    phone,
  ]);

  // 配送先変更時、Stripe セッションは作り直さずドラフトの shipping_snapshot だけ更新する
  // （clientSecret 不変＝決済フォーム/プロモを再読み込みさせない）
  // 呼び出しごとに採番し、後から解決した古い呼び出しが新しい呼び出しの結果を
  // 上書きしないようにする（デバウンス POST のレスポンス順序の逆転対策）。
  const shippingSyncRequestIdRef = React.useRef(0);
  const syncDraftShippingOnce = React.useCallback(async (): Promise<
    string | null
  > => {
    if (!customCheckoutSessionId) return null;
    const requestId = ++shippingSyncRequestIdRef.current;
    try {
      const response = await clientFetch("/api/checkout/update-shipping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkoutSessionId: customCheckoutSessionId,
          shipping: {
            email,
            fullName,
            kanaName,
            postalCode,
            prefecture,
            city,
            address,
            building,
            phone,
          },
          // 見た版と一致するときだけ書き込ませる（FREQ-365）。
          expectedRevision: shippingRevisionRef.current,
        }),
      });

      // 409 = 別タブや遅れて届いた同期が先に版を進めた。サーバの現在の版を取り込み、
      // この呼び出しは失敗として扱う。同期済みの記録も落として、次の同期で書き直す。
      if (response.status === 409) {
        const conflict: { revision?: number } = await response
          .json()
          .catch(() => ({}));
        adoptShippingRevision(shippingRevisionRef, conflict.revision);
        setSyncedShippingKey(null);
        return null;
      }

      if (!response.ok) return null;

      const result: { revision?: number } = await response
        .json()
        .catch(() => ({}));
      adoptShippingRevision(shippingRevisionRef, result.revision);

      const nextKey = shippingKeyOf({
        email,
        fullName,
        kanaName,
        postalCode,
        prefecture,
        city,
        address,
        building,
        phone,
      });
      // この呼び出しより後に発行された呼び出しが既にあれば、この結果は破棄する
      if (requestId !== shippingSyncRequestIdRef.current) return null;
      setSyncedShippingKey(nextKey);
      return nextKey;
    } catch (error) {
      console.error("配送先の同期に失敗しました", error);
      return null;
    }
  }, [
    customCheckoutSessionId,
    email,
    fullName,
    kanaName,
    postalCode,
    prefecture,
    city,
    address,
    building,
    phone,
  ]);

  // 同じタブからの書き込みは直列化する（FREQ-365）。
  // デバウンスの同期が飛んでいる最中に「確認へ進む」を押すと、同じ版番号で2つ投げることになり、
  // 後から届いた方がサーバに弾かれる（409）。確定直前の同期が弾かれると決済へ進めないので、
  // 前の同期の完了を待ってから、更新された版番号で書き込む。
  const shippingSyncQueueRef = React.useRef<Promise<string | null>>(
    Promise.resolve(null),
  );
  const updateDraftShipping = React.useCallback((): Promise<string | null> => {
    const queued = shippingSyncQueueRef.current
      .catch(() => null)
      .then(() => syncDraftShippingOnce());
    shippingSyncQueueRef.current = queued;
    return queued;
  }, [syncDraftShippingOnce]);

  React.useEffect(() => {
    setCheckoutError(null);
  }, [recordedPaymentMethod]);

  const hasSavedAddress = savedAddresses.length > 0;
  // 住所の入力フォーム（と「この配送先を保存する」）を出している状態。
  // 表示と保存の条件を1つにまとめる。別々に書くと、保存済み住所が0件のログイン客で
  // 「フォームは出るのに保存されない」ようにずれる（FREQ-366）。
  const isEnteringNewAddress =
    selectedAddressId === NEW_ADDRESS_VALUE || !hasSavedAddress;

  // 配送先プルダウンの選択肢（先頭に「新規」、以降に保存済み住所）
  const addressOptions = [
    { value: NEW_ADDRESS_VALUE, label: "新規" },
    ...savedAddresses.map((item) => ({
      value: item.id,
      label: `〒${formatPostalCodeInput(item.postalCode ?? "")}\n${[item.prefecture, item.city, item.address, item.building].filter(Boolean).join("")}`,
    })),
  ];

  // StrictMode の二重実行と再レンダリングによる多重生成を止めるためのガード
  const sessionRequestStartedRef = React.useRef(false);

  // カートが確定した時点で決済セッションを1回だけ生成する（配送先は空でよい）。
  // 住所は後から /api/checkout/update-shipping でドラフトへ反映する。
  React.useEffect(() => {
    if (step !== 1) return;
    if (cartLoading) return;
    if (cartItems.length === 0) return;
    if (customCheckoutClientSecret) return;
    if (sessionRequestStartedRef.current) return;

    sessionRequestStartedRef.current = true;
    void createCustomCheckoutSession();
  }, [
    step,
    cartLoading,
    cartItems.length,
    customCheckoutClientSecret,
    createCustomCheckoutSession,
  ]);

  // 配送先（新規入力・保存済み切替）が変わったらドラフトのみ更新して同期（デバウンス）
  React.useEffect(() => {
    if (step !== 1) return;
    if (confirmingPayment) return;
    if (!customCheckoutClientSecret || !customCheckoutSessionId) return;
    if (!isShippingComplete(shippingForm)) return;
    if (shippingKeyOf(shippingForm) === syncedShippingKey) return;

    const timer = setTimeout(() => {
      void updateDraftShipping();
    }, 500);
    return () => clearTimeout(timer);
  }, [
    step,
    confirmingPayment,
    customCheckoutClientSecret,
    customCheckoutSessionId,
    shippingForm,
    syncedShippingKey,
    updateDraftShipping,
  ]);

  React.useEffect(() => {
    const sessionId = searchParams.get("session_id");

    if (!sessionId) return;
    if (finalizedSessionIdRef.current === sessionId) return;

    finalizedSessionIdRef.current = sessionId;

    const finalizeOrder = async () => {
      setConfirmingOrder(true);
      setConfirmError(null);

      try {
        const response = await fetch("/api/checkout/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ checkoutSessionId: sessionId }),
        });

        if (!response.ok) {
          throw new Error(
            "注文確定に失敗しました。時間をおいて再度お試しください。",
          );
        }

        const data: { orderId?: string } = await response.json();
        if (data.orderId) {
          setCompletedOrderId(data.orderId);
        }
        await updateCartCount();
        setCompleted(true);

        // Remove query params so reloading doesn't re-trigger
        router.replace("/checkout");
      } catch (error) {
        setConfirmError(
          error instanceof Error ? error.message : "注文確定に失敗しました。",
        );
      } finally {
        setConfirmingOrder(false);
      }
    };

    void finalizeOrder();
  }, [searchParams, router, updateCartCount]);

  const handleShippingChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>,
  ) => {
    const { name, value, type } = e.target;
    // Keep incomplete customer profiles editable until an explicit save/cancel.
    if (
      isLoggedIn &&
      !editingCustomer &&
      ["fullName", "kanaName", "email", "phone"].includes(name)
    ) {
      customerSnapshotRef.current = {
        fullName: shippingForm.fullName,
        kanaName: shippingForm.kanaName,
        phone: shippingForm.phone,
      };
      setEditingCustomer(true);
    }
    const nextValue =
      name === "postalCode"
        ? formatPostalCodeInput(value)
        : name === "phone"
          ? formatPhoneNumberInput(value)
          : value;
    const checked =
      type === "checkbox" && "checked" in e.target
        ? (e.target as HTMLInputElement).checked
        : false;

    setShippingForm((prev) => ({
      ...prev,
      [name]: type === "checkbox" ? checked : nextValue,
    }));

    // 入力時にそのフィールドのエラーをクリア
    if (fieldErrors[name]) {
      setFieldErrors((prev) => ({ ...prev, [name]: "" }));
    }

    // 郵便番号自動補完
    if (name === "postalCode") {
      const cleanedZip = normalizePostalCode(nextValue);
      if (!isCompletePostalCode(cleanedZip)) {
        latestPostalLookupRef.current = "";
        return;
      }

      latestPostalLookupRef.current = cleanedZip;
      fetch(`/api/checkout/postal-code?postalCode=${cleanedZip}`)
        .then((res) => res.json())
        .then((data) => {
          if (latestPostalLookupRef.current !== cleanedZip) {
            return;
          }

          const address = data?.address;
          if (address) {
            setShippingForm((prev) => ({
              ...prev,
              prefecture: address.prefecture || prev.prefecture,
              city: address.city || prev.city,
              address: address.address || prev.address,
            }));
          }
        })
        .catch((err) => console.error("郵便番号検索エラー:", err));
    }
  };

  // 「この配送先を保存する」がONのとき、氏名/電話をプロフィールへ・住所を配送先APIへ保存。
  // 成功(または保存対象なし)で true、失敗で false。
  const persistSavedProfileAndAddress = async (): Promise<boolean> => {
    if (!shippingForm.saveProfile) {
      return true;
    }

    if (shippingForm.fullName.trim() || shippingForm.phone.trim()) {
      const profileResponse = await clientFetch("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: shippingForm.fullName.trim(),
          phone: formatPhoneNumberInput(shippingForm.phone.trim()),
        }),
      });

      if (!profileResponse.ok) {
        setProfileSaveError(
          "プロフィールの保存に失敗しました。再度お試しください。",
        );
        return false;
      }
    }

    const newAddress = {
      postalCode: normalizePostalCode(shippingForm.postalCode),
      prefecture: shippingForm.prefecture.trim(),
      city: shippingForm.city.trim(),
      address: shippingForm.address.trim(),
      building: shippingForm.building.trim(),
    };

    if (Object.values(newAddress).some((value) => value.length > 0)) {
      const addressResponse = await clientFetch("/api/profile/addresses", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          addresses: [
            ...savedAddresses.map((item) => ({ ...item, isDefault: false })),
            { ...newAddress, isDefault: true },
          ],
        }),
      });

      if (!addressResponse.ok) {
        setProfileSaveError("配送先の保存に失敗しました。再度お試しください。");
        return false;
      }
    }

    return true;
  };

  const handleConfirm = async (e: React.FormEvent) => {
    e.preventDefault();

    setConfirmingOrder(true);
    setConfirmError(null);

    try {
      const response = await fetch("/api/checkout/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentMethod,
          checkoutSessionId: customCheckoutSessionId,
          shipping: {
            email: shippingForm.email,
            fullName: shippingForm.fullName,
            kanaName: shippingForm.kanaName,
            postalCode: shippingForm.postalCode,
            prefecture: shippingForm.prefecture,
            city: shippingForm.city,
            address: shippingForm.address,
            building: shippingForm.building,
            phone: shippingForm.phone,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(
          "注文確定に失敗しました。時間をおいて再度お試しください。",
        );
      }

      const data: { orderId?: string } = await response.json();
      if (data.orderId) {
        setCompletedOrderId(data.orderId);
      }

      await updateCartCount();
      setCompleted(true);
    } catch (error) {
      setConfirmError(
        error instanceof Error ? error.message : "注文確定に失敗しました。",
      );
    } finally {
      setConfirmingOrder(false);
    }
  };

  // 決済を確定し確認ステップへ。確定時の金額をスナップショット。
  const handleConfirmPayment = async (checkout: StripeUseCheckoutResult) => {
    const errors = validateShippingForm();
    if (Object.keys(errors).length > 0) {
      focusFirstError(errors);
      return;
    }

    if (checkout.type !== "success") {
      setCheckoutError(
        "決済フォームの初期化が完了していません。少し待ってから再度お試しください。",
      );
      return;
    }

    setCheckoutError(null);
    setConfirmingPayment(true);

    try {
      // 確定直前は必ずドラフトへ書き込む（FREQ-365）。
      // 画面の「同期済み」の記憶で省略すると、別タブの上書きや遅れて届いた同期で
      // サーバ側が別の住所になっていても気づけない（check と use の間で変わる）。
      // 書き込みは版番号つきなので、古い内容に負けることもない。
      const currentKey = shippingKeyOf(shippingForm);
      const nextKey = await updateDraftShipping();
      if (nextKey !== currentKey) {
        setCheckoutError(
          "配送先の反映に失敗しました。少し待ってから再度お試しください。",
        );
        return;
      }

      // 入力フォームを出しているとき（「新規」選択、または保存済み住所が0件）は、
      // 保存 ON なら確定前にプロフィールと住所帳へ保存する（FREQ-366）。
      if (isEnteringNewAddress) {
        setProfileSaveError(null);
        if (!(await persistSavedProfileAndAddress())) {
          return;
        }
      }

      // コンビニ払いの支払票送付先・カードの領収メール宛先。1画面化で空の配送先の
      // まま Stripe セッションを作るため、確定直前にここで渡す。
      const emailResult = await checkout.checkout.updateEmail(
        shippingForm.email.trim(),
      );
      if (emailResult.type === "error") {
        console.error("Failed to update checkout email:", emailResult.error);
        setCheckoutError("メールアドレスの反映に失敗しました。");
        return;
      }

      const t = checkout.checkout.total;
      const result = await checkout.checkout.confirm({
        redirect: "if_required",
        returnUrl: `${window.location.origin}/checkout?session_id={CHECKOUT_SESSION_ID}`,
      });

      if (result.type === "error") {
        setCheckoutError(result.error.message ?? "決済の確定に失敗しました。");
        return;
      }

      setConfirmedSummary({
        subtotal: t.subtotal.amount,
        discount: t.discount.amount,
        shipping:
          t.shippingRate.minorUnitsAmount === 0
            ? "無料"
            : t.shippingRate.amount,
        total: t.total.amount,
        discountMinor: t.discount.minorUnitsAmount,
      });
      setStep(2);
    } catch (error) {
      setCheckoutError(
        error instanceof Error
          ? error.message
          : "決済の確定中にエラーが発生しました。",
      );
    } finally {
      setConfirmingPayment(false);
    }
  };

  // お客様情報。ログイン済+氏名/メール設定済なら読み取り表示、それ以外は編集フォーム。
  const handleSaveCustomer = async () => {
    setSavingCustomer(true);
    setCustomerError(null);
    try {
      const response = await clientFetch("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: shippingForm.fullName.trim(),
          kanaName: shippingForm.kanaName.trim(),
          phone: formatPhoneNumberInput(shippingForm.phone.trim()),
        }),
      });
      if (!response.ok) {
        throw new Error("save failed");
      }
      setEditingCustomer(false);
    } catch {
      setCustomerError("お客様情報の保存に失敗しました。再度お試しください。");
    } finally {
      setSavingCustomer(false);
    }
  };

  // 編集をキャンセルし、開始前の値へ戻す
  const handleCancelCustomer = () => {
    const snap = customerSnapshotRef.current;
    if (snap) {
      setShippingForm((prev) => ({ ...prev, ...snap }));
    }
    setCustomerError(null);
    setEditingCustomer(false);
  };

  // Render in the existing tree so typing does not remount the customer inputs.
  const renderCustomerInfoSection = () => {
    // 仕様: ログイン済+氏名/メール設定済で読み取り表示。電話は注文時必須のため未設定なら編集を促す。
    const showReadonly =
      isLoggedIn &&
      shippingForm.fullName.trim().length > 0 &&
      shippingForm.email.trim().length > 0 &&
      shippingForm.phone.trim().length > 0 &&
      !editingCustomer;

    if (showReadonly) {
      return (
        <div className="checkout-card" style={{ gap: "var(--gap-group)" }}>
          <div className="checkout-field">
            <p className="checkout-label">氏名</p>
            <p className="checkout-value">{shippingForm.fullName || "-"}</p>
          </div>
          <div className="checkout-field">
            <p className="checkout-label">フリガナ</p>
            <p className="checkout-value">{shippingForm.kanaName || "-"}</p>
          </div>
          <div className="checkout-field">
            <p className="checkout-label">メールアドレス</p>
            <p className="checkout-value break-all">
              {shippingForm.email || "-"}
            </p>
          </div>
          <div className="checkout-field">
            <p className="checkout-label">電話番号</p>
            <p className="checkout-value">{shippingForm.phone || "-"}</p>
          </div>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              customerSnapshotRef.current = {
                fullName: shippingForm.fullName,
                kanaName: shippingForm.kanaName,
                phone: shippingForm.phone,
              };
              setEditingCustomer(true);
            }}
          >
            変更する
          </Button>
        </div>
      );
    }

    return (
      <div className="checkout-box checkout-form">
        <TextField
          required
          label="氏名"
          type="text"
          name="fullName"
          autoComplete="name"
          value={shippingForm.fullName}
          onChange={handleShippingChange}
          size="md"
          errorText={fieldErrors.fullName}
        />
        <TextField
          required
          label="フリガナ"
          type="text"
          name="kanaName"
          value={shippingForm.kanaName}
          onChange={handleShippingChange}
          size="md"
          errorText={fieldErrors.kanaName}
        />
        <TextField
          required
          label="メールアドレス"
          type="email"
          name="email"
          autoComplete="email"
          value={shippingForm.email}
          onChange={handleShippingChange}
          size="md"
          errorText={fieldErrors.email}
          readOnly={isLoggedIn}
          className={isLoggedIn ? "bg-[#f5f5f5]" : undefined}
        />
        <TextField
          required
          label="電話番号"
          placeholder="090-1234-5678"
          type="tel"
          name="phone"
          autoComplete="tel"
          inputMode="numeric"
          value={shippingForm.phone}
          onChange={handleShippingChange}
          size="md"
          errorText={fieldErrors.phone}
        />
        <LiveMessage
          className="text-red-600"
          style={{ fontSize: "var(--lk-size-sm)" }}
        >
          {customerError}
        </LiveMessage>
        {isLoggedIn && (
          <div className="checkout-actions">
            <Button
              type="button"
              size="sm"
              onClick={handleSaveCustomer}
              disabled={savingCustomer}
            >
              {savingCustomer ? "保存中..." : "変更を保存"}
            </Button>
            {editingCustomer && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={handleCancelCustomer}
                disabled={savingCustomer}
              >
                キャンセル
              </Button>
            )}
          </div>
        )}
      </div>
    );
  };

  // 配送先の住所入力欄。Branch A(新規) と Branch B1 で共有（コンポーネント化せず
  // クロージャで返すことで PaymentElement の再マウントを避ける）。
  const renderAddressFields = () => (
    <>
      <TextField
        required
        label="郵便番号"
        placeholder="123-4567"
        type="text"
        name="postalCode"
        autoComplete="postal-code"
        value={shippingForm.postalCode}
        onChange={handleShippingChange}
        size="md"
        errorText={fieldErrors.postalCode}
      />
      <SingleSelect
        name="prefecture"
        required
        label="都道府県"
        variant="dropdown"
        block
        autoComplete="address-level1"
        value={shippingForm.prefecture}
        onValueChange={(prefecture) => {
          setShippingForm((prev) => ({ ...prev, prefecture }));
          if (prefecture) {
            setFieldErrors((prev) => ({ ...prev, prefecture: "" }));
          }
        }}
        options={[
          { value: "", label: "選択してください" },
          ...PREFECTURES.map((prefecture) => ({
            value: prefecture,
            label: prefecture,
          })),
        ]}
        size="md"
        // 誤りの案内は部品の入れ物（#prefecture-error）に出し、説明と誤りの状態で結ぶ（FREQ-379）
        errorText={fieldErrors.prefecture || undefined}
      />
      <TextField
        required
        label="市区町村"
        type="text"
        name="city"
        autoComplete="address-level2"
        value={shippingForm.city}
        onChange={handleShippingChange}
        size="md"
        errorText={fieldErrors.city}
      />
      <TextField
        required
        label="番地"
        type="text"
        name="address"
        autoComplete="street-address"
        value={shippingForm.address}
        onChange={handleShippingChange}
        size="md"
        errorText={fieldErrors.address}
      />
      <TextField
        label="建物名・部屋番号（任意）"
        type="text"
        name="building"
        value={shippingForm.building}
        onChange={handleShippingChange}
        size="md"
      />
      {/* 保存先はログイン中のプロフィール／配送先なので、ゲストには出さない */}
      {isLoggedIn && (
        <Checkbox
          id="saveProfile"
          name="saveProfile"
          checked={shippingForm.saveProfile}
          onChange={handleShippingChange}
          label="この配送先を保存する"
          className="checkout-save-address"
          size="sm"
          shape="square"
          expandLabelHitArea
        />
      )}
    </>
  );

  // 左列（お客様情報 → 配送先 → 支払方法 → 確定）。
  // 決済セッション未取得でも入力欄は描画する（生成失敗・429 でも入力を止めないため）。
  // 常に CheckoutProvider の内側で描画するので、セッション取得時にも入力欄は再マウントされない。
  const renderCheckoutSections = () => (
    <div className="order-2 lg:order-1 md:col-span-1 lg:col-span-2 checkout-sections">
      <section className="checkout-section">
        <h3 className="checkout-heading font-brand">お客様情報</h3>
        {renderCustomerInfoSection()}
      </section>

      <section className="checkout-section">
        <h3 className="checkout-heading font-brand">配送先</h3>
        {hasSavedAddress && (
          <SingleSelect
            label="保存済みの配送先"
            variant="dropdown"
            block
            multiline
            value={selectedAddressId}
            onValueChange={handleSelectSavedAddress}
            options={addressOptions}
            size="md"
          />
        )}
        {isEnteringNewAddress ? (
          <div className="checkout-box checkout-form">{renderAddressFields()}</div>
        ) : (
          <AddressCard address={shippingForm} />
        )}
      </section>

      <section className="checkout-section">
        <h3 className="checkout-heading font-brand">支払方法の選択</h3>
        <div className="checkout-box">
          {customCheckoutClientSecret ? (
            <PaymentElement
              options={{
                layout: {
                  type: "accordion",
                  defaultCollapsed: false,
                  radios: "always",
                  spacedAccordionItems: false,
                },
              }}
              onChange={(event) => {
                setSelectedPaymentType(event.value?.type ?? null);
              }}
            />
          ) : cartItems.length === 0 ? (
            <p style={{ fontSize: "var(--lk-size-sm)", color: "#474747" }}>
              ご購入いただける商品がありません。商品を追加してから決済に進んでください。
            </p>
          ) : (
            <p style={{ fontSize: "var(--lk-size-sm)", color: "#474747" }}>
              決済フォームを準備しています...
            </p>
          )}
          {/* 決済の準備に失敗した案内。入れ物は常に置き、中身だけを入れ替える（FREQ-377）。
              エラー ID と再試行のボタンは読み上げに混ぜず、案内の後ろに出す */}
          <LiveMessage
            id={CHECKOUT_SESSION_ERROR_ID}
            data-testid="checkout-session-error"
            className="mt-4 lk-text-sm text-red-600"
          >
            {checkoutError}
          </LiveMessage>
          {checkoutError &&
            (sessionErrorCorrelationId ||
              (!customCheckoutClientSecret && sessionErrorRetryable)) && (
            <div className="mt-3 space-y-3">
              {sessionErrorCorrelationId && (
                <p style={{ fontSize: "var(--lk-size-2xs)", color: "#474747" }}>
                  エラーID: {sessionErrorCorrelationId.slice(0, 8)}
                </p>
              )}
              {!customCheckoutClientSecret && sessionErrorRetryable && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setCheckoutError(null);
                    setSessionErrorCorrelationId(null);
                    setCustomCheckoutClientSecret(null);
                    setCustomCheckoutSessionId(null);
                    // このリトライで即座に再リクエストするため、ガードを true に戻しておく。
                    // false のままだと再試行中のキーストロークで effect が再実行され、
                    // 二重に create-session が POST されてしまう。
                    sessionRequestStartedRef.current = true;
                    void createCustomCheckoutSession();
                  }}
                >
                  再試行する
                </Button>
              )}
            </div>
          )}
        </div>
      </section>

      <LiveMessage
        className="text-red-600"
        style={{ fontSize: "var(--lk-size-sm)" }}
      >
        {profileSaveError}
      </LiveMessage>

      <div className="flex">
        {customCheckoutClientSecret ? (
          <ConfirmPaymentButton
            onConfirm={handleConfirmPayment}
            sessionLoading={customSessionLoading}
            confirming={confirmingPayment}
            hasClientSecret={Boolean(customCheckoutClientSecret)}
          />
        ) : (
          <Button
            type="button"
            size="lg"
            className="flex-1"
            onClick={() => {
              const errors = validateShippingForm();
              if (Object.keys(errors).length > 0) {
                focusFirstError(errors);
                return;
              }
              setCheckoutError(
                cartItems.length === 0
                  ? "ご購入いただける商品がありません。商品を追加してから決済に進んでください。"
                  : "決済フォームを準備しています。少し待ってから再度お試しください。",
              );
            }}
            disabled={customSessionLoading || sessionBlocked}
            aria-describedby={sessionBlocked ? CHECKOUT_SESSION_ERROR_ID : undefined}
          >
            確認へ進む
          </Button>
        )}
      </div>
    </div>
  );

  const [completed, setCompleted] = useState<boolean>(false);

  if (cartLoading) {
    return (
      <div className="element-width text-center">
        <div className="lk-text-lg tracking-widest" style={mdTextStyle}>
          読み込み中...
        </div>
      </div>
    );
  }

  if (completed) {
    return (
      <div className="checkout-page md:px-10 lg:px-12">
        <div
          className="max-w-3xl mx-auto text-center"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--gap-section)",
          }}
        >
          <div className="checkout-section" style={{ alignItems: "center" }}>
            <h1 style={{ fontSize: "var(--lk-size-4xl)" }}>
              Thank you for your order
            </h1>
            <p style={{ fontSize: "var(--lk-size-md)", color: "#474747" }}>
              ご注文を承りました。確認メールをお送りしましたのでご確認ください。
            </p>
          </div>

          <div
            className="text-left"
            style={{ background: "#f5f5f5", padding: "var(--card-pad)" }}
          >
            <div
              className="grid grid-cols-2"
              style={{ gap: "var(--gap-block)" }}
            >
              <div className="checkout-field">
                <p className="checkout-label">注文番号</p>
                <p className="checkout-value">{completedOrderId ?? "—"}</p>
              </div>
              <div className="checkout-field">
                <p className="checkout-label">注文日</p>
                <p className="checkout-value">
                  {new Date().toLocaleDateString("ja-JP", {
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                  })}
                </p>
              </div>
            </div>
          </div>

          {!isLoggedIn && shippingForm.email.trim() ? (
            <GuestRegisterPrompt email={shippingForm.email.trim()} />
          ) : null}

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--gap-block)",
            }}
          >
            {[
              {
                icon: "ri-mail-line",
                title: "確認メールを送信しました",
                body: "ご登録のメールアドレスに注文確認メールをお送りしました。メールが届かない場合は、迷惑メールフォルダをご確認ください。",
              },
              {
                icon: "ri-truck-line",
                title: "配送について",
                body: "商品は2-5営業日以内に発送いたします。発送完了後、追跡番号をメールでお知らせいたします。",
              },
              {
                icon: "ri-customer-service-line",
                title: "お問い合わせ",
                body: "ご不明な点がございましたら、お気軽にお問い合わせください。カスタマーサポートが対応いたします。",
              },
            ].map((card) => (
              <div
                key={card.icon}
                className="checkout-box flex items-start text-left"
                style={{ gap: "var(--gap-group)" }}
              >
                <div className="w-12 h-12 flex items-center justify-center bg-black text-white rounded-full shrink-0">
                  <i className={`${card.icon} lk-text-4xl`}></i>
                </div>
                <div
                  className="checkout-field"
                  style={{ gap: "var(--gap-tight)" }}
                >
                  <h3 style={{ fontSize: "var(--lk-size-lg)", color: "#000" }}>
                    {card.title}
                  </h3>
                  <p
                    style={{ fontSize: "var(--lk-size-sm)", color: "#474747" }}
                  >
                    {card.body}
                  </p>
                </div>
              </div>
            ))}
          </div>

          <div
            className="flex flex-col sm:flex-row justify-center"
            style={{ gap: "var(--gap-group)" }}
          >
            <Link
              href="/item"
              className="px-12 py-4 bg-black text-white lk-text-sm tracking-widest hover:bg-[#474747] transition-all duration-300 cursor-pointer whitespace-nowrap"
            >
              買い物を続ける
            </Link>
            <Link
              href="/account"
              className="px-12 py-4 border border-black text-black lk-text-sm tracking-widest hover:bg-black hover:text-white transition-all duration-300 cursor-pointer whitespace-nowrap"
            >
              注文履歴を見る
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="checkout-page md:px-10 lg:px-12">
      <div className="element-width max-w-6xl">
        <div className="checkout-steps">
          <div className="checkout-steps-track">
            {CHECKOUT_STEPS.map((checkoutStep, index) => {
              const isActive = step >= checkoutStep.id;
              return (
                <React.Fragment key={checkoutStep.id}>
                  <div className="checkout-step">
                    <div
                      className="checkout-step-badge"
                      data-active={isActive ? "true" : undefined}
                    >
                      {checkoutStep.id}
                    </div>
                    <span
                      className="checkout-step-label"
                      data-active={isActive ? "true" : undefined}
                    >
                      {checkoutStep.label}
                    </span>
                  </div>
                  {index < CHECKOUT_STEPS.length - 1 && (
                    <div
                      className="checkout-step-connector"
                      data-active={
                        step >= checkoutStep.id + 1 ? "true" : undefined
                      }
                    ></div>
                  )}
                </React.Fragment>
              );
            })}
          </div>
        </div>

        {/* STEP 1: お客様情報・配送先・支払方法を1画面に表示 */}
        {step === 1 ? (
          <CheckoutProvider
            stripe={stripePromise}
            options={checkoutProviderOptions}
          >
            {/* 決済から戻って注文の確定に失敗したときの案内（FREQ-377）。確定は入力画面のまま走るので、
                確認画面の案内とは別にここへ出す。入れ物は常に置き、中身だけを入れ替える */}
            <LiveMessage
              data-testid="checkout-return-error"
              className="mb-4 text-red-600"
              style={{ fontSize: "var(--lk-size-sm)" }}
            >
              {confirmError}
            </LiveMessage>
            <div className="checkout-grid grid grid-cols-1 md:grid-cols-1 lg:grid-cols-3">
              {renderCheckoutSections()}
              <div className="order-1 lg:order-2 md:col-span-1 lg:col-span-1">
                <div className="checkout-summary md:sticky md:top-32">
                  <h2 className="checkout-summary-title">ORDER SUMMARY</h2>
                  {cartItems.length === 0 ? (
                    <EmptyCartMessage />
                  ) : (
                    <>
                      <OrderItems cartItems={cartItems} />
                      {customCheckoutClientSecret ? (
                        <>
                          <PromoCodeField />
                          <StripeOrderTotals />
                        </>
                      ) : (
                        <CartTotals
                          subtotal={subtotal}
                          shipping={shipping}
                          total={total}
                        />
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          </CheckoutProvider>
        ) : (
          <div className="checkout-grid grid grid-cols-1 md:grid-cols-1 lg:grid-cols-3">
            <div className="order-2 lg:order-1 md:col-span-1 lg:col-span-2">
              {/* STEP 2: ご注文内容の確認 */}
              <form onSubmit={handleConfirm} className="checkout-sections">
                <section className="checkout-section">
                  <h3 className="checkout-heading font-brand">お客様情報</h3>
                  <div className="checkout-card">
                    {shippingForm.fullName && <p>{shippingForm.fullName}</p>}
                    {shippingForm.kanaName && <p>{shippingForm.kanaName}</p>}
                    {shippingForm.email && (
                      <p className="break-all">{shippingForm.email}</p>
                    )}
                    {shippingForm.phone && <p>{shippingForm.phone}</p>}
                  </div>
                </section>
                <section className="checkout-section">
                  <h3 className="checkout-heading font-brand">配送先</h3>
                  <AddressCard address={shippingForm} />
                </section>
                <section className="checkout-section">
                  <h3 className="checkout-heading font-brand">支払方法</h3>
                  <div className="checkout-card">
                    {/* 注文詳細と同じ名前で出す（FREQ-371） */}
                    <p>{mapPaymentMethodLabel(recordedPaymentMethod)}</p>
                  </div>
                </section>

                {/* 注文の確定に失敗した案内（FREQ-377）。入れ物は常に置き、中身だけを入れ替える */}
                <LiveMessage
                  className="text-red-600"
                  style={{ fontSize: "var(--lk-size-sm)" }}
                >
                  {confirmError}
                </LiveMessage>

                <div className="checkout-actions">
                  {!confirmedSummary && (
                    <Button
                      type="button"
                      variant="secondary"
                      size="lg"
                      onClick={() => {
                        // 確認画面の案内を、戻った先（入力画面の先頭の案内）に持ち越さない
                        setConfirmError(null);
                        setStep(1);
                      }}
                    >
                      戻る
                    </Button>
                  )}
                  <Button
                    type="submit"
                    size="lg"
                    className="flex-1"
                    disabled={confirmingOrder}
                  >
                    {confirmingOrder ? "注文確定中..." : "注文する"}
                  </Button>
                </div>
              </form>
            </div>

            <div className="order-1 lg:order-2 md:col-span-1 lg:col-span-1">
              <div className="checkout-summary md:sticky md:top-32">
                <h2 className="checkout-summary-title">ORDER SUMMARY</h2>

                {cartItems.length === 0 ? (
                  <p
                    className="text-gray-500"
                    style={{ fontSize: "var(--lk-size-sm)" }}
                  >
                    カートに商品がありません
                  </p>
                ) : (
                  <>
                    <OrderItems cartItems={cartItems} />

                    <div className="checkout-rows">
                      <div className="checkout-row">
                        <span className="checkout-row-muted">小計</span>
                        <span>
                          {confirmedSummary
                            ? confirmedSummary.subtotal
                            : `¥${subtotal.toLocaleString()}`}
                        </span>
                      </div>
                      {confirmedSummary &&
                        confirmedSummary.discountMinor > 0 && (
                          <div className="checkout-row">
                            <span className="checkout-row-muted">値引</span>
                            <span>-{confirmedSummary.discount}</span>
                          </div>
                        )}
                      <div className="checkout-row">
                        <span className="checkout-row-muted">配送料</span>
                        <span>
                          {confirmedSummary
                            ? confirmedSummary.shipping
                            : shipping === 0
                              ? "無料"
                              : `¥${shipping.toLocaleString()}`}
                        </span>
                      </div>
                      <div className="checkout-total-row">
                        <span className="checkout-total-label">合計</span>
                        <span className="checkout-total">
                          {confirmedSummary
                            ? confirmedSummary.total
                            : `¥${total.toLocaleString()}`}
                        </span>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function CheckoutPage() {
  return (
    <Suspense
      fallback={
        <div className="md:px-10 lg:px-12">
          <div className="max-w-6xl mx-auto">
            <p className="lk-text-sm text-[#474747]">読み込み中...</p>
          </div>
        </div>
      }
    >
      <CheckoutPageContent />
    </Suspense>
  );
}
