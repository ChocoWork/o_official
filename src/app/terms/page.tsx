import type { Metadata } from 'next';
import type { CSSProperties } from 'react';

const pageTitleStyle: CSSProperties = { fontSize: 'var(--lk-size-4xl)' };
const sectionTitleStyle: CSSProperties = { fontSize: 'var(--lk-size-lg)' };
const bodyTextStyle: CSSProperties = { fontSize: 'var(--lk-size-md)' };
const dateTextStyle: CSSProperties = { fontSize: 'var(--lk-size-sm)' };

export async function generateMetadata(): Promise<Metadata> {
  const title = 'Terms of Service | Le Fil des Heures';
  const description = 'Le Fil des Heures の利用規約ページです。会員登録、注文、支払方法、配送、返品・交換、免責事項をご確認いただけます。';

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      images: ['/mainphoto.png'],
    },
  };
}

export default function TermsPage() {
  return (
    <div className="w-full max-w-4xl mx-auto">
      <h1 className="mb-8" style={pageTitleStyle}>Terms of Service</h1>

      <nav aria-label="目次" className="mb-10 border-t border-b border-black/10 py-6 max-w-[68ch]">
        <p className="mb-3 tracking-widest text-[#474747]" style={dateTextStyle}>目次</p>
        <ol className="space-y-2 text-[#474747]" style={bodyTextStyle}>
          <li><a href="#terms-1" className="underline-offset-4 hover:underline hover:text-black transition-colors">第1条（適用）</a></li>
          <li><a href="#terms-2" className="underline-offset-4 hover:underline hover:text-black transition-colors">第2条（会員登録）</a></li>
          <li><a href="#terms-3" className="underline-offset-4 hover:underline hover:text-black transition-colors">第3条（商品の注文と契約の成立）</a></li>
          <li><a href="#terms-4" className="underline-offset-4 hover:underline hover:text-black transition-colors">第4条（支払方法）</a></li>
          <li><a href="#terms-5" className="underline-offset-4 hover:underline hover:text-black transition-colors">第5条（商品の配送）</a></li>
          <li><a href="#terms-6" className="underline-offset-4 hover:underline hover:text-black transition-colors">第6条（返品・交換）</a></li>
          <li><a href="#terms-7" className="underline-offset-4 hover:underline hover:text-black transition-colors">第7条（禁止事項）</a></li>
          <li><a href="#terms-8" className="underline-offset-4 hover:underline hover:text-black transition-colors">第8条（免責事項）</a></li>
          <li><a href="#terms-9" className="underline-offset-4 hover:underline hover:text-black transition-colors">第9条（規約の変更）</a></li>
          <li><a href="#terms-10" className="underline-offset-4 hover:underline hover:text-black transition-colors">第10条（準拠法・裁判管轄）</a></li>
        </ol>
      </nav>

      <div className="space-y-8 max-w-[68ch]">
        <section>
          <h2 className="mb-4 font-brand" style={sectionTitleStyle}>利用規約</h2>
          <p
            className="text-[#474747]"
            style={bodyTextStyle}
          >
            この利用規約（以下「本規約」）は、Le Fil des Heures（以下「当社」）が提供するオンラインストア及び関連サービス（以下「本サービス」）の利用条件を定めるものです。本サービスをご利用いただく際には、本規約に同意いただいたものとみなします。
          </p>
        </section>

        <section id="terms-1" className="scroll-mt-24">
          <h2 className="mb-4 font-brand" style={sectionTitleStyle}>第1条（適用）</h2>
          <p className="text-[#474747]" style={bodyTextStyle}>
            本規約は、本サービスの利用に関する当社とユーザーとの間の権利義務関係を定めることを目的とし、ユーザーと当社との間の本サービスの利用に関わる一切の関係に適用されます。
          </p>
        </section>

        <section id="terms-2" className="scroll-mt-24">
          <h2 className="mb-4 font-brand" style={sectionTitleStyle}>第2条（会員登録）</h2>
          <p className="text-[#474747] mb-4" style={bodyTextStyle}>本サービスの利用を希望する方は、本規約に同意の上、当社の定める方法によって会員登録を申請し、当社がこれを承認することによって、会員登録が完了するものとします。</p>
          <p className="text-[#474747]" style={bodyTextStyle}>当社は、会員登録の申請者に以下の事由があると判断した場合、会員登録の申請を承認しないことがあります：</p>
          <ul className="list-disc list-inside space-y-2 text-[#474747] mt-4" style={bodyTextStyle}>
            <li>虚偽の情報を登録した場合</li>
            <li>過去に本規約違反等により会員資格の取消を受けたことがある場合</li>
            <li>その他、当社が会員登録を適当でないと判断した場合</li>
          </ul>
        </section>

        <section id="terms-3" className="scroll-mt-24">
          <h2 className="mb-4 font-brand" style={sectionTitleStyle}>第3条（商品の注文と契約の成立）</h2>
          <p className="text-[#474747]" style={bodyTextStyle}>
            ユーザーは、当社が定める方法により商品の購入を申し込むものとします。当社は、ユーザーからの注文を受けた後、注文確認メールを送信します。売買契約は、当社が注文確認メールを送信した時点で成立するものとします。
          </p>
        </section>

        <section id="terms-4" className="scroll-mt-24">
          <h2 className="mb-4 font-brand" style={sectionTitleStyle}>第4条（支払方法）</h2>
          <p className="text-[#474747] mb-4" style={bodyTextStyle}>ユーザーは、商品代金及び送料等を、以下のいずれかの方法により支払うものとします：</p>
          <ul className="list-disc list-inside space-y-2 text-[#474747]" style={bodyTextStyle}>
            <li>クレジットカード決済</li>
            <li>PayPay</li>
            <li>コンビニ決済</li>
          </ul>
        </section>

        <section id="terms-5" className="scroll-mt-24">
          <h2 className="mb-4 font-brand" style={sectionTitleStyle}>第5条（商品の配送）</h2>
          <p className="text-[#474747]" style={bodyTextStyle}>
            当社は、ユーザーが指定した配送先に商品を配送します。配送期間は、注文確定後、通常3〜7営業日となります。ただし、天災地変その他の不可抗力、配送業者の事情等により、配送が遅延する場合があります。
          </p>
        </section>

        <section id="terms-6" className="scroll-mt-24">
          <h2 className="mb-4 font-brand" style={sectionTitleStyle}>第6条（返品・交換）</h2>
          <p className="text-[#474747]" style={bodyTextStyle}>
            本サービスの商品は受注生産のため、お客様のご都合による返品・交換は原則としてお受けできません。商品に不良があった場合、または注文と異なる商品が届いた場合に限り、商品到着後7日以内にご連絡いただくことで、当社負担にて返品・交換または再制作の対応をいたします。
          </p>
        </section>

        <section id="terms-7" className="scroll-mt-24">
          <h2 className="mb-4 font-brand" style={sectionTitleStyle}>第7条（禁止事項）</h2>
          <p className="text-[#474747] mb-4" style={bodyTextStyle}>
            ユーザーは、本サービスの利用にあたり、以下の行為をしてはなりません：
          </p>
          <ul className="list-disc list-inside space-y-2 text-[#474747]" style={bodyTextStyle}>
            <li>法令または公序良俗に違反する行為</li>
            <li>犯罪行為に関連する行為</li>
            <li>当社のサーバーまたはネットワークの機能を破壊したり、妨害したりする行為</li>
            <li>当社のサービスの運営を妨害するおそれのある行為</li>
            <li>他のユーザーに関する個人情報等を収集または蓄積する行為</li>
            <li>他のユーザーに成りすます行為</li>
            <li>その他、当社が不適切と判断する行為</li>
          </ul>
        </section>

        <section id="terms-8" className="scroll-mt-24">
          <h2 className="mb-4 font-brand" style={sectionTitleStyle}>第8条（免責事項）</h2>
          <p className="text-[#474747]" style={bodyTextStyle}>
            当社は、本サービスに関して、ユーザーと他のユーザーまたは第三者との間において生じた取引、連絡または紛争等について一切責任を負いません。
          </p>
        </section>

        <section id="terms-9" className="scroll-mt-24">
          <h2 className="mb-4 font-brand" style={sectionTitleStyle}>第9条（規約の変更）</h2>
          <p className="text-[#474747]" style={bodyTextStyle}>
            当社は、必要と判断した場合には、ユーザーに通知することなくいつでも本規約を変更することができるものとします。変更後の本規約は、当社ウェブサイトに掲示された時点から効力を生じるものとします。
          </p>
        </section>

        <section id="terms-10" className="scroll-mt-24">
          <h2 className="mb-4 font-brand" style={sectionTitleStyle}>第10条（準拠法・裁判管轄）</h2>
          <p className="text-[#474747]" style={bodyTextStyle}>
            本規約の解釈にあたっては、日本法を準拠法とします。本サービスに関して紛争が生じた場合には、東京地方裁判所を第一審の専属的合意管轄裁判所とします。
          </p>
        </section>

        <section>
          <p className="text-[#474747]" style={dateTextStyle}>
            制定日：2026年6月20日
            <br />
            最終改定日：2026年6月20日
          </p>
        </section>
      </div>
    </div>
  );
}
