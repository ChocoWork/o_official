"use client";

import React, { useRef, useState } from "react";
import Link from 'next/link';
import Image from 'next/image';
import { useRouter, useSearchParams } from 'next/navigation';
import { loadStripe, type Appearance } from '@stripe/stripe-js';
import { Elements, CardElement } from '@stripe/react-stripe-js';
import { Button } from '@/app/components/ui/Button';
import { Checkbox } from '@/app/components/ui/Checkbox';
import {
  formatPostalCodeInput,
  isCompletePostalCode,
  normalizePostalCode,
} from '@/features/checkout/utils/postal-code.util';
import { SingleSelect } from '@/app/components/ui/SingleSelect';
import { TextField } from '@/app/components/ui/TextField';

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

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '');

// Stripe Payment Element appearance (ブランドトークンに合わせたカスタマイズ)
const stripeAppearance: Appearance = {
  theme: 'stripe',
  variables: {
    colorBackground: '#ffffff',
    colorText: '#000000',
    colorPrimary: '#000000',
    colorTextSecondary: '#474747',
    colorDanger: '#dc2626',
    fontFamily: 'acumin-pro, sans-serif',
    fontSizeBase: '16px',
    fontWeightNormal: '400',
    fontWeightMedium: '600',
    borderRadius: '0.375rem',
    spacingUnit: '4px',
  },
  rules: {
    '.Input': {
      border: '1px solid rgba(0,0,0,0.2)',
      borderRadius: '0.375rem',
      backgroundColor: '#ffffff',
      color: '#000000',
      fontFamily: 'acumin-pro, sans-serif',
      padding: '0.75rem 1rem',
    },
    '.Input:focus': {
      borderColor: '#000000',
      boxShadow: '0 0 0 3px rgba(0,0,0,0.15)',
    },
    '.Input::placeholder': {
      color: 'rgba(0,0,0,0.4)',
    },

    '.Label': {
      color: '#474747',
      fontWeight: '600',
      fontSize: '0.75rem',
      letterSpacing: '0.05em',
    },

    '.Button': {
      backgroundColor: '#000000',
      color: '#ffffff',
      borderRadius: '0.375rem',
      fontFamily: 'acumin-pro, sans-serif',
      fontWeight: '600',
      padding: '0.75rem 1rem',
    },
    '.Button:hover': {
      backgroundColor: '#474747',
    },

    '.Error': {
      color: '#dc2626',
      fontWeight: '600',
    },

    '.Tab': {
      borderRadius: '0.375rem',
      border: '1px solid rgba(0,0,0,0.2)',
      backgroundColor: '#ffffff',
      color: '#000000',
    },
    '.Tab--selected': {
      backgroundColor: '#000000',
      color: '#ffffff',
    },

    '.Checkbox': {
      borderColor: 'rgba(0,0,0,0.2)',
      borderRadius: '0.375rem',
      backgroundColor: '#ffffff',
    },
    '.Checkbox:checked': {
      backgroundColor: '#000000',
      borderColor: '#000000',
    },
  },
};

const CHECKOUT_STEPS = [
  { id: 1, label: '配送情報' },
  { id: 2, label: 'お支払い方法' },
  { id: 3, label: 'ご注文内容の確認' },
];


type CheckoutPaymentMethod =
  | 'stripe_card'
  | 'stripe_paypay'
  | 'stripe_konbini';

