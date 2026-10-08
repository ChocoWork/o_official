"use client";

import React, { Suspense, useRef, useState } from "react";
import { flushSync } from "react-dom";
import Link from "next/link";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/Button/Button";
import { Checkbox } from "@/components/ui/Checkbox/Checkbox";
import { useCart } from "@/contexts/CartContext";
import { useLogin } from "@/contexts/LoginContext";
import { clientFetch } from "@/lib/client-fetch";
import { toOrderNumber } from "@/lib/orders/order-number";
import { formatPhoneNumberInput } from "@/features/account/utils/profile-format.util";
import {
  formatPostalCodeInput,
  isCompletePostalCode,
  normalizePostalCode,
} from "@/features/checkout/utils/postal-code.util";
import { calculateCheckoutAmountsFromSubtotal } from "@/features/checkout/services/checkout-pricing.service";
import type { CheckoutConfirmation } from "@/features/checkout/services/checkout-confirmation.service";
import { saveCartNotice } from "@/features/checkout/utils/cart-notice";
import { GuestRegisterPrompt } from "@/features/checkout/components/GuestRegisterPrompt";
import { SingleSelect } from "@/components/ui/SingleSelect/SingleSelect";
import { LiveMessage } from "@/components/ui/LiveMessage/LiveMessage";
import { TextField } from "@/components/ui/TextField/TextField";
import { PREFECTURES } from "@/lib/constants/prefectures";
import { FinalConfirmationStep } from "@/app/checkout/_components/FinalConfirmationStep";
import { PromoCodeField } from "@/app/checkout/_components/PromoCodeField";
import {
  checkPromotionCodeRequest,
  completeCheckout,
  requestCheckoutConfirmation,
  resumeCheckout,
  type CheckoutRejection,
  type PromotionPreview,
} from "@/app/checkout/_lib/checkout-api";
import { paymentIncompleteMessage, takePaymentAttempt } from "@/app/checkout/_lib/payment-attempt";
import { clearPromotionCode, readPromotionCode, rememberPromotionCode } from "@/app/checkout/_lib/promotion-memory";
import "./checkout.css";

