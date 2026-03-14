"use client";

import React, { useRef, useState } from "react";
import Link from 'next/link';
import Image from 'next/image';
import { Button } from '@/app/components/ui/Button';
import { Checkbox } from '@/app/components/ui/Checkbox';
import {
  formatPostalCodeInput,
  isCompletePostalCode,
  normalizePostalCode,
} from '@/features/checkout/utils/postal-code.util';
import { RadioButtonGroup } from '@/app/components/ui/RadioButtonGroup';
import { SingleSelect } from '@/app/components/ui/SingleSelect';
import { TextField } from '@/app/components/ui/TextField';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe, Appearance } from '@stripe/stripe-js';

const stripeAppearance: Appearance = {
  theme: 'stripe',
  labels: 'floating',
  variables: {
    fontFamily: 'acumin-pro, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSizeBase: '16px',
    fontWeightNormal: '400',
    fontWeightBold: '700',
    colorPrimary: '#000000',
    colorBackground: '#ffffff',
    colorText: '#111827',
    colorDanger: '#dc2626',
    colorBorder: '#d1d5db',
    borderRadius: '12px',
    spacingUnit: '6px',
  },
  rules: {
    '.Input': {
      boxShadow: '0 1px 2px rgba(0, 0, 0, 0.06)',
      padding: '12px 14px',
      minHeight: '40px',
      borderRadius: '6px',
    },
    '.Input:focus': {
      boxShadow: '0 0 0 2px rgba(0, 0, 0, 0.12)',
    },
    '.Input::placeholder': {
      color: 'rgba(17, 24, 39, 0.6)',
    },
    '.Label': {
      fontSize: '14px',
      fontWeight: '600',
    },
    '.Button': {
      // fontWeight: '700',
      borderRadius: '12px',
      padding: '14px 18px',
    },
  },
};

const PREFECTURES = [
  '北海道',
  '青森県',
  '岩手県',
  '宮城県',
  '秋田県',
  '山形県',
  '福島県',
  '茨城県',
  '栃木県',
  '群馬県',
  '埼玉県',
  '千葉県',
  '東京都',
  '神奈川県',
  '新潟県',
  '富山県',
  '石川県',
  '福井県',
  '山梨県',
  '長野県',
  '岐阜県',
  '静岡県',
  '愛知県',
  '三重県',
  '滋賀県',
  '京都府',
  '大阪府',
  '兵庫県',
  '奈良県',
  '和歌山県',
  '鳥取県',
  '島根県',
  '岡山県',
  '広島県',
  '山口県',
  '徳島県',
  '香川県',
  '愛媛県',
  '高知県',
  '福岡県',
  '佐賀県',
  '長崎県',
  '熊本県',
  '大分県',
  '宮崎県',
  '鹿児島県',
  '沖縄県',
];

const CHECKOUT_STEPS = [
  { id: 1, label: '配送情報' },
  { id: 2, label: 'お支払い方法' },
  { id: 3, label: 'ご注文内容の確認' },
];

const stripePromise = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
  ? loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY)
  : null;

type CheckoutPaymentMethod =
  | 'stripe_card'
  | 'stripe_paypay'
  | 'stripe_konbini'
  | 'bank'
  | 'cod';

const isStripePaymentMethod = (paymentMethod: CheckoutPaymentMethod) =>
  paymentMethod === 'stripe_card' ||
  paymentMethod === 'stripe_paypay' ||
  paymentMethod === 'stripe_konbini';

type CreditCardPaymentElementFormProps = {
  onBack: () => void;
  onSuccess: (paymentIntentId: string) => void;
  email: string;
  fullName: string;
};