const isStripePaymentMethod = (paymentMethod: CheckoutPaymentMethod) =>
  paymentMethod === 'stripe_card' ||
  paymentMethod === 'stripe_paypay' ||
  paymentMethod === 'stripe_konbini';


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
  // Shipping is free
  const shipping = 0;
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
  const [paymentMethod] = useState<CheckoutPaymentMethod>('stripe_card');
  const [creatingSession, setCreatingSession] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [confirmingOrder, setConfirmingOrder] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [completedOrderId, setCompletedOrderId] = useState<string | null>(null);
  const [processedCallback, setProcessedCallback] = useState(false);
  const latestPostalLookupRef = useRef('');
  const router = useRouter();
  const searchParams = useSearchParams();
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

  const createCheckoutSession = React.useCallback(async () => {
    setCheckoutError(null);
    setCreatingSession(true);

    try {
      const response = await fetch('/api/checkout/create-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paymentMethod,
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
        const errorData: { error?: string } = await response.json().catch(() => ({}));
        throw new Error(errorData.error ?? '決済セッションの作成に失敗しました。');
      }

      const data: { url?: string } = await response.json();
      if (!data.url) {
        throw new Error('Stripe チェックアウトへの遷移先URLが取得できませんでした。');
      }

      window.location.href = data.url;
    } catch (error) {
      setCheckoutError(error instanceof Error ? error.message : '決済セッションの作成に失敗しました。');
      setCreatingSession(false);
    }
  }, [paymentMethod, shippingForm]);

  const handlePaymentStepNext = async () => {
    if (isStripePaymentMethod(paymentMethod)) {
      await createCheckoutSession();
      return;
    }

    setStep(3);
  };
  React.useEffect(() => {
    const sessionId = searchParams.get('session_id');

    if (processedCallback) return;
    if (!sessionId) return;

    setProcessedCallback(true);

    const finalizeOrder = async () => {
      setConfirmingOrder(true);
      setConfirmError(null);

      try {
        const response = await fetch('/api/checkout/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ checkoutSessionId: sessionId }),
        });

        if (!response.ok) {
          throw new Error('注文確定に失敗しました。時間をおいて再度お試しください。');
        }

        const data: { orderId?: string } = await response.json();
        if (data.orderId) {
          setCompletedOrderId(data.orderId);
        }
        setCompleted(true);

        // Remove query params so reloading doesn't re-trigger
        router.replace('/checkout');
      } catch (error) {
        setConfirmError(
          error instanceof Error ? error.message : '注文確定に失敗しました。'
        );
      } finally {
        setConfirmingOrder(false);
      }
    };

    void finalizeOrder();
  }, [searchParams, processedCallback, router]);

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
                <p className="text-lg text-black font-brand">{completedOrderId ?? '—'}</p>
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
                                    : '銀行振込'}
                          </p>
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
                    <div className="rounded-xs border border-black/10 p-6 bg-white">
                      {paymentMethod === 'stripe_card' || paymentMethod === 'stripe_paypay' ? (
                        <>
                          <h3 className="text-lg font-semibold mb-4 font-brand">お支払い方法</h3>
                          <p className="text-sm text-[#474747] mb-4">
                            Stripe Checkout へ遷移して安全に決済を完了します。
                          </p>

                          {checkoutError && (
                            <div className="mb-4">
                              <p className="text-sm text-red-600 font-brand">{checkoutError}</p>
                            </div>
                          )}

                          <div className="space-y-4">
                            <div className="text-sm text-[#474747]">
                              カード情報はStripe上で入力されます。
                              ここでは見た目のみ表示しています。
                            </div>
                            <div className="border border-black/10 p-4 rounded-md">
                              <Elements stripe={stripePromise} options={{ appearance: stripeAppearance }}>
                                <CardElement
                                  options={{
                                    style: {
                                      base: {
                                        fontFamily: 'acumin-pro, sans-serif',
                                        fontSize: '16px',
                                        color: '#000000',
                                      },
                                    },
                                  }}
                                />
                              </Elements>
                            </div>
                          </div>
                        </>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex gap-4 mt-12">
                    <Button type="button" variant="secondary" size="lg" onClick={() => setStep(1)} className="font-brand">
                      戻る
                    </Button>
                    <Button
                      type="button"
                      size="lg"
                      className="flex-1 font-brand"
                      onClick={handlePaymentStepNext}
                      disabled={creatingSession}
                    >
                      {creatingSession ? '決済処理中...' : '次へ'}
                    </Button>
                  </div>
                </div>
              )}
          </div>


          <div className="lg:col-span-1">
            <div className="border border-black/10 p-8 sticky top-32">
              <h2 className="text-2xl text-black mb-8 tracking-tight font-brand font-semibold">注文内容</h2>

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
