'use client'
import Link from 'next/link';

export default function ItemPage() {
  return (
    <main className="pt-32 pb-20 px-6 lg:px-12">
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-12 gap-6">
          <div className="flex flex-wrap gap-3">
            <button className="px-6 py-2 text-xs tracking-widest transition-all duration-300 cursor-pointer whitespace-nowrap bg-black text-white" style={{ fontFamily: 'acumin-pro, sans-serif' }}>ALL</button>
            <button className="px-6 py-2 text-xs tracking-widest transition-all duration-300 cursor-pointer whitespace-nowrap border border-black text-black hover:bg-black hover:text-white" style={{ fontFamily: 'acumin-pro, sans-serif' }}>TOPS</button>
            <button className="px-6 py-2 text-xs tracking-widest transition-all duration-300 cursor-pointer whitespace-nowrap border border-black text-black hover:bg-black hover:text-white" style={{ fontFamily: 'acumin-pro, sans-serif' }}>BOTTOMS</button>
            <button className="px-6 py-2 text-xs tracking-widest transition-all duration-300 cursor-pointer whitespace-nowrap border border-black text-black hover:bg-black hover:text-white" style={{ fontFamily: 'acumin-pro, sans-serif' }}>OUTERWEAR</button>
            <button className="px-6 py-2 text-xs tracking-widest transition-all duration-300 cursor-pointer whitespace-nowrap border border-black text-black hover:bg-black hover:text-white" style={{ fontFamily: 'acumin-pro, sans-serif' }}>ACCESSORIES</button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
          <Link href="/item/1">
            <div className="group cursor-pointer">
              <div className="aspect-[3/4] bg-[#f5f5f5] mb-4 overflow-hidden">
                <img alt="Minimal Cotton Shirt" className="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-500" src="https://readdy.ai/api/search-image?query=Minimalist%20neutral%20beige%20cotton%20shirt%20laid%20flat%20on%20clean%20white%20surface%20with%20soft%20natural%20lighting%20showcasing%20simple%20elegant%20design%20and%20high%20quality%20fabric%20texture%20contemporary%20fashion%20product%20photography&width=600&height=800&seq=item001&orientation=portrait" />
              </div>
              <div className="space-y-2">
                <p className="text-xs text-[#474747] tracking-widest" style={{ fontFamily: 'acumin-pro, sans-serif' }}>TOPS</p>
                <h3 className="text-base text-black tracking-tight" style={{ fontFamily: 'acumin-pro, sans-serif' }}>Minimal Cotton Shirt</h3>
                <p className="text-sm text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>¥18,000</p>
              </div>
            </div>
          </Link>

          <Link href="/item/2">
            <div className="group cursor-pointer">
              <div className="aspect-[3/4] bg-[#f5f5f5] mb-4 overflow-hidden">
                <img alt="Wide Leg Trousers" className="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-500" src="https://readdy.ai/api/search-image?query=Elegant%20grey%20wide%20leg%20trousers%20folded%20neatly%20on%20white%20marble%20surface%20with%20natural%20lighting%20highlighting%20the%20drape%20and%20quality%20of%20the%20fabric%20minimalist%20fashion%20product%20photography&width=600&height=800&seq=item002&orientation=portrait" />
              </div>
              <div className="space-y-2">
                <p className="text-xs text-[#474747] tracking-widest" style={{ fontFamily: 'acumin-pro, sans-serif' }}>BOTTOMS</p>
                <h3 className="text-base text-black tracking-tight" style={{ fontFamily: 'acumin-pro, sans-serif' }}>Wide Leg Trousers</h3>
                <p className="text-sm text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>¥22,000</p>
              </div>
            </div>
          </Link>

          <Link href="/item/3">
            <div className="group cursor-pointer">
              <div className="aspect-[3/4] bg-[#f5f5f5] mb-4 overflow-hidden">
                <img alt="Cashmere Knit" className="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-500" src="https://readdy.ai/api/search-image?query=Luxurious%20sand%20beige%20cashmere%20knit%20sweater%20carefully%20arranged%20on%20white%20surface%20with%20soft%20lighting%20emphasizing%20the%20soft%20texture%20and%20premium%20quality%20minimalist%20product%20photography&width=600&height=800&seq=item003&orientation=portrait" />
              </div>
              <div className="space-y-2">
                <p className="text-xs text-[#474747] tracking-widest" style={{ fontFamily: 'acumin-pro, sans-serif' }}>TOPS</p>
                <h3 className="text-base text-black tracking-tight" style={{ fontFamily: 'acumin-pro, sans-serif' }}>Cashmere Knit</h3>
                <p className="text-sm text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>¥32,000</p>
              </div>
            </div>
          </Link>

          <Link href="/item/4">
            <div className="group cursor-pointer">
              <div className="aspect-[3/4] bg-[#f5f5f5] mb-4 overflow-hidden">
                <img alt="Wool Coat" className="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-500" src="https://readdy.ai/api/search-image?query=Classic%20neutral%20grey%20wool%20coat%20hanging%20on%20minimalist%20white%20wall%20with%20natural%20lighting%20showcasing%20the%20elegant%20silhouette%20and%20quality%20tailoring%20contemporary%20fashion%20product%20photography&width=600&height=800&seq=item004&orientation=portrait" />
              </div>
              <div className="space-y-2">
                <p className="text-xs text-[#474747] tracking-widest" style={{ fontFamily: 'acumin-pro, sans-serif' }}>OUTERWEAR</p>
                <h3 className="text-base text-black tracking-tight" style={{ fontFamily: 'acumin-pro, sans-serif' }}>Wool Coat</h3>
                <p className="text-sm text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>¥58,000</p>
              </div>
            </div>
          </Link>

          <Link href="/item/5">
            <div className="group cursor-pointer">
              <div className="aspect-[3/4] bg-[#f5f5f5] mb-4 overflow-hidden">
                <img alt="Leather Tote Bag" className="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-500" src="https://readdy.ai/api/search-image?query=Minimalist%20beige%20leather%20tote%20bag%20placed%20on%20clean%20white%20surface%20with%20natural%20lighting%20highlighting%20the%20quality%20leather%20texture%20and%20simple%20elegant%20design%20contemporary%20fashion%20accessory%20photography&width=600&height=800&seq=item005&orientation=portrait" />
              </div>
              <div className="space-y-2">
                <p className="text-xs text-[#474747] tracking-widest" style={{ fontFamily: 'acumin-pro, sans-serif' }}>ACCESSORIES</p>
                <h3 className="text-base text-black tracking-tight" style={{ fontFamily: 'acumin-pro, sans-serif' }}>Leather Tote Bag</h3>
                <p className="text-sm text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>¥28,000</p>
              </div>
            </div>
          </Link>

          <Link href="/item/6">
            <div className="group cursor-pointer">
              <div className="aspect-[3/4] bg-[#f5f5f5] mb-4 overflow-hidden">
                <img alt="Silk Blouse" className="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-500" src="https://readdy.ai/api/search-image?query=Elegant%20white%20silk%20blouse%20draped%20on%20white%20surface%20with%20soft%20natural%20lighting%20showcasing%20the%20luxurious%20fabric%20flow%20and%20minimalist%20design%20contemporary%20fashion%20product%20photography&width=600&height=800&seq=item006&orientation=portrait" />
              </div>
              <div className="space-y-2">
                <p className="text-xs text-[#474747] tracking-widest" style={{ fontFamily: 'acumin-pro, sans-serif' }}>TOPS</p>
                <h3 className="text-base text-black tracking-tight" style={{ fontFamily: 'acumin-pro, sans-serif' }}>Silk Blouse</h3>
                <p className="text-sm text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>¥24,000</p>
              </div>
            </div>
          </Link>

          <Link href="/item/7">
            <div className="group cursor-pointer">
              <div className="aspect-[3/4] bg-[#f5f5f5] mb-4 overflow-hidden">
                <img alt="Tailored Blazer" className="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-500" src="https://readdy.ai/api/search-image?query=Sophisticated%20black%20tailored%20blazer%20hanging%20on%20minimalist%20white%20background%20with%20natural%20lighting%20emphasizing%20the%20sharp%20lines%20and%20quality%20construction%20contemporary%20fashion%20photography&width=600&height=800&seq=item007&orientation=portrait" />
              </div>
              <div className="space-y-2">
                <p className="text-xs text-[#474747] tracking-widest" style={{ fontFamily: 'acumin-pro, sans-serif' }}>OUTERWEAR</p>
                <h3 className="text-base text-black tracking-tight" style={{ fontFamily: 'acumin-pro, sans-serif' }}>Tailored Blazer</h3>
                <p className="text-sm text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>¥42,000</p>
              </div>
            </div>
          </Link>

          <Link href="/item/8">
            <div className="group cursor-pointer">
              <div className="aspect-[3/4] bg-[#f5f5f5] mb-4 overflow-hidden">
                <img alt="Linen Pants" className="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-500" src="https://readdy.ai/api/search-image?query=Natural%20beige%20linen%20pants%20folded%20on%20white%20marble%20surface%20with%20soft%20lighting%20highlighting%20the%20breathable%20fabric%20texture%20and%20relaxed%20elegant%20fit%20minimalist%20product%20photography&width=600&height=800&seq=item008&orientation=portrait" />
              </div>
              <div className="space-y-2">
                <p className="text-xs text-[#474747] tracking-widest" style={{ fontFamily: 'acumin-pro, sans-serif' }}>BOTTOMS</p>
                <h3 className="text-base text-black tracking-tight" style={{ fontFamily: 'acumin-pro, sans-serif' }}>Linen Pants</h3>
                <p className="text-sm text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>¥19,000</p>
              </div>
            </div>
          </Link>

          <Link href="/item/9">
            <div className="group cursor-pointer">
              <div className="aspect-[3/4] bg-[#f5f5f5] mb-4 overflow-hidden">
                <img alt="Merino Wool Scarf" className="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-500" src="https://readdy.ai/api/search-image?query=Soft%20grey%20merino%20wool%20scarf%20artfully%20arranged%20on%20clean%20white%20surface%20with%20natural%20lighting%20showcasing%20the%20fine%20texture%20and%20elegant%20drape%20minimalist%20accessory%20photography&width=600&height=800&seq=item009&orientation=portrait" />
              </div>
              <div className="space-y-2">
                <p className="text-xs text-[#474747] tracking-widest" style={{ fontFamily: 'acumin-pro, sans-serif' }}>ACCESSORIES</p>
                <h3 className="text-base text-black tracking-tight" style={{ fontFamily: 'acumin-pro, sans-serif' }}>Merino Wool Scarf</h3>
                <p className="text-sm text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>¥12,000</p>
              </div>
            </div>
          </Link>

          <Link href="/item/10">
            <div className="group cursor-pointer">
              <div className="aspect-[3/4] bg-[#f5f5f5] mb-4 overflow-hidden">
                <img alt="Oversized Cardigan" className="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-500" src="https://readdy.ai/api/search-image?query=Cozy%20sand%20beige%20oversized%20cardigan%20laid%20flat%20on%20white%20surface%20with%20natural%20lighting%20highlighting%20the%20soft%20knit%20texture%20and%20relaxed%20silhouette%20contemporary%20fashion%20product%20photography&width=600&height=800&seq=item010&orientation=portrait" />
              </div>
              <div className="space-y-2">
                <p className="text-xs text-[#474747] tracking-widest" style={{ fontFamily: 'acumin-pro, sans-serif' }}>TOPS</p>
                <h3 className="text-base text-black tracking-tight" style={{ fontFamily: 'acumin-pro, sans-serif' }}>Oversized Cardigan</h3>
                <p className="text-sm text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>¥26,000</p>
              </div>
            </div>
          </Link>

          <Link href="/item/11">
            <div className="group cursor-pointer">
              <div className="aspect-[3/4] bg-[#f5f5f5] mb-4 overflow-hidden">
                <img alt="Pleated Skirt" className="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-500" src="https://readdy.ai/api/search-image?query=Elegant%20grey%20pleated%20midi%20skirt%20arranged%20on%20white%20surface%20with%20soft%20lighting%20showcasing%20the%20beautiful%20pleats%20and%20flowing%20fabric%20minimalist%20fashion%20product%20photography&width=600&height=800&seq=item011&orientation=portrait" />
              </div>
              <div className="space-y-2">
                <p className="text-xs text-[#474747] tracking-widest" style={{ fontFamily: 'acumin-pro, sans-serif' }}>BOTTOMS</p>
                <h3 className="text-base text-black tracking-tight" style={{ fontFamily: 'acumin-pro, sans-serif' }}>Pleated Skirt</h3>
                <p className="text-sm text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>¥21,000</p>
              </div>
            </div>
          </Link>

          <Link href="/item/12">
            <div className="group cursor-pointer">
              <div className="aspect-[3/4] bg-[#f5f5f5] mb-4 overflow-hidden">
                <img alt="Leather Belt" className="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-500" src="https://readdy.ai/api/search-image?query=Minimalist%20black%20leather%20belt%20coiled%20on%20clean%20white%20marble%20surface%20with%20natural%20lighting%20highlighting%20the%20quality%20leather%20and%20simple%20metal%20buckle%20contemporary%20accessory%20photography&width=600&height=800&seq=item012&orientation=portrait" />
              </div>
              <div className="space-y-2">
                <p className="text-xs text-[#474747] tracking-widest" style={{ fontFamily: 'acumin-pro, sans-serif' }}>ACCESSORIES</p>
                <h3 className="text-base text-black tracking-tight" style={{ fontFamily: 'acumin-pro, sans-serif' }}>Leather Belt</h3>
                <p className="text-sm text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>¥8,000</p>
              </div>
            </div>
          </Link>
        </div>
      </div>
    </main>
  );
}
