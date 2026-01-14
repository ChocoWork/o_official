"use client";

import React from "react";
import Link from 'next/link';

export default function CartPage() {
  return (
    <main className="pt-32 pb-20 px-6 lg:px-12">
      <div className="max-w-7xl mx-auto">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-12">
          <div className="lg:col-span-2 space-y-6">
            <div className="flex gap-6 border-b border-black/10 pb-6 relative group">
              <Link href="/item/1" className="w-32 h-40 bg-[#f5f5f5] flex-shrink-0 overflow-hidden">
                <img alt="シルクブラウス" className="w-full h-full object-cover object-top hover:scale-105 transition-transform duration-500" src="https://readdy.ai/api/search-image?query=elegant%20black%20silk%20blouse%20on%20white%20background%20minimalist%20fashion%20photography%20high%20quality%20luxury%20fabric%20texture%20soft%20lighting%20professional%20product%20shot%20clean%20simple%20backdrop&amp;width=400&amp;height=500&amp;seq=cart1&amp;orientation=portrait" />
              </Link>
              <div className="flex-1">
                <div className="flex justify-between items-start mb-2">
                  <Link href="/item/1">
                    <h3 className="text-lg text-black hover:text-[#474747] transition-colors cursor-pointer" style={{ fontFamily: 'acumin-pro, sans-serif' }}>シルクブラウス</h3>
                  </Link>
                  <div className="flex items-center gap-2">
                    <button className="w-8 h-8 flex items-center justify-center text-[#474747] hover:text-red-600 transition-colors cursor-pointer opacity-0 group-hover:opacity-100"><i className="ri-heart-line text-xl"></i></button>
                    <button className="w-8 h-8 flex items-center justify-center text-[#474747] hover:text-black transition-colors cursor-pointer opacity-0 group-hover:opacity-100"><i className="ri-close-line text-xl"></i></button>
                  </div>
                </div>
                <p className="text-sm text-[#474747] mb-1" style={{ fontFamily: 'acumin-pro, sans-serif' }}>カラー: ブラック</p>
                <p className="text-sm text-[#474747] mb-4" style={{ fontFamily: 'acumin-pro, sans-serif' }}>サイズ: M</p>
                <div className="flex items-center justify-between">
                  <p className="text-lg text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>¥28,000</p>
                  <div className="flex items-center gap-2">
                    <button disabled className="w-8 h-8 border border-black flex items-center justify-center hover:bg-black hover:text-white transition-all duration-300 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-white disabled:hover:text-black"><i className="ri-subtract-line text-sm"></i></button>
                    <span className="text-sm w-8 text-center" style={{ fontFamily: 'acumin-pro, sans-serif' }}>1</span>
                    <button className="w-8 h-8 border border-black flex items-center justify-center hover:bg-black hover:text-white transition-all duration-300 cursor-pointer"><i className="ri-add-line text-sm"></i></button>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex gap-6 border-b border-black/10 pb-6 relative group">
              <Link href="/item/2" className="w-32 h-40 bg-[#f5f5f5] flex-shrink-0 overflow-hidden">
                <img alt="ウールコート" className="w-full h-full object-cover object-top hover:scale-105 transition-transform duration-500" src="https://readdy.ai/api/search-image?query=navy%20blue%20wool%20coat%20on%20white%20background%20classic%20elegant%20outerwear%20fashion%20photography%20luxury%20winter%20clothing%20professional%20product%20image%20clean%20minimal%20setting&amp;width=400&amp;height=500&amp;seq=cart2&amp;orientation=portrait" />
              </Link>
              <div className="flex-1">
                <div className="flex justify-between items-start mb-2">
                  <Link href="/item/2">
                    <h3 className="text-lg text-black hover:text-[#474747] transition-colors cursor-pointer" style={{ fontFamily: 'acumin-pro, sans-serif' }}>ウールコート</h3>
                  </Link>
                  <div className="flex items-center gap-2">
                    <button className="w-8 h-8 flex items-center justify-center text-[#474747] hover:text-red-600 transition-colors cursor-pointer opacity-0 group-hover:opacity-100"><i className="ri-heart-line text-xl"></i></button>
                    <button className="w-8 h-8 flex items-center justify-center text-[#474747] hover:text-black transition-colors cursor-pointer opacity-0 group-hover:opacity-100"><i className="ri-close-line text-xl"></i></button>
                  </div>
                </div>
                <p className="text-sm text-[#474747] mb-1" style={{ fontFamily: 'acumin-pro, sans-serif' }}>カラー: ネイビー</p>
                <p className="text-sm text-[#474747] mb-4" style={{ fontFamily: 'acumin-pro, sans-serif' }}>サイズ: L</p>
                <div className="flex items-center justify-between">
                  <p className="text-lg text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>¥68,000</p>
                  <div className="flex items-center gap-2">
                    <button className="w-8 h-8 border border-black flex items-center justify-center hover:bg-black hover:text-white transition-all duration-300 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-white disabled:hover:text-black"><i className="ri-subtract-line text-sm"></i></button>
                    <span className="text-sm w-8 text-center" style={{ fontFamily: 'acumin-pro, sans-serif' }}>2</span>
                    <button className="w-8 h-8 border border-black flex items-center justify-center hover:bg-black hover:text-white transition-all duration-300 cursor-pointer"><i className="ri-add-line text-sm"></i></button>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex gap-6 border-b border-black/10 pb-6 relative group">
              <Link href="/item/3" className="w-32 h-40 bg-[#f5f5f5] flex-shrink-0 overflow-hidden">
                <img alt="レザーバッグ" className="w-full h-full object-cover object-top hover:scale-105 transition-transform duration-500" src="https://readdy.ai/api/search-image?query=gold%20leather%20handbag%20on%20white%20background%20luxury%20fashion%20accessory%20elegant%20design%20professional%20product%20photography%20high%20quality%20craftsmanship%20clean%20minimal%20backdrop&amp;width=400&amp;height=500&amp;seq=cart3&amp;orientation=portrait" />
              </Link>
              <div className="flex-1">
                <div className="flex justify-between items-start mb-2">
                  <Link href="/item/3">
                    <h3 className="text-lg text-black hover:text-[#474747] transition-colors cursor-pointer" style={{ fontFamily: 'acumin-pro, sans-serif' }}>レザーバッグ</h3>
                  </Link>
                  <div className="flex items-center gap-2">
                    <button className="w-8 h-8 flex items-center justify-center text-[#474747] hover:text-red-600 transition-colors cursor-pointer opacity-0 group-hover:opacity-100"><i className="ri-heart-line text-xl"></i></button>
                    <button className="w-8 h-8 flex items-center justify-center text-[#474747] hover:text-black transition-colors cursor-pointer opacity-0 group-hover:opacity-100"><i className="ri-close-line text-xl"></i></button>
                  </div>
                </div>
                <p className="text-sm text-[#474747] mb-1" style={{ fontFamily: 'acumin-pro, sans-serif' }}>カラー: ゴールド</p>
                <p className="text-sm text-[#474747] mb-4" style={{ fontFamily: 'acumin-pro, sans-serif' }}>サイズ: FREE</p>
                <div className="flex items-center justify-between">
                  <p className="text-lg text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>¥45,000</p>
                  <div className="flex items-center gap-2">
                    <button disabled className="w-8 h-8 border border-black flex items-center justify-center hover:bg-black hover:text-white transition-all duration-300 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-white disabled:hover:text-black"><i className="ri-subtract-line text-sm"></i></button>
                    <span className="text-sm w-8 text-center" style={{ fontFamily: 'acumin-pro, sans-serif' }}>1</span>
                    <button className="w-8 h-8 border border-black flex items-center justify-center hover:bg-black hover:text-white transition-all duration-300 cursor-pointer"><i className="ri-add-line text-sm"></i></button>
                  </div>
                </div>
              </div>
            </div>

            <div className="pt-6">
              <Link href="/item" className="inline-flex items-center gap-2 text-sm text-black hover:text-[#474747] transition-colors cursor-pointer" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                <i className="ri-arrow-left-line"></i>買い物を続ける
              </Link>
            </div>
          </div>

          <div className="lg:col-span-1">
            <div className="border border-black/10 p-8 sticky top-32">
              <h2 className="text-2xl text-black mb-8 tracking-tight" style={{ fontFamily: 'Didot, serif' }}>Order Summary</h2>
              <div className="mb-6">
                <label className="block text-xs text-[#474747] mb-2 tracking-wider" style={{ fontFamily: 'acumin-pro, sans-serif' }}>プロモーションコード</label>
                <div className="flex gap-2">
                  <input placeholder="コードを入力" className="flex-1 px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black transition-colors" type="text" value={""} style={{ fontFamily: 'acumin-pro, sans-serif' }} />
                  <button className="px-6 py-3 bg-black text-white text-xs tracking-widest hover:bg-[#474747] transition-all duration-300 cursor-pointer whitespace-nowrap" style={{ fontFamily: 'acumin-pro, sans-serif' }}>適用</button>
                </div>
                <p className="text-xs text-[#474747] mt-2" style={{ fontFamily: 'acumin-pro, sans-serif' }}>お試し: WELCOME10 または SAVE20</p>
              </div>

              <div className="space-y-4 mb-8 pb-8 border-b border-black/10">
                <div className="flex justify-between"><span className="text-sm text-[#474747]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>小計</span><span className="text-sm text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>¥209,000</span></div>
                <div className="flex justify-between"><span className="text-sm text-[#474747]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>配送料</span><span className="text-sm text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>無料</span></div>
              </div>

              <div className="flex justify-between mb-8"><span className="text-lg text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>合計</span><span className="text-2xl text-black" style={{ fontFamily: 'Didot, serif' }}>¥209,000</span></div>

              <Link href="/checkout" className="block w-full py-4 bg-black text-white text-sm tracking-widest text-center hover:bg-[#474747] transition-all duration-300 cursor-pointer whitespace-nowrap mb-4" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                購入手続きへ進む
              </Link>

              <div className="space-y-3 pt-6 border-t border-black/10">
                <div className="flex items-center gap-3"><div className="w-5 h-5 flex items-center justify-center"><i className="ri-shield-check-line text-lg text-black"></i></div><p className="text-xs text-[#474747]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>安全な決済</p></div>
                <div className="flex items-center gap-3"><div className="w-5 h-5 flex items-center justify-center"><i className="ri-truck-line text-lg text-black"></i></div><p className="text-xs text-[#474747]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>2-5営業日でお届け</p></div>
                <div className="flex items-center gap-3"><div className="w-5 h-5 flex items-center justify-center"><i className="ri-arrow-go-back-line text-lg text-black"></i></div><p className="text-xs text-[#474747]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>30日間返品可能</p></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
