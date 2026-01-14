import React from 'react';

export default function PrivacyPage() {
  return (
    <main className="pt-32 pb-20">
      <div className="max-w-4xl mx-auto px-6 lg:px-12">
        <h1 className="text-4xl lg:text-5xl text-black mb-12 tracking-tight" style={{ fontFamily: 'Didot, serif' }}>Privacy Policy</h1>

        <div className="space-y-12">
          <section>
            <h2 className="text-2xl text-black mb-4 tracking-tight" style={{ fontFamily: 'Didot, serif' }}>個人情報の取り扱いについて</h2>
            <p className="text-base text-[#474747] leading-relaxed" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
              Le Fil des Heures（以下「当社」）は、お客様の個人情報保護の重要性について認識し、個人情報の保護に関する法律（以下「個人情報保護法」）を遵守すると共に、以下のプライバシーポリシー（以下「本ポリシー」）に従い、適切な取扱い及び保護に努めます。
            </p>
          </section>

          <section>
            <h2 className="text-2xl text-black mb-4 tracking-tight" style={{ fontFamily: 'Didot, serif' }}>1. 個人情報の定義</h2>
            <p className="text-base text-[#474747] leading-relaxed" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
              本ポリシーにおいて、個人情報とは、個人情報保護法第2条第1項により定義された個人情報、すなわち、生存する個人に関する情報であって、当該情報に含まれる氏名、生年月日その他の記述等により特定の個人を識別することができるもの（他の情報と容易に照合することができ、それにより特定の個人を識別することができることとなるものを含みます）、もしくは個人識別符号が含まれる情報を意味します。
            </p>
          </section>

          <section>
            <h2 className="text-2xl text-black mb-4 tracking-tight" style={{ fontFamily: 'Didot, serif' }}>2. 個人情報の収集方法</h2>
            <p className="text-base text-[#474747] leading-relaxed mb-4" style={{ fontFamily: 'acumin-pro, sans-serif' }}>当社は、以下の方法により個人情報を収集することがあります：</p>
            <ul className="list-disc list-inside space-y-2 text-base text-[#474747]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
              <li>オンラインストアでの商品購入時</li>
              <li>会員登録時</li>
              <li>お問い合わせフォームからのご連絡時</li>
              <li>メールマガジンの購読登録時</li>
              <li>キャンペーンやイベントへの参加時</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl text-black mb-4 tracking-tight" style={{ fontFamily: 'Didot, serif' }}>3. 個人情報の利用目的</h2>
            <p className="text-base text-[#474747] leading-relaxed mb-4" style={{ fontFamily: 'acumin-pro, sans-serif' }}>当社は、収集した個人情報を以下の目的で利用いたします：</p>
            <ul className="list-disc list-inside space-y-2 text-base text-[#474747]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
              <li>商品の発送及びサービスの提供</li>
              <li>お客様からのお問い合わせへの対応</li>
              <li>新商品やキャンペーン情報のご案内</li>
              <li>サービスの改善及び新サービスの開発</li>
              <li>利用規約違反行為への対応</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl text-black mb-4 tracking-tight" style={{ fontFamily: 'Didot, serif' }}>4. 個人情報の第三者提供</h2>
            <p className="text-base text-[#474747] leading-relaxed" style={{ fontFamily: 'acumin-pro, sans-serif' }}>当社は、以下の場合を除き、お客様の同意なく個人情報を第三者に提供することはありません：</p>
            <ul className="list-disc list-inside space-y-2 text-base text-[#474747] mt-4" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
              <li>法令に基づく場合</li>
              <li>人の生命、身体又は財産の保護のために必要がある場合</li>
              <li>公衆衛生の向上又は児童の健全な育成の推進のために特に必要がある場合</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl text-black mb-4 tracking-tight" style={{ fontFamily: 'Didot, serif' }}>5. 個人情報の安全管理</h2>
            <p className="text-base text-[#474747] leading-relaxed" style={{ fontFamily: 'acumin-pro, sans-serif' }}>当社は、個人情報の紛失、破壊、改ざん及び漏洩などのリスクに対して、個人情報の安全管理が図られるよう、当社の従業員に対し、必要かつ適切な監督を行います。また、個人情報の取扱いを委託する場合は、委託先において個人情報の安全管理が図られるよう、必要かつ適切な監督を行います。</p>
          </section>

          <section>
            <h2 className="text-2xl text-black mb-4 tracking-tight" style={{ fontFamily: 'Didot, serif' }}>6. お問い合わせ</h2>
            <p className="text-base text-[#474747] leading-relaxed" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
              個人情報の取扱いに関するお問い合わせは、以下の窓口までご連絡ください：
              <br />
              <br />
              Le Fil des Heures カスタマーサポート
              <br />
              Email: privacy@lefildesheures.com
              <br />
              Tel: 03-1234-5678
            </p>
          </section>

          <section>
            <p className="text-sm text-[#474747]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>制定日：2024年1月1日<br />最終改定日：2024年1月1日</p>
          </section>
        </div>
      </div>
    </main>
  );
}
