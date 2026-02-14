"use client";

import React, { useState } from "react";
import Link from 'next/link';

export default function CheckoutPage() {
  const [step, setStep] = useState<number>(1);

  const handleShippingNext = (e: React.FormEvent) => {
    e.preventDefault();
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
        <h1 className="text-4xl text-black tracking-tight mb-12 font-display">Checkout</h1>

        <div className="flex items-center justify-center mb-12">
          <div className="flex items-center gap-4">
            <div className={`flex items-center justify-center w-10 h-10 rounded-full border-2 ${step>=1 ? 'bg-black border-black text-white' : 'border-black/20 text-[#474747]'}`}>
              <span className="text-sm font-brand">1</span>
            </div>
            <div className={`${step>=2 ? 'w-20 h-0.5 bg-black' : 'w-20 h-0.5 bg-black/20'}`}></div>
            <div className={`flex items-center justify-center w-10 h-10 rounded-full border-2 ${step>=2 ? 'bg-black border-black text-white' : 'border-black/20 text-[#474747]'}`}>
              <span className="text-sm font-brand">2</span>
            </div>
            <div className={`${step>=3 ? 'w-20 h-0.5 bg-black' : 'w-20 h-0.5 bg-black/20'}`}></div>
            <div className={`flex items-center justify-center w-10 h-10 rounded-full border-2 ${step>=3 ? 'bg-black border-black text-white' : 'border-black/20 text-[#474747]'}`}>
              <span className="text-sm font-brand">3</span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-12">
          <div className="lg:col-span-2">
            {/* Render shipping form when step 1, payment form when step 2 */}
              {/* Shipping form (step 1) */}
              {step === 1 && (
                <form onSubmit={handleShippingNext}>
                  <div>
                    <h2 className="text-2xl text-black mb-8 tracking-tight font-display">配送情報</h2>
                    <div className="space-y-6">
                      <div>
                        <label className="block text-xs text-[#474747] mb-2 tracking-wider font-brand">メールアドレス</label>
                        <input required className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black transition-colors font-brand" type="email" name="email" defaultValue={""} />
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs text-[#474747] mb-2 tracking-wider font-brand">姓</label>
                          <input required className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black transition-colors font-brand" type="text" name="lastName" defaultValue={""} />
                        </div>
                        <div>
                          <label className="block text-xs text-[#474747] mb-2 tracking-wider font-brand">名</label>
                          <input required className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black transition-colors font-brand" type="text" name="firstName" defaultValue={""} />
                        </div>
                      </div>

                      <div>
                        <label className="block text-xs text-[#474747] mb-2 tracking-wider font-brand">郵便番号</label>
                        <input required placeholder="123-4567" className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black transition-colors font-brand" type="text" name="postalCode" defaultValue={""} />
                      </div>

                      <div>
                        <label className="block text-xs text-[#474747] mb-2 tracking-wider font-brand">都道府県</label>
                        <select name="prefecture" required className="w-full px-4 py-3 pr-8 border border-black/20 text-sm focus:outline-none focus:border-black transition-colors cursor-pointer font-brand" defaultValue={""}>
                          <option value="">選択してください</option>
                          <option value="東京都">東京都</option>
                          <option value="大阪府">大阪府</option>
                          <option value="神奈川県">神奈川県</option>
                          <option value="愛知県">愛知県</option>
                          <option value="福岡県">福岡県</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-xs text-[#474747] mb-2 tracking-wider font-brand">市区町村</label>
                        <input required className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black transition-colors font-brand" type="text" name="city" defaultValue={""} />
                      </div>

                      <div>
                        <label className="block text-xs text-[#474747] mb-2 tracking-wider font-brand">番地</label>
                        <input required className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black transition-colors font-brand" type="text" name="address" defaultValue={""} />
                      </div>

                      <div>
                        <label className="block text-xs text-[#474747] mb-2 tracking-wider font-brand">建物名・部屋番号（任意）</label>
                        <input className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black transition-colors font-brand" type="text" name="building" defaultValue={""} />
                      </div>

                      <div>
                        <label className="block text-xs text-[#474747] mb-2 tracking-wider font-brand">電話番号</label>
                        <input required placeholder="090-1234-5678" className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black transition-colors font-brand" type="tel" name="phone" defaultValue={""} />
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-4 mt-12">
                    <button type="submit" className="flex-1 py-4 bg-black text-white text-sm tracking-widest hover:bg-[#474747] transition-all duration-300 cursor-pointer whitespace-nowrap font-brand">次へ</button>
                  </div>
                </form>
              )}

              {/* Confirmation (step 3) */}
              {step === 3 && (
                <form onSubmit={handleConfirm}>
                  <div>
                    <h2 className="text-2xl text-black mb-8 tracking-tight font-display">ご注文内容の確認</h2>
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
                    <button type="button" onClick={() => setStep(2)} className="px-8 py-4 border border-black text-black text-sm tracking-widest hover:bg-black hover:text-white transition-all duration-300 cursor-pointer whitespace-nowrap font-brand">戻る</button>
                    <button type="submit" className="flex-1 py-4 bg-black text-white text-sm tracking-widest hover:bg-[#474747] transition-all duration-300 cursor-pointer whitespace-nowrap font-brand">注文を確定する</button>
                  </div>
                </form>
              )}

              {/* Payment form (step 2) */}
              {step === 2 && (
                <form onSubmit={handlePaymentNext}>
                  <div>
                    <h2 className="text-2xl text-black mb-8 tracking-tight font-display">お支払い方法</h2>
                    <div className="space-y-6">
                      <div className="space-y-4">
                        <label className="flex items-center gap-3 p-4 border border-black/20 cursor-pointer hover:border-black transition-colors">
                          <input className="w-4 h-4 cursor-pointer" type="radio" value="credit" defaultChecked name="paymentMethod" />
                          <span className="text-sm font-brand">クレジットカード</span>
                        </label>
                        <label className="flex items-center gap-3 p-4 border border-black/20 cursor-pointer hover:border-black transition-colors">
                          <input className="w-4 h-4 cursor-pointer" type="radio" value="bank" name="paymentMethod" />
                          <span className="text-sm font-brand">銀行振込</span>
                        </label>
                        <label className="flex items-center gap-3 p-4 border border-black/20 cursor-pointer hover:border-black transition-colors">
                          <input className="w-4 h-4 cursor-pointer" type="radio" value="cod" name="paymentMethod" />
                          <span className="text-sm font-brand">代金引換</span>
                        </label>
                      </div>

                      <div className="space-y-6 pt-6">
                        <div>
                          <label className="block text-xs text-[#474747] mb-2 tracking-wider font-brand">カード番号</label>
                          <input required placeholder="1234 5678 9012 3456" className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black transition-colors font-brand" type="text" name="cardNumber" defaultValue={""} />
                        </div>
                        <div>
                          <label className="block text-xs text-[#474747] mb-2 tracking-wider font-brand">カード名義</label>
                          <input required placeholder="TARO YAMADA" className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black transition-colors font-brand" type="text" name="cardName" defaultValue={""} />
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <label className="block text-xs text-[#474747] mb-2 tracking-wider font-brand">有効期限</label>
                            <input required placeholder="MM/YY" className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black transition-colors font-brand" type="text" name="expiryDate" defaultValue={""} />
                          </div>
                          <div>
                            <label className="block text-xs text-[#474747] mb-2 tracking-wider font-brand">セキュリティコード</label>
                            <input required placeholder="123" className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black transition-colors font-brand" type="text" name="cvv" defaultValue={""} />
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-4 mt-12">
                    <button type="button" onClick={() => setStep(1)} className="px-8 py-4 border border-black text-black text-sm tracking-widest hover:bg-black hover:text-white transition-all duration-300 cursor-pointer whitespace-nowrap font-brand">戻る</button>
                    <button type="submit" className="flex-1 py-4 bg-black text-white text-sm tracking-widest hover:bg-[#474747] transition-all duration-300 cursor-pointer whitespace-nowrap font-brand">次へ</button>
                  </div>
                </form>
              )}
          </div>

          <div className="lg:col-span-1">
            <div className="border border-black/10 p-8 sticky top-32">
              <h2 className="text-2xl text-black mb-8 tracking-tight font-display">注文内容</h2>

              <div className="space-y-6 mb-8 pb-8 border-b border-black/10">
                <div className="flex gap-4">
                  <div className="w-20 h-24 bg-[#f5f5f5] flex-shrink-0 overflow-hidden relative">
                    <img alt="シルクブラウス" className="w-full h-full object-cover object-top" src="https://readdy.ai/api/search-image?query=elegant%20black%20silk%20blouse%20on%20white%20background%20minimalist%20fashion%20photography%20high%20quality%20luxury%20fabric%20texture%20soft%20lighting%20professional%20product%20shot%20clean%20simple%20backdrop&amp;width=400&amp;height=500&amp;seq=checkout1&amp;orientation=portrait" />
                    <div className="absolute -top-2 -right-2 w-6 h-6 bg-black text-white rounded-full flex items-center justify-center text-xs font-brand">1</div>
                  </div>
                  <div className="flex-1">
                    <p className="text-sm text-black mb-1 font-brand">シルクブラウス</p>
                    <p className="text-xs text-[#474747] mb-1 font-brand">ブラック / M</p>
                    <p className="text-sm text-black font-brand">¥28,000</p>
                  </div>
                </div>
              </div>

              <div className="space-y-4 mb-8 pb-8 border-b border-black/10">
                <div className="flex justify-between"><span className="text-sm text-[#474747] font-brand">小計</span><span className="text-sm text-black font-brand">¥28,000</span></div>
                <div className="flex justify-between"><span className="text-sm text-[#474747] font-brand">配送料</span><span className="text-sm text-black font-brand">¥800</span></div>
              </div>

              <div className="flex justify-between"><span className="text-lg text-black font-brand">合計</span><span className="text-2xl text-black font-display">¥28,800</span></div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