const CHECKOUT_STEPS = [
  { id: 1, label: "ご注文情報の入力" },
  { id: 2, label: "注文内容の最終確認" },
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

// 住所の5項目（入力欄・下書き・住所帳に共通）
type AddressFields = Pick<
  ShippingFormFields,
  "postalCode" | "prefecture" | "city" | "address" | "building"
>;

// 下書きの住所と住所帳の住所が同じか。郵便番号は数字だけ、ほかは前後の空白を除いて比べ、
// null は空欄と同じとみなす。サーバーは下書きの文字を NFKC にそろえる（住所帳は前後の空白を
// 除くだけ）ので、全角の数字を使った住所でも同じと分かるよう、こちらも NFKC にそろえて比べる
function isSameAddress(saved: SavedAddress, draft: AddressFields): boolean {
  const text = (value: string | null | undefined) => (value ?? "").normalize("NFKC").trim();
  return (
    normalizePostalCode(saved.postalCode ?? "") === normalizePostalCode(draft.postalCode) &&
    text(saved.prefecture) === text(draft.prefecture) &&
    text(saved.city) === text(draft.city) &&
    text(saved.address) === text(draft.address) &&
    text(saved.building) === text(draft.building)
  );
}

// 住所の選択欄が指す値。下書きと同じ保存済み住所、同じものが無ければ「新規」
function savedAddressIdFor(list: SavedAddress[], draft: AddressFields): string {
  return list.find((item) => isSameAddress(item, draft))?.id ?? NEW_ADDRESS_VALUE;
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
// 画面の関数の中で定義すると、再描画のたびに別の部品として作り直され、表示中の案内・
// フォーカスが消える（FREQ-372。React 公式: 部品の定義は入れ子にしない）。

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

// 入力画面の金額の内訳（税込み）。割引はサーバーが確かめた目安。最終確認画面は Stripe の金額を出す
function CartTotals({
  subtotal,
  shipping,
  discount,
  total,
}: {
  subtotal: number;
  shipping: number;
  discount: number;
  total: number;
}) {
  return (
    <div className="checkout-rows">
      <div className="checkout-row">
        <span className="checkout-row-muted">小計</span>
        <span>¥{subtotal.toLocaleString()}</span>
      </div>
      {discount > 0 && (
        <div className="checkout-row">
          <span className="checkout-row-muted">割引</span>
          <span>-¥{discount.toLocaleString()}</span>
        </div>
      )}
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

const ORDER_STATUS_LABELS: Record<string, string> = {
  paid: "入金済み",
  pending: "お支払い待ち",
};

/** 完了画面の状態の表示（設計書 2-5）。入金済み・お支払い待ち以外は手続き中として出す */
function orderStatusLabel(status: string): string {
  return ORDER_STATUS_LABELS[status] ?? "手続き中";
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

  const fetchCart = React.useCallback(async () => {
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
  }, []);
  React.useEffect(() => {
    void fetchCart();
  }, [fetchCart]);

  // 1: 入力画面、2: 最終確認画面（グループ F 設計書 第2章）
  const [step, setStep] = useState<number>(1);
  const previousStepRef = useRef(step);
  const inputHeadingRef = useRef<HTMLHeadingElement>(null);
  React.useEffect(() => {
    if (previousStepRef.current === 2 && step === 1) {
      inputHeadingRef.current?.focus({ preventScroll: true });
    }
    previousStepRef.current = step;
  }, [step]);
  // 最終確認画面の内容（決済の画面の中身。決め事 D8）
  const [confirmation, setConfirmation] = useState<CheckoutConfirmation | null>(null);
  // 最終確認画面の上に出す案内（PayPay の取りやめ・決済の画面の作り直し・別の画面で進んでいる）
  const [finalNotice, setFinalNotice] = useState<string | null>(null);
  // 入力画面で適用した割引コード（サーバーが確かめた金額の目安つき。設計書第3章）
  const [promotion, setPromotion] = useState<PromotionPreview | null>(null);
  const [promotionError, setPromotionError] = useState<string | null>(null);
  const [promotionDefaultCode, setPromotionDefaultCode] = useState("");
  const [promotionFieldRevision, setPromotionFieldRevision] = useState(0);
  const restorePromotionInput = React.useCallback((code: string) => {
    setPromotionDefaultCode(code);
    // 適用成功で欄が空になるため、同じコードを戻すときも欄を作り直す。
    setPromotionFieldRevision((revision) => revision + 1);
  }, []);
  // 「確認へ進む」の処理中
  const [proceeding, setProceeding] = useState(false);
  // 開き直したときの状態をサーバーに聞いている間（決め事 D9）
  const [resuming, setResuming] = useState(true);
  const [resumeUnavailable, setResumeUnavailable] = useState(false);
  const [resumeNotice, setResumeNotice] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [sessionErrorRetryable, setSessionErrorRetryable] = useState(true);
  const [sessionErrorCorrelationId, setSessionErrorCorrelationId] = useState<string | null>(null);
  // 在庫切れや 422 など、待っても直らない理由で決済の準備が失敗した状態。
  // 「確認へ進む」を押せると、原因の案内が消えないまま同じ失敗をくり返す（FREQ-385）。
  const sessionBlocked = Boolean(checkoutError) && !sessionErrorRetryable;
  const [profileSaveError, setProfileSaveError] = useState<string | null>(null);
  const [confirmingOrder, setConfirmingOrder] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [completedOrder, setCompletedOrder] = useState<{
    orderId: string;
    orderStatus: string;
    reentered: boolean;
  } | null>(null);
  // 開き直したときの状態の問い合わせは1回だけ送る（FREQ-378。StrictMode の二重実行でも1回）
  const resumeStartedRef = useRef(false);
  const latestPostalLookupRef = useRef("");
  const router = useRouter();
  const searchParams = useSearchParams();
  const { updateCartCount } = useCart();
  const { isLoggedIn, refreshAuthState } = useLogin();
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
  // 住所帳の読み込みが終わっていれば、その中身。下書きを戻す側が選択欄を合わせるのに使う
  const savedAddressesRef = useRef<SavedAddress[] | null>(null);
  // 下書きの配送先を入力欄へ戻した印（中身は戻した住所）。入り直しでは、読み込みがどちらの順で
  // 終わっても、戻した配送先をプロフィールの初期値で崩さず、住所帳の選択欄をこの住所に合わせる。
  // 崩れると、お客様が入れていない建物名が時間切れの作り直しでサーバーへ届き、選択欄が実際に
  // 送る配送先（入力欄の値）と食い違う
  const adoptedAddressRef = useRef<AddressFields | null>(null);

  // 入力画面の読み上げ領域が置かれてから文言を入れ、別のブラウザでは注文の状態を推測させない。
  React.useEffect(() => {
    if (resumeUnavailable && !cartLoading && !resuming) {
      setResumeNotice("このブラウザではご注文の状態を表示できません。お支払いがお済みの場合は、ご注文確認のメールをお送りしています。");
    }
  }, [resumeUnavailable, cartLoading, resuming]);

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

        // 入り直しで下書きの配送先が先に入っているときは、プロフィールの初期値で崩さない
        if (adoptedAddressRef.current) {
          return;
        }

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
        savedAddressesRef.current = list;
        setSavedAddresses(list);

        // 入り直しで下書きの住所が先に入っているときは、既定の住所ではなく下書きと同じ住所を選ぶ
        if (adoptedAddressRef.current) {
          setSelectedAddressId(savedAddressIdFor(list, adoptedAddressRef.current));
          return;
        }

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
      // 買えない商品などの断りは、配送先を変えても解決しないので案内と無効状態を残す。
      if (sessionErrorRetryable) setCheckoutError(null);
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

  // 支払いの後の完了の処理（照合・メール・カートを空にする）。入り直しなら見出しを変える（設計書 2-5）
  const finishOrder = React.useCallback(
    async (checkoutSessionId: string, options: { reentered: boolean }) => {
      setConfirmingOrder(true);
      setConfirmError(null);
      try {
        const result = await completeCheckout(checkoutSessionId);
        if (result.kind === "error") {
          setConfirmError(result.message);
          // 案内は画面の一番上に出る。画面が動かないと、押した位置から見えず何も起きないように見える
          window.scrollTo({ top: 0 });
          return;
        }
        clearPromotionCode();
        setCompletedOrder({ orderId: result.orderId, orderStatus: result.orderStatus, reentered: options.reentered });
        await updateCartCount();
        // 完了画面を読み込み直しても、注文の状態を出せるようにする（決め事 D9。確定の処理は何度呼んでも同じ結果）
        router.replace(`/checkout?session_id=${encodeURIComponent(checkoutSessionId)}`);
      } finally {
        setConfirmingOrder(false);
      }
    },
    [router, updateCartCount],
  );

  // 最終確認画面へ進む。入り直しでは入力画面の値が空のことがあるので、下書きの値で埋める（「変更」で使う）
  const adoptConfirmation = React.useCallback(
    (next: CheckoutConfirmation) => {
      // 住所は下書きのとおりに戻し、null は空欄にする。前の値を残すと、お客様が入れていない
      // 建物名などが残り、時間切れの作り直しでサーバーへ届く
      const draftAddress: AddressFields = {
        postalCode: next.shipping.postalCode ? formatPostalCodeInput(next.shipping.postalCode) : "",
        prefecture: next.shipping.prefecture ?? "",
        city: next.shipping.city ?? "",
        address: next.shipping.address ?? "",
        building: next.shipping.building ?? "",
      };
      adoptedAddressRef.current = draftAddress;
      // このブラウザで新しい確認画面へ進めた後は、以前の入り直しの案内を戻る操作でも出さない。
      setResumeUnavailable(false);
      setResumeNotice(null);
      setConfirmation(next);
      if (next.promotionCode) rememberPromotionCode({ code: next.promotionCode });
      setShippingForm((prev) => ({
        ...prev,
        email: next.shipping.email ?? prev.email,
        fullName: next.shipping.fullName ?? prev.fullName,
        kanaName: next.shipping.kanaName ?? prev.kanaName,
        ...draftAddress,
        phone: next.shipping.phone ? formatPhoneNumberInput(next.shipping.phone) : prev.phone,
      }));
      // 住所帳の選択欄を、実際に送る配送先（入力欄の値）に合わせる。住所帳がまだ読み込み中なら、
      // 読み込みが終わったときに合わせる。普段の「確認へ進む」は送った値が下書きなので、選んでいた住所のまま
      if (savedAddressesRef.current) {
        setSelectedAddressId(savedAddressIdFor(savedAddressesRef.current, draftAddress));
      }
      setStep(2);
      // 読み込み直し・戻るの操作で同じ最終確認画面に戻れるようにする（決め事 D9）
      router.replace(`/checkout?session_id=${encodeURIComponent(next.checkoutSessionId)}`);
      window.scrollTo({ top: 0 });
    },
    [router],
  );

  const recheckPromotion = React.useCallback(async (code: string) => {
    const result = await checkPromotionCodeRequest(code);
    if (result.kind === "applied") {
      setPromotion(result.preview);
      setPromotionError(null);
      rememberPromotionCode({ code: result.preview.code });
    } else {
      if (!result.transient) clearPromotionCode();
      restorePromotionInput(code);
      setPromotion(null);
      setPromotionError(result.message);
    }
  }, [restorePromotionInput]);

  // 開き直したとき・Stripe の画面から戻ったときに、どこから続けるかをサーバーに聞く（決め事 D9・D10）
  React.useEffect(() => {
    if (resumeStartedRef.current) return;
    resumeStartedRef.current = true;
    const checkoutSessionId = searchParams.get("session_id");

    void (async () => {
      // 読めなければ none（入力画面から）。失敗を投げないので、待ちの表示は必ず外れる
      const result = await resumeCheckout(checkoutSessionId);
      if (result.state === "payment_done") {
        // 完了の失敗の案内を出す入れ物を先に置く（FREQ-377）。記録のコードの再適用はしない。
        setResuming(false);
        // 画面の中で支払いを始めた記録があれば「支払った直後」、無ければ後からの入り直し
        const attempt = takePaymentAttempt(result.checkoutSessionId);
        await finishOrder(result.checkoutSessionId, { reentered: attempt === null });
        return;
      }
      if (result.state === "resume") {
        setResuming(false);
        const attempt = takePaymentAttempt(result.confirmation.checkoutSessionId);
        adoptConfirmation(result.confirmation);
        setFinalNotice(attempt ? paymentIncompleteMessage(attempt.paymentType) : null);
        if (result.confirmation.promotionCode) {
          // 「変更」で入力画面へ戻ったときに、適用済みのコードと金額の目安を出す
          await recheckPromotion(result.confirmation.promotionCode);
        }
        return;
      }
      if (checkoutSessionId) {
        router.replace("/checkout");
      }
      if (result.state === "unavailable") {
        setResumeUnavailable(true);
      }
      const remembered = readPromotionCode();
      if (remembered) {
        // 確かめ直しが終わるまで resuming の読み込み表示を保ち、お客様の入力・適用と重なるのを避ける。
        await recheckPromotion(remembered.code);
      }
      setResuming(false);
    })();
  }, [searchParams, router, finishOrder, adoptConfirmation, recheckPromotion]);

  const backToInput = () => {
    setStep(1);
    setConfirmation(null);
    setFinalNotice(null);
    setConfirmError(null);
    router.replace("/checkout");
  };

  // 「確認へ進む」の本体。入力を送って決済の画面を作り、最終確認画面へ進む（設計書 2-2）
  const proceedToConfirmation = async (notice: string | null, recreating = false) => {
    const result = await requestCheckoutConfirmation({
      shipping: { email, fullName, kanaName, postalCode, prefecture, city, address, building, phone },
      displayedAmounts: {
        subtotalAmount: subtotal,
        shippingAmount: shipping,
        taxAmount: tax,
        totalAmount: total,
      },
      promotionCode: promotion?.code ?? null,
    });

    if (result.kind === "confirmation") {
      setConfirmError(null);
      adoptConfirmation(result.confirmation);
      setFinalNotice(notice);
      return;
    }
    if (result.kind === "order_already_placed") {
      await finishOrder(result.checkoutSessionId, { reentered: true });
      return;
    }

    if (recreating && result.kind === "error" && result.code === "out_of_stock") {
      saveCartNotice({ kind: "message", message: result.message });
      router.push("/cart");
      return;
    }
    backToInput();
    if (result.kind === "promotion_code_invalid") {
      // 適用の後にカートが変わるなどで使えなくなった。欄に理由を出す（Review Focus 4）
      clearPromotionCode();
      restorePromotionInput(promotion?.code ?? "");
      setPromotion(null);
      setPromotionError(result.message);
      return;
    }
    if (result.code === "checkout_amount_mismatch") {
      await fetchCart();
      // 要約は適用時の目安を優先するため、価格変更後はコードも確かめ直して目安を更新する。
      if (promotion) await recheckPromotion(promotion.code);
      setSessionErrorRetryable(true);
      setSessionErrorCorrelationId(null);
      setCheckoutError("価格が変わりました。金額をご確認のうえ、もう一度「確認へ進む」を押してください。");
      return;
    }
    if (result.code === "auth_expired" || result.code === "login_changed") {
      // ログインの印を新しくできなかった、または支払い済みの画面が別の買い手のものだった。入力画面を今のログインに
      // 合わせ、お客様に押し直してもらう（自動でゲストとして進めない。設計書 C2）
      void refreshAuthState();
    }
    setSessionErrorRetryable(result.retryable);
    setSessionErrorCorrelationId(result.correlationId);
    setCheckoutError(result.message);
  };

  const handleProceed = async () => {
    const errors = validateShippingForm();
    if (Object.keys(errors).length > 0) {
      focusFirstError(errors);
      return;
    }
    if (cartItems.length === 0) {
      setCheckoutError("ご購入いただける商品がありません。商品を追加してから決済に進んでください。");
      return;
    }

    setProceeding(true);
    setCheckoutError(null);
    setSessionErrorRetryable(true);
    setSessionErrorCorrelationId(null);
    setProfileSaveError(null);
    try {
      // 入力フォームを出しているとき（「新規」選択、または保存済み住所が0件）は、
      // 保存 ON なら先にプロフィールと住所帳へ保存する（FREQ-366）。
      if (isEnteringNewAddress && !(await persistSavedProfileAndAddress())) {
        return;
      }
      await proceedToConfirmation(null);
    } catch {
      setCheckoutError("決済の準備に失敗しました。少し時間をおいてから、もう一度お試しください。");
    } finally {
      setProceeding(false);
    }
  };

  // 受け付けで断られた（お金は動いていない）。理由ごとに移る先を決める（設計書 6-3）
  const handleRejected = async (rejection: CheckoutRejection) => {
    if (rejection.code === "login_changed") {
      // 「確認へ進む」の時とログインの状態が違う。入力画面を今のログインに合わせ、やり直してもらう（設計書第6章）
      backToInput();
      setSessionErrorRetryable(true);
      setSessionErrorCorrelationId(null);
      setCheckoutError(rejection.message);
      void refreshAuthState();
      return;
    }
    if (rejection.code === "stock_changed") {
      saveCartNotice({ kind: "stock_changed", message: rejection.message, lines: rejection.changedLines });
      router.push("/cart");
      return;
    }
    if (rejection.code === "item_unavailable" || rejection.code === "price_changed" || rejection.code === "cart_changed") {
      saveCartNotice({ kind: "message", message: rejection.message });
      router.push("/cart");
      return;
    }
    if (rejection.code === "zero_amount") {
      backToInput();
      setCheckoutError(rejection.message);
      return;
    }
    if (rejection.code === "session_expired") {
      // 決済の画面を作り直す。お支払い情報はもう一度入れてもらう。
      // 応答を待つ間は失効した最終確認画面を押せなくする（押すと作り直しが重なる。「変更」の後に
      // 作り直しが返ると、最終確認画面へ引き戻される）
      setProceeding(true);
      try {
        await proceedToConfirmation(rejection.message, true);
      } catch {
        backToInput();
        setCheckoutError("決済の準備に失敗しました。少し時間をおいてから、もう一度お試しください。");
      } finally {
        setProceeding(false);
      }
      return;
    }
    // 別のタブで後から「確認へ進む」が押された。この画面では進めない
    setFinalNotice(rejection.message);
    // 案内は画面の一番上に出る。画面が動かないと、押した位置から見えず何も起きないように見える
    window.scrollTo({ top: 0 });
  };

  const handleApplyPromotion = async (code: string): Promise<boolean> => {
    setPromotionError(null);
    const result = await checkPromotionCodeRequest(code);
    if (result.kind === "applied") {
      setPromotion(result.preview);
      rememberPromotionCode({ code: result.preview.code });
      return true;
    }
    setPromotionError(result.message);
    return false;
  };

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
  // クロージャで返すことで、入力中の欄の再マウントを避ける）。
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

  // 入力画面の左列（お客様情報 → 配送先 → 確認へ進む）。お支払い方法の入力は最終確認画面に置く（設計書 2-1）。
  const renderCheckoutSections = () => (
    <div className="order-2 lg:order-1 md:col-span-1 lg:col-span-2 checkout-sections">
      <section className="checkout-section">
        <h3 ref={inputHeadingRef} tabIndex={-1} className="checkout-heading font-brand">お客様情報</h3>
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

      {/* 決済の準備に失敗した案内。入れ物は常に置き、中身だけを入れ替える（FREQ-377）。
          「確認へ進む」をもう一度押すことが再試行になる */}
      <LiveMessage
        id={CHECKOUT_SESSION_ERROR_ID}
        data-testid="checkout-session-error"
        className="lk-text-sm text-red-600"
      >
        {checkoutError}
      </LiveMessage>
      {checkoutError && sessionErrorCorrelationId && (
        <p style={{ fontSize: "var(--lk-size-2xs)", color: "#474747" }}>
          エラーID: {sessionErrorCorrelationId.slice(0, 8)}
        </p>
      )}

      <LiveMessage
        className="text-red-600"
        style={{ fontSize: "var(--lk-size-sm)" }}
      >
        {profileSaveError}
      </LiveMessage>

      <div className="flex">
        <Button
          type="button"
          size="lg"
          className="flex-1"
          onClick={() => void handleProceed()}
          disabled={proceeding || sessionBlocked || confirmingOrder}
          aria-describedby={sessionBlocked ? CHECKOUT_SESSION_ERROR_ID : undefined}
        >
          {proceeding ? "確認画面を準備しています..." : "確認へ進む"}
        </Button>
      </div>
    </div>
  );

  if (cartLoading || resuming) {
    return (
      <div className="element-width text-center">
        <div className="lk-text-lg tracking-widest" style={mdTextStyle}>
          読み込み中...
        </div>
      </div>
    );
  }

  if (completedOrder) {
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
              {completedOrder.reentered ? "ご注文は確定しています" : "Thank you for your order"}
            </h1>
            <p style={{ fontSize: "var(--lk-size-md)", color: "#474747" }}>
              {completedOrder.reentered
                ? "このご注文のお手続きは済んでいます。ご注文の状態は次のとおりです。"
                : "ご注文を承りました。確認メールをお送りしましたのでご確認ください。"}
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
                <p className="checkout-value">{toOrderNumber(completedOrder.orderId)}</p>
              </div>
              {/* 入り直しは後日に開くことがあり、今日の日付を出すとずれる。出すのは注文番号と状態だけ（設計書 2-5） */}
              {!completedOrder.reentered && (
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
              )}
              <div className="checkout-field">
                <p className="checkout-label">ご注文の状態</p>
                <p className="checkout-value">{orderStatusLabel(completedOrder.orderStatus)}</p>
              </div>
            </div>
          </div>

          {!isLoggedIn && shippingForm.email.trim() ? (
            <GuestRegisterPrompt email={shippingForm.email.trim()} />
          ) : null}

          {isLoggedIn ? (
            <p style={{ fontSize: "var(--lk-size-sm)" }}>
              <Link href={`/account/orders/${completedOrder.orderId}`} className="underline">
                ご注文の詳細を見る
              </Link>
            </p>
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
                body: "在庫ありの商品はご注文（コンビニはご入金）の確認後3〜7営業日で、受注生産の商品は数週間〜2か月以上で発送いたします。発送完了後、追跡番号をメールでお知らせいたします。",
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

        {step === 2 && confirmation ? (
          <FinalConfirmationStep
            confirmation={confirmation}
            notice={confirmError ?? finalNotice}
            completing={confirmingOrder || proceeding}
            onEdit={backToInput}
            onPaid={(checkoutSessionId) => void finishOrder(checkoutSessionId, { reentered: checkoutSessionId !== confirmation.checkoutSessionId })}
            onRejected={(rejection) => void handleRejected(rejection)}
          />
        ) : (
          <>
            {/* 支払いの後の注文の確定に失敗した案内（FREQ-377）。入れ物は常に置き、中身だけを入れ替える */}
            <LiveMessage
              data-testid="checkout-return-error"
              className="mb-4 text-red-600"
              style={{ fontSize: "var(--lk-size-sm)" }}
            >
              {confirmError}
            </LiveMessage>
            <LiveMessage
              politeness="status"
              data-testid="checkout-resume-notice"
              className="mb-4"
              style={{ fontSize: "var(--lk-size-sm)" }}
            >
              {resumeNotice}
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
                      <PromoCodeField
                        key={promotionFieldRevision}
                        defaultCode={promotionDefaultCode}
                        applied={promotion}
                        error={promotionError}
                        disabled={proceeding}
                        onApply={handleApplyPromotion}
                        onRemove={() => {
                          clearPromotionCode();
                          restorePromotionInput("");
                          setPromotion(null);
                          setPromotionError(null);
                        }}
                      />
                      <CartTotals
                        subtotal={promotion?.subtotalAmount ?? subtotal}
                        shipping={promotion?.shippingAmount ?? shipping}
                        discount={promotion?.discountAmount ?? 0}
                        total={promotion?.totalAmount ?? total}
                      />
                    </>
                  )}
                </div>
              </div>
            </div>
          </>
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
