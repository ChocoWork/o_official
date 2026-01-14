import React from 'react';
import Link from 'next/link';

export default function Page() {
  return (
    <main className="pt-32 pb-20 px-6 lg:px-12">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-12">
          <h1 className="text-4xl text-black tracking-tight" style={{ fontFamily: 'Didot, serif' }}>Wishlist</h1>
          <p className="text-sm text-[#474747]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>4点のアイテム</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8">
          <div className="group relative">
            <Link className="block" href="/item/1">
              <div className="aspect-[4/5] bg-[#f5f5f5] mb-4 overflow-hidden relative">
                <img
                  alt="カシミアセーター"
                  className="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-500"
                  src="https://readdy.ai/api/search-image?query=beige%20cashmere%20sweater%20on%20white%20background%20luxury%20knitwear%20soft%20texture%20elegant%20fashion%20photography%20professional%20product%20shot%20clean%20minimal%20setting%20high%20quality&width=400&height=500&seq=wish1&orientation=portrait"
                />
              </div>
            </Link>
            <button className="absolute top-4 right-4 w-10 h-10 bg-white flex items-center justify-center hover:bg-black hover:text-white transition-all duration-300 cursor-pointer opacity-0 group-hover:opacity-100">
              <i className="ri-close-line text-xl" />
            </button>
            <Link href="/item/1">
              <p className="text-xs text-[#474747] mb-2 tracking-wider" style={{ fontFamily: 'acumin-pro, sans-serif' }}>TOPS</p>
              <h3 className="text-base text-black mb-2 hover:text-[#474747] transition-colors" style={{ fontFamily: 'acumin-pro, sans-serif' }}>カシミアセーター</h3>
              <p className="text-sm text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>¥38,000</p>
            </Link>
          </div>

          <div className="group relative">
            <Link className="block" href="/item/2">
              <div className="aspect-[4/5] bg-[#f5f5f5] mb-4 overflow-hidden relative">
                <img
                  alt="レザージャケット"
                  className="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-500"
                  src="https://readdy.ai/api/search-image?query=black%20leather%20jacket%20on%20white%20background%20luxury%20outerwear%20classic%20biker%20style%20elegant%20fashion%20photography%20professional%20product%20image%20clean%20minimal%20backdrop&width=400&height=500&seq=wish2&orientation=portrait"
                />
              </div>
            </Link>
            <button className="absolute top-4 right-4 w-10 h-10 bg-white flex items-center justify-center hover:bg-black hover:text-white transition-all duration-300 cursor-pointer opacity-0 group-hover:opacity-100">
              <i className="ri-close-line text-xl" />
            </button>
            <Link href="/item/2">
              <p className="text-xs text-[#474747] mb-2 tracking-wider" style={{ fontFamily: 'acumin-pro, sans-serif' }}>OUTERWEAR</p>
              <h3 className="text-base text-black mb-2 hover:text-[#474747] transition-colors" style={{ fontFamily: 'acumin-pro, sans-serif' }}>レザージャケット</h3>
              <p className="text-sm text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>¥98,000</p>
            </Link>
          </div>

          <div className="group relative">
            <Link className="block" href="/item/3">
              <div className="aspect-[4/5] bg-[#f5f5f5] mb-4 overflow-hidden relative">
                <img
                  alt="シルクスカーフ"
                  className="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-500"
                  src="https://readdy.ai/api/search-image?query=pink%20silk%20scarf%20on%20white%20background%20luxury%20fashion%20accessory%20elegant%20pattern%20professional%20product%20photography%20high%20quality%20craftsmanship%20clean%20minimal%20setting&width=400&height=500&seq=wish3&orientation=portrait"
                />
              </div>
            </Link>
            <button className="absolute top-4 right-4 w-10 h-10 bg-white flex items-center justify-center hover:bg-black hover:text-white transition-all duration-300 cursor-pointer opacity-0 group-hover:opacity-100">
              <i className="ri-close-line text-xl" />
            </button>
            <Link href="/item/3">
              <p className="text-xs text-[#474747] mb-2 tracking-wider" style={{ fontFamily: 'acumin-pro, sans-serif' }}>ACCESSORIES</p>
              <h3 className="text-base text-black mb-2 hover:text-[#474747] transition-colors" style={{ fontFamily: 'acumin-pro, sans-serif' }}>シルクスカーフ</h3>
              <p className="text-sm text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>¥18,000</p>
            </Link>
          </div>

          <div className="group relative">
            <Link className="block" href="/item/4">
              <div className="aspect-[4/5] bg-[#f5f5f5] mb-4 overflow-hidden relative">
                <img
                  alt="ウールパンツ"
                  className="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-500"
                  src="https://readdy.ai/api/search-image?query=grey%20wool%20trousers%20on%20white%20background%20tailored%20pants%20elegant%20fashion%20photography%20luxury%20clothing%20professional%20product%20shot%20clean%20simple%20backdrop&width=400&height=500&seq=wish4&orientation=portrait"
                />
              </div>
            </Link>
            <button className="absolute top-4 right-4 w-10 h-10 bg-white flex items-center justify-center hover:bg-black hover:text-white transition-all duration-300 cursor-pointer opacity-0 group-hover:opacity-100">
              <i className="ri-close-line text-xl" />
            </button>
            <Link href="/item/4">
              <p className="text-xs text-[#474747] mb-2 tracking-wider" style={{ fontFamily: 'acumin-pro, sans-serif' }}>BOTTOMS</p>
              <h3 className="text-base text-black mb-2 hover:text-[#474747] transition-colors" style={{ fontFamily: 'acumin-pro, sans-serif' }}>ウールパンツ</h3>
              <p className="text-sm text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>¥32,000</p>
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
