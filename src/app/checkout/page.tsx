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
  const [paymentMethod, setPaymentMethod] = useState('credit');
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

  const handlePaymentNext = (e: React.FormEvent) => {
    e.preventDefault();
    setStep(3);
  };

  const handleConfirm = (e: React.FormEvent) => {
    e.preventDefault();
    // 確定処理はここに追加できます（API呼び出しなど）
    setCompleted(true);
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
                <p className="text-lg text-black font-brand">ORD-0YHJIH2IT</p>
              </div>
              <div>
                <p className="text-xs text-[#474747] mb-2 tracking-wider font-brand">注文日</p>
                <p className="text-lg text-black font-brand">2026年1月14日</p>
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
                          <p className="mb-1">櫻井 雅也</p>
                          <p className="mb-1">〒981-3351</p>
                          <p className="mb-1">東京都富谷市富谷市鷹乃杜一丁目32番6-202号</p>
                          <p className="mb-1">202号</p>
                          <p className="mb-1">08058476671</p>
                          <p>14masa56@gmail.com</p>
                        </div>
                      </div>
                      <div>
                        <h3 className="text-sm text-[#474747] mb-4 tracking-wider font-brand">お支払い方法</h3>
                        <div className="p-6 bg-[#f5f5f5] text-sm font-brand">
                          <p>クレジットカード</p>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-4 mt-12">
                    <Button type="button" variant="secondary" size="lg" onClick={() => setStep(2)} className="font-brand">戻る</Button>
                    <Button type="submit" size="lg" className="flex-1 font-brand">注文を確定する</Button>
                  </div>
                </form>
              )}

              {/* Payment form (step 2) */}
              {step === 2 && (
                <form onSubmit={handlePaymentNext}>
                  <div>
                    <div className="space-y-6">
                      <RadioButtonGroup
                        name="paymentMethod"
                        value={paymentMethod}
                        onChange={setPaymentMethod}
                        direction="column"
                        options={[
                          { value: 'credit', label: 'クレジットカード' },
                          { value: 'bank', label: '銀行振込' },
                          { value: 'cod', label: '代金引換' },
                        ]}
                       size="md"/>

                      <div className="space-y-6 pt-6">
                        <TextField required label="カード番号" placeholder="1234 5678 9012 3456" type="tel" name="cardNumber" defaultValue={""} className="font-brand" size="md" autoComplete="off" inputMode="numeric" />
                        <TextField required label="カード名義" placeholder="TARO YAMADA" type="text" name="cardName" defaultValue={""} className="font-brand" size="md" autoComplete="off" />
                        <div className="grid grid-cols-2 gap-4">
                          <TextField required label="有効期限" placeholder="MM/YY" type="tel" name="expiryDate" defaultValue={""} className="font-brand" size="md" autoComplete="off" inputMode="numeric" />
                          <TextField required label="セキュリティコード" placeholder="123" type="tel" name="cvv" defaultValue={""} className="font-brand" size="md" autoComplete="off" inputMode="numeric" />
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-4 mt-12">
                    <Button type="button" variant="secondary" size="lg" onClick={() => setStep(1)} className="font-brand">戻る</Button>
                    <Button type="submit" size="lg" className="flex-1 font-brand">次へ</Button>
                  </div>
                </form>
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