function CreditCardPaymentElementForm({
  onBack,
  onSuccess,
  email,
  fullName,
}: CreditCardPaymentElementFormProps) {
  const stripe = useStripe();
  const elements = useElements();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isElementReady, setIsElementReady] = useState(false);

  React.useEffect(() => {
    if (isElementReady) {
      return;
    }

    const timerId = window.setTimeout(() => {
      setSubmitError((prev) => prev ?? '決済フォームの読み込みに失敗しました。ページを再読み込みしてください。');
    }, 8000);

    return () => {
      window.clearTimeout(timerId);
    };
  }, [isElementReady]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!stripe || !elements) {
      setSubmitError('決済フォームの初期化を待ってから再度お試しください。');
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);

    const submitResult = await elements.submit();
    if (submitResult.error) {
      setSubmitError(submitResult.error.message ?? '入力内容をご確認ください。');
      setIsSubmitting(false);
      return;
    }

    const returnUrl = typeof window !== 'undefined' ? `${window.location.origin}/checkout` : undefined;

    const { error, paymentIntent } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: returnUrl,
        payment_method_data: {
          billing_details: {
            name: fullName || undefined,
            email: email || undefined,
          },
        },
      },
      redirect: 'if_required',
    });

    if (error) {
      setSubmitError(error.message ?? '決済に失敗しました。時間をおいて再度お試しください。');
      setIsSubmitting(false);
      return;
    }

    if (
      !paymentIntent ||
      paymentIntent.status === 'succeeded' ||
      paymentIntent.status === 'processing' ||
      paymentIntent.status === 'requires_capture'
    ) {
      onSuccess(paymentIntent?.id ?? '');
      return;
    }

    setSubmitError('決済を完了できませんでした。別のお支払い方法をお試しください。');
    setIsSubmitting(false);
  };

  return (
    <form onSubmit={handleSubmit}>
      <div className="space-y-6 pt-6">
        <PaymentElement
          onReady={() => {
            setIsElementReady(true);
            setSubmitError(null);
          }}
          onLoadError={() => {
            setSubmitError('決済フォームの読み込みに失敗しました。時間をおいて再度お試しください。');
          }}
        />
        {!isElementReady && !submitError && (
          <p className="text-sm text-[#474747] font-brand">決済フォームを読み込み中です...</p>
        )}
        {submitError && <p className="text-sm text-red-600 font-brand">{submitError}</p>}
      </div>

      <div className="flex gap-4 mt-12">
        <Button type="button" variant="secondary" size="lg" onClick={onBack} className="font-brand" disabled={isSubmitting}>
          戻る
        </Button>
        <Button type="submit" size="lg" className="flex-1 font-brand" disabled={!stripe || !elements || !isElementReady || isSubmitting}>
          {isSubmitting ? '決済処理中...' : '次へ'}
        </Button>
      </div>
    </form>
  );
}

