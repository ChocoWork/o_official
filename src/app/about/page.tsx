export default function StoryPage() {
  return (
    <main className="pt-32 pb-20">
      <div className="max-w-6xl mx-auto px-6 lg:px-12">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 mb-24">
          <div className="aspect-[4/5] bg-[#f5f5f5] overflow-hidden">
            <img
              alt="Brand Philosophy"
              className="w-full h-full object-cover object-center"
              src="https://readdy.ai/api/search-image?query=Minimalist%20fashion%20brand%20concept%20image%20showing%20elegant%20neutral%20toned%20clothing%20items%20carefully%20arranged%20on%20clean%20white%20geometric%20architectural%20structures%20with%20soft%20natural%20lighting%20emphasizing%20quality%20craftsmanship%20and%20timeless%20design%20philosophy&amp;width=800&amp;height=1000&amp;seq=about001&amp;orientation=portrait"
            />
          </div>
          <div className="flex flex-col justify-center space-y-8">
            <div>
              <h2 className="text-3xl text-black mb-6 tracking-tight">Brand Philosophy</h2>
              <p className="text-base text-[#474747] leading-relaxed mb-4">
                Le Fil des Heuresは、「時を紡ぐニュートラルモードな日常着」をコンセプトに、時代を超えて愛される普遍的なデザインと上質な素材にこだわったアパレルブランドです。
              </p>
              <p className="text-base text-[#474747] leading-relaxed">
                ミニマルでありながら洗練されたデザイン、そして着る人の個性を引き立てるニュートラルなカラーパレット。私たちは、日常に寄り添いながらも特別な瞬間を演出する服を提案します。
              </p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 mb-24">
          <div className="flex flex-col justify-center space-y-8 lg:order-2">
            <div>
              <h2 className="text-3xl text-black mb-6 tracking-tight">Quality &amp; Craftsmanship</h2>
              <p className="text-base text-[#474747] leading-relaxed mb-4">
                厳選された上質な素材と、熟練した職人による丁寧な縫製。細部にまでこだわり抜いた製品づくりが、Le Fil des Heuresの品質を支えています。
              </p>
              <p className="text-base text-[#474747] leading-relaxed">
                長く愛用していただけるよう、耐久性と快適性を両立させた服作りを心がけています。
              </p>
            </div>
          </div>
          <div className="aspect-[4/5] bg-[#f5f5f5] overflow-hidden lg:order-1">
            <img
              alt="Quality &amp; Craftsmanship"
              className="w-full h-full object-cover object-center"
              src="https://readdy.ai/api/search-image?query=Close%20up%20detail%20photography%20of%20high%20quality%20fabric%20texture%20and%20precise%20stitching%20on%20neutral%20beige%20garment%20with%20soft%20natural%20lighting%20highlighting%20craftsmanship%20and%20material%20quality%20in%20minimalist%20fashion%20production&amp;width=800&amp;height=1000&amp;seq=about002&amp;orientation=portrait"
            />
          </div>
        </div>

        <div className="mb-24">
          <h2 className="text-3xl text-black mb-12 tracking-tight text-center">Our Values</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <div className="text-center space-y-4">
              <div className="w-16 h-16 mx-auto flex items-center justify-center"><i className="ri-time-line text-4xl text-black"></i></div>
              <h3 className="text-xl text-black tracking-tight">Timeless</h3>
              <p className="text-sm text-[#474747] leading-relaxed">流行に左右されない、時代を超えたデザイン</p>
            </div>

            <div className="text-center space-y-4">
              <div className="w-16 h-16 mx-auto flex items-center justify-center"><i className="ri-leaf-line text-4xl text-black"></i></div>
              <h3 className="text-xl text-black tracking-tight">Sustainable</h3>
              <p className="text-sm text-[#474747] leading-relaxed">環境に配慮した素材と製造プロセス</p>
            </div>

            <div className="text-center space-y-4">
              <div className="w-16 h-16 mx-auto flex items-center justify-center"><i className="ri-heart-line text-4xl text-black"></i></div>
              <h3 className="text-xl text-black tracking-tight">Thoughtful</h3>
              <p className="text-sm text-[#474747] leading-relaxed">着る人に寄り添う、心地よい服作り</p>
            </div>
          </div>
        </div>

        <div className="bg-[#f5f5f5] p-12 lg:p-16">
          <div className="max-w-3xl mx-auto text-center">
            <h2 className="text-3xl text-black mb-6 tracking-tight">Contact Us</h2>
            <p className="text-base text-[#474747] leading-relaxed mb-8">
              ご質問やお問い合わせは、以下のメールアドレスまでお気軽にご連絡ください。
            </p>
            <a href="mailto:info@lefildesheures.com" className="text-lg text-black hover:text-[#474747] transition-colors duration-300 tracking-wide">info@lefildesheures.com</a>
          </div>
        </div>
      </div>
    </main>
  );
}