export default function CheckoutPage() {
  // cart data for order summary (mirrors cart/page.tsx)
  interface CartItem {
    id: string;
    item_id: number;
    quantity: number;
    color: string | null;
    size: string | null;
    added_at: string;
    items:
      | {
          id: number;
          name: string;
          price: number;
          image_url: string;
          category: string;
        }
      | null;
  }

  const [cartItems, setCartItems] = useState<CartItem[]>([]);
  const [cartLoading, setCartLoading] = useState(true);

  // calculate costs
  const subtotal = cartItems.reduce(
    (sum, item) => sum + (item.items?.price ?? 0) * item.quantity,
    0
  );
  // for now we use a flat shipping rate or free shipping example
  const shipping = subtotal === 0 ? 0 : 500; // ¥500 flat fee when there are items
  const total = subtotal + shipping;

  React.useEffect(() => {
    const fetchCart = async () => {
      try {
        const res = await fetch('/api/cart');
        if (res.ok) {
          const data: CartItem[] = await res.json();
          setCartItems(data.filter((ci) => ci.items !== null));
        }
      } catch (err) {
        console.error('カート取得エラー', err);
      } finally {
        setCartLoading(false);
      }
    };
    fetchCart();
  }, []);

  const [step, setStep] = useState<number>(1);
  const [paymentMethod, setPaymentMethod] = useState<CheckoutPaymentMethod>('stripe_card');
  const [paymentClientSecret, setPaymentClientSecret] = useState<string | null>(null);
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);
  const [paymentIntentLoading, setPaymentIntentLoading] = useState(false);
  const [paymentIntentError, setPaymentIntentError] = useState<string | null>(null);
  const [confirmingOrder, setConfirmingOrder] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [completedOrderId, setCompletedOrderId] = useState<string | null>(null);
  const latestPostalLookupRef = useRef('');
  const [shippingForm, setShippingForm] = useState({
    email: '',
    fullName: '',
    postalCode: '',
    prefecture: '',
    city: '',
    address: '',
    building: '',
    phone: '',
    saveProfile: false,
  });

  React.useEffect(() => {
    setPaymentClientSecret(null);
    setPaymentIntentError(null);
    setPaymentIntentId(null);
  }, [paymentMethod]);

  const handleShippingChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) => {
    const { name, value, type } = e.target;
    const nextValue = name === 'postalCode' ? formatPostalCodeInput(value) : value;
    const checked =
      type === 'checkbox' && 'checked' in e.target
        ? (e.target as HTMLInputElement).checked
        : false;

    setShippingForm((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : nextValue,
    }));

    // 郵便番号自動補完
    if (name === 'postalCode') {
      const cleanedZip = normalizePostalCode(nextValue);
      if (!isCompletePostalCode(cleanedZip)) {
        latestPostalLookupRef.current = '';
        return;
      }

      latestPostalLookupRef.current = cleanedZip;
      fetch(`/api/checkout/postal-code?postalCode=${cleanedZip}`)
        .then(res => res.json())
        .then((data) => {
          if (latestPostalLookupRef.current !== cleanedZip) {
            return;
          }

          const address = data?.address;
          if (address) {
            setShippingForm(prev => ({
              ...prev,
              prefecture: address.prefecture || prev.prefecture,
              city: address.city || prev.city,
              address: address.address || prev.address,
            }));
          }
        })
        .catch(err => console.error('郵便番号検索エラー:', err));
    }
  };

  const handleShippingNext = async (e: React.FormEvent) => {
    e.preventDefault();

    if (shippingForm.saveProfile) {
      const payload = {
        fullName: shippingForm.fullName.trim(),
        phone: shippingForm.phone.trim(),
      };

      if (payload.fullName || payload.phone) {
        await fetch('/api/profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      }
    }

    setStep(2);
  };

  React.useEffect(() => {
    if (step !== 2 || !isStripePaymentMethod(paymentMethod) || paymentClientSecret) {
      return;
    }

    let active = true;

    const createPaymentIntent = async () => {
      setPaymentIntentLoading(true);
      setPaymentIntentError(null);

      try {
        const response = await fetch('/api/checkout/payment-intent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currency: 'jpy', paymentMethod }),
        });

        if (!response.ok) {
          const errorData: { error?: string } = await response.json().catch(() => ({}));
          throw new Error(errorData.error ?? '決済情報の初期化に失敗しました。');
        }

        const data: { clientSecret?: string } = await response.json();
        if (!data.clientSecret) {
          throw new Error('決済情報の取得に失敗しました。');
        }

        if (active) {
          setPaymentClientSecret(data.clientSecret);
        }
      } catch (error) {
        if (active) {
          setPaymentIntentError(
            error instanceof Error ? error.message : '決済情報の初期化に失敗しました。'
          );
        }
      } finally {
        if (active) {
          setPaymentIntentLoading(false);
        }
      }
    };

    createPaymentIntent();

    return () => {
      active = false;
    };
  }, [step, paymentMethod, paymentClientSecret]);

  const handlePaymentNext = (e: React.FormEvent) => {
    e.preventDefault();
    setStep(3);
  };

  const handleConfirm = async (e: React.FormEvent) => {
    e.preventDefault();

    setConfirmingOrder(true);
    setConfirmError(null);

    try {
      const response = await fetch('/api/checkout/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paymentMethod,
          paymentIntentId: isStripePaymentMethod(paymentMethod)
            ? paymentIntentId
            : undefined,
          shipping: {
            email: shippingForm.email,
            fullName: shippingForm.fullName,
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
        throw new Error('注文確定に失敗しました。時間をおいて再度お試しください。');
      }

      const data: { orderId?: string } = await response.json();
      if (data.orderId) {
        setCompletedOrderId(data.orderId);
      }

      setCompleted(true);
    } catch (error) {
      setConfirmError(
        error instanceof Error ? error.message : '注文確定に失敗しました。'
      );
    } finally {
      setConfirmingOrder(false);
    }
  };

  const [completed, setCompleted] = useState<boolean>(false);

  if (cartLoading) {
    return (
      <main className="pt-32 pb-20 px-6 lg:px-12">
        <div className="max-w-7xl mx-auto text-center">
          <div className="text-base tracking-widest font-brand">読み込み中...</div>
        </div>
      </main>
    );
  }

  if (completed) {
    return (
      <main className="pt-32 pb-20 px-6 lg:px-12">
        <div className="max-w-3xl mx-auto text-center">
          <div className="w-20 h-20 flex items-center justify-center mx-auto mb-8 bg-[#f0fdf4] rounded-full"><i className="ri-checkbox-circle-fill text-5xl text-[#16a34a]"></i></div>
          <h1 className="text-4xl text-black tracking-tight mb-4 font-display">ご注文ありがとうございます</h1>
          <p className="text-lg text-[#474747] mb-12 font-brand">ご注文を承りました。確認メールをお送りしましたのでご確認ください。</p>

          <div className="bg-[#f5f5f5] p-8 mb-12 text-left">
            <div className="grid grid-cols-2 gap-6">
              <div>
                <p className="text-xs text-[#474747] mb-2 tracking-wider font-brand">注文番号</p>
                <p className="text-lg text-black font-brand">{completedOrderId ?? paymentIntentId ?? '—'}</p>
              </div>
              <div>
                <p className="text-xs text-[#474747] mb-2 tracking-wider font-brand">注文日</p>
                <p className="text-lg text-black font-brand">{new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
              </div>
            </div>
          </div>

          <div className="space-y-6 mb-12">
            <div className="flex items-start gap-4 p-6 border border-black/10">
              <div className="w-12 h-12 flex items-center justify-center bg-black text-white rounded-full flex-shrink-0"><i className="ri-mail-line text-xl"></i></div>
              <div className="text-left">
                <h3 className="text-lg text-black mb-2 font-brand">確認メールを送信しました</h3>
                <p className="text-sm text-[#474747] font-brand">ご登録のメールアドレスに注文確認メールをお送りしました。メールが届かない場合は、迷惑メールフォルダをご確認ください。</p>
              </div>
            </div>

            <div className="flex items-start gap-4 p-6 border border-black/10">
              <div className="w-12 h-12 flex items-center justify-center bg-black text-white rounded-full flex-shrink-0"><i className="ri-truck-line text-xl"></i></div>
              <div className="text-left">
                <h3 className="text-lg text-black mb-2 font-brand">配送について</h3>
                <p className="text-sm text-[#474747] font-brand">商品は2-5営業日以内に発送いたします。発送完了後、追跡番号をメールでお知らせいたします。</p>
              </div>
            </div>

            <div className="flex items-start gap-4 p-6 border border-black/10">
              <div className="w-12 h-12 flex items-center justify-center bg-black text-white rounded-full flex-shrink-0"><i className="ri-customer-service-line text-xl"></i></div>
              <div className="text-left">
                <h3 className="text-lg text-black mb-2 font-brand">お問い合わせ</h3>
                <p className="text-sm text-[#474747] font-brand">ご不明な点がございましたら、お気軽にお問い合わせください。カスタマーサポートが対応いたします。</p>
              </div>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link href="/item" className="px-12 py-4 bg-black text-white text-sm tracking-widest hover:bg-[#474747] transition-all duration-300 cursor-pointer whitespace-nowrap font-brand">買い物を続ける</Link>
            <Link href="/account" className="px-12 py-4 border border-black text-black text-sm tracking-widest hover:bg-black hover:text-white transition-all duration-300 cursor-pointer whitespace-nowrap font-brand">注文履歴を見る</Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="pt-32 pb-20 px-6 lg:px-12">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-center mb-12">
          <div className="flex items-start">
            {CHECKOUT_STEPS.map((checkoutStep, index) => (
              <React.Fragment key={checkoutStep.id}>
                <div className="w-24 sm:w-32 flex flex-col items-center text-center">
                  <div className={`flex items-center justify-center w-10 h-10 rounded-full border-2 ${step >= checkoutStep.id ? 'bg-black border-black text-white' : 'border-black/20 text-[#474747]'}`}>
                    <span className="text-sm font-brand">{checkoutStep.id}</span>
                  </div>
                  <span className={`mt-3 text-xs sm:text-sm font-brand leading-tight ${step >= checkoutStep.id ? 'text-black' : 'text-[#474747]'}`}>
                    {checkoutStep.label}
                  </span>
                </div>
                {index < CHECKOUT_STEPS.length - 1 && (
                  <div className={`${step >= checkoutStep.id + 1 ? 'bg-black' : 'bg-black/20'} w-10 sm:w-16 h-0.5 mt-5`}></div>
                )}
              </React.Fragment>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-12">
          <div className="lg:col-span-2">
            {/* Render shipping form when step 1, payment form when step 2 */}
              {/* Shipping form (step 1) */}
              {step === 1 && (
                <form onSubmit={handleShippingNext}>
                  <div>
                    <div className="space-y-6">
                      <TextField required label="メールアドレス" type="email" name="email" autoComplete="email" value={shippingForm.email} onChange={handleShippingChange} className="font-brand"  size="md"/>

                      <TextField required label="氏名" type="text" name="fullName" autoComplete="name" value={shippingForm.fullName} onChange={handleShippingChange} className="font-brand"  size="md"/>

                      <TextField required label="郵便番号" placeholder="123-4567" type="text" name="postalCode" autoComplete="postal-code" value={shippingForm.postalCode} onChange={handleShippingChange} className="font-brand"  size="md"/>

                      <SingleSelect
                        name="prefecture"
                        required
                        label="都道府県"
                        variant="dropdown"
                        autoComplete="address-level1"
                        value={shippingForm.prefecture}
                        onValueChange={(prefecture) => {
                          setShippingForm((prev) => ({
                            ...prev,
                            prefecture,
                          }));
                        }}
                        className="font-brand"
                        options={[
                          { value: '', label: '選択してください' },
                          ...PREFECTURES.map((prefecture) => ({
                            value: prefecture,
                            label: prefecture,
                          })),
                        ]}
                       size="md"/>

                      <TextField required label="市区町村" type="text" name="city" autoComplete="address-level2" value={shippingForm.city} onChange={handleShippingChange} className="font-brand"  size="md"/>

                      <TextField required label="番地" type="text" name="address" autoComplete="street-address" value={shippingForm.address} onChange={handleShippingChange} className="font-brand"  size="md"/>

                      <TextField label="建物名・部屋番号（任意）" type="text" name="building" value={shippingForm.building} onChange={handleShippingChange} className="font-brand"  size="md"/>

                      <TextField required label="電話番号" placeholder="090-1234-5678" type="tel" name="phone" autoComplete="tel" value={shippingForm.phone} onChange={handleShippingChange} className="font-brand"  size="md"/>

                      <Checkbox
                        id="saveProfile"
                        name="saveProfile"
                        checked={shippingForm.saveProfile}
                        onChange={handleShippingChange}
                        label="氏名と電話番号を保存する"
                       size="md"/>
                    </div>
                  </div>

                  <div className="flex gap-4 mt-12">
                    <Button type="submit" size="lg" className="flex-1 font-brand">次へ</Button>
                  </div>
                </form>
              )}

              {/* Confirmation (step 3) */}
              {step === 3 && (
                <form onSubmit={handleConfirm}>
                  <div>
                    <div className="space-y-8">
                      <div>
                        <h3 className="text-sm text-[#474747] mb-4 tracking-wider font-brand">配送先</h3>
                        <div className="p-6 bg-[#f5f5f5] text-sm font-brand">
                          {shippingForm.fullName && <p className="mb-1">{shippingForm.fullName}</p>}
                          {shippingForm.postalCode && <p className="mb-1">〒{shippingForm.postalCode}</p>}
                          <p className="mb-1">{shippingForm.prefecture}{shippingForm.city}{shippingForm.address}</p>
                          {shippingForm.building && <p className="mb-1">{shippingForm.building}</p>}
                          {shippingForm.phone && <p className="mb-1">{shippingForm.phone}</p>}
                          {shippingForm.email && <p>{shippingForm.email}</p>}
                        </div>
                      </div>
                      <div>
                        <h3 className="text-sm text-[#474747] mb-4 tracking-wider font-brand">お支払い方法</h3>
                        <div className="p-6 bg-[#f5f5f5] text-sm font-brand">
                          <p>
                            {paymentMethod === 'stripe_card'
                              ? 'カード決済'
                              : paymentMethod === 'stripe_paypay'
                                  ? 'PayPay'
                                  : paymentMethod === 'stripe_konbini'
                                    ? 'コンビニ決済'
                                    : paymentMethod === 'bank'
                                        ? '銀行振込'
                                        : '代金引換'}
                          </p>
                          {paymentMethod === 'bank' && (
                            <p className="mt-3 text-xs text-[#474747]">
                              ご注文後に振込先情報をご案内します。入金確認後に発送いたします。
                            </p>
                          )}
                          {paymentMethod === 'cod' && (
                            <p className="mt-3 text-xs text-[#474747]">
                              代金は商品受け取り時に配送業者へお支払いください。
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  {confirmError && (
                    <p className="text-sm text-red-600 font-brand mt-6">{confirmError}</p>
                  )}

                  <div className="flex gap-4 mt-12">
                    <Button type="button" variant="secondary" size="lg" onClick={() => setStep(2)} className="font-brand">戻る</Button>
                    <Button type="submit" size="lg" className="flex-1 font-brand" disabled={confirmingOrder}>
                      {confirmingOrder ? '注文確定中...' : '注文を確定する'}
                    </Button>
                  </div>
                </form>
              )}

              {/* Payment form (step 2) */}
              {step === 2 && (
                <div>
                  <div className="space-y-6">
                    <RadioButtonGroup
                      name="paymentMethod"
                      value={paymentMethod}
                      onChange={(value) => setPaymentMethod(value as CheckoutPaymentMethod)}
                      direction="column"
                      options={[
                        { value: 'stripe_card', label: 'カード決済' },
                        { value: 'stripe_paypay', label: 'PayPay' },
                        { value: 'stripe_konbini', label: 'コンビニ決済' },
                        { value: 'bank', label: '銀行振込' },
                        { value: 'cod', label: '代金引換' },
                      ]}
                      size="md"
                    />

                    {isStripePaymentMethod(paymentMethod) ? (
                      <div className="space-y-4 pt-6">
                        {!stripePromise && (
                          <p className="text-sm text-red-600 font-brand">
                            Stripeの公開可能キーが設定されていないため、Stripeオンライン決済を利用できません。
                          </p>
                        )}

                        {paymentIntentLoading && (
                          <p className="text-sm text-[#474747] font-brand">決済フォームを準備中です...</p>
                        )}

                        {paymentIntentError && (
                          <p className="text-sm text-red-600 font-brand">{paymentIntentError}</p>
                        )}

                        {stripePromise && paymentClientSecret && (
                          <>
                            {paymentMethod === 'stripe_konbini' && (
                              <div className="rounded-lg border border-black/10 bg-[#f9fafb] p-4 text-sm text-[#374151] font-brand mb-4">
                                <p className="font-semibold text-black mb-1">コンビニ支払いについて</p>
                                <p>このあと「次へ」を押すと、コンビニ支払い用の情報が表示されます。表示された番号と期限をメモして、指定のコンビニでお支払いください。</p>
                                <p className="mt-2 text-xs text-[#6b7280]">（※お支払い期限は通常3日間です）</p>
                              </div>
                            )}

                            <Elements
                              stripe={stripePromise}
                              options={{
                                clientSecret: paymentClientSecret,
                                appearance: stripeAppearance,
                              }}
                              key={paymentMethod}
                            >
                              <CreditCardPaymentElementForm
                                onBack={() => setStep(1)}
                                onSuccess={(id) => { setPaymentIntentId(id); setStep(3); }}
                                email={shippingForm.email}
                                fullName={shippingForm.fullName}
                              />
                            </Elements>
                          </>
                        )}
                      </div>
                    ) : (
                      <form onSubmit={handlePaymentNext}>
                        <div className="pt-6">
                          <p className="text-sm text-[#474747] font-brand">
                            {paymentMethod === 'bank'
                              ? '銀行振込を選択しました。次へ進むと注文確認画面で確定できます。'
                              : '代金引換を選択しました。次へ進むと注文確認画面で確定できます。'}
                          </p>
                        </div>
                        <div className="flex gap-4 mt-12">
                          <Button type="button" variant="secondary" size="lg" onClick={() => setStep(1)} className="font-brand">
                            戻る
                          </Button>
                          <Button type="submit" size="lg" className="flex-1 font-brand">
                            次へ
                          </Button>
                        </div>
                      </form>
                    )}
                  </div>
                </div>
              )}
          </div>


          <div className="lg:col-span-1">
            <div className="border border-black/10 p-8 sticky top-32">
              <h2 className="text-2xl text-black mb-8 tracking-tight font-display" style={{ fontFamily: 'Didot, serif' }}>注文内容</h2>

              {cartItems.length === 0 ? (
                <p className="text-sm text-gray-500">カートに商品がありません</p>
              ) : (
                <>
                  <div className="space-y-6 mb-8 pb-8 border-b border-black/10">
                    {cartItems.map((item) => {
                      // defensive guard; the fetch logic filters out null items but keep typing safe
                      const product = item.items;
                      if (!product) return null;

                      return (
                        <div className="flex gap-4" key={item.id}>
                          <div className="w-20 h-24 bg-[#f5f5f5] flex-shrink-0 overflow-hidden relative">
                            <Image
                              alt={product.name}
                              className="w-full h-full object-cover object-top"
                              src={product.image_url}
                              width={400}
                              height={500}
                            />
                          </div>
                          <div className="flex-1">
                            <p className="text-sm text-black mb-1" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                              {product.name}
                            </p>
                            <p className="text-xs text-[#474747] mb-1" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                              {item.color} / {item.size}
                            </p>
                            <p className="text-xs text-[#474747] mb-1" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                              数量: {item.quantity}
                            </p>
                            <p className="text-sm text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                              ¥{product.price.toLocaleString()}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div className="space-y-4 mb-8 pb-8 border-b border-black/10">
                    <div className="flex justify-between">
                      <span className="text-sm text-[#474747]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                        小計
                      </span>
                      <span className="text-sm text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                        ¥{subtotal.toLocaleString()}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-sm text-[#474747]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                        配送料
                      </span>
                      <span className="text-sm text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                        {shipping === 0 ? '無料' : `¥${shipping.toLocaleString()}`}
                      </span>
                    </div>
                  </div>

                  <div className="flex justify-between">
                    <span className="text-lg text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                      合計
                    </span>
                    <span className="text-2xl text-black" style={{ fontFamily: 'Didot, serif' }}>
                      ¥{total.toLocaleString()}
                    </span>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
