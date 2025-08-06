"use client"; // これを追加

import React, { useState } from 'react';

export default function ContactPage() {
    const [selectedInquiryType, setSelectedInquiryType] = useState('');

    const handleInquiryChange = (event) => {
        setSelectedInquiryType(event.target.value);
    };

    return (
      <main className="px-5 pt-30 pb-10">
        <div id="contact">
            <div id="contactList" className="flex justify-center">
                <div id="mainContents" className="ja">
                    {/* 注意事項 */}
                    <h5 className="text-xl font-bold mb-2">注意事項</h5>
                    <p className="mb-6">
                        お問い合わせが集中している場合はご返答までにお時間をいただく場合もございます。<br />
                        ご意見、ご質問は、できるだけ具体的な内容の記入をお願いいたします。<br />
                        <br />
                        受付:月〜金（土日祝日休業）10:00〜18:00<br />
                        土日祝日のお問い合わせに関しては、翌営業日以降の対応となります。<br />
                        <br />
                        返品・交換についてはこちら<br />
                        <br />
                        弊社サイトのプライバシーポリシー<br />
                        <br />
                    </p>
                    {/* お問い合わせ内容 */}
                    <h5 className="text-xl font-bold mb-2">お問い合わせ内容</h5>
                    <div className="mb-6">
                        <label htmlFor="inquiryType" className="block mb-2">お問い合わせ内容</label>
                        <select
                            id="inquiryType"
                            value={selectedInquiryType}
                            onChange={handleInquiryChange}
                            className="border rounded-md p-2 w-full"
                        >
                            <option value="choice">選択してください</option>
                            <option value="customerOnline">CUSTOMER/ONLINE STORE での購入品·お買い物について</option>
                            <option value="customerAll">CUSTOMER/商品全般·お取り扱い店舗について</option>
                            <option value="wholesaleJapan">WHOLESALE/新規お取り扱い(Japan)</option>
                            <option value="wholesaleInternational">WHOLESALE/新規お取り扱い(International)</option>
                            <option value="pressJapan">PRESS/ご取材·リースについて (Japan)</option>
                            <option value="pressInternational">PRESS/ご取材·リースについて(International)</option>
                            <option value="recruit">RECRUIT/採用について</option>
                            <option value="other">その他</option>
                        </select>
                    </div>
                    <p className="mb-2">お問い合わせ内容詳細</p>
                    <div className="mb-6">
                        <textarea className="border rounded-md p-2 w-full" rows="4" placeholder="詳細を入力してください"></textarea>
                    </div>
                    {/* お客様情報 */}
                    <h5 className="text-xl font-bold mb-2">お客様情報</h5>
                    <p className="mb-2">お名前（漢字）</p>
                    <div className="mb-6">
                        <input type="text" className="border rounded-md p-2 w-full" placeholder="お名前（漢字）" />
                    </div>
                    <p className="mb-2">お名前（フリガナ）</p>
                    <div className="mb-6">
                        <input type="text" className="border rounded-md p-2 w-full" placeholder="お名前（フリガナ）" />
                    </div>
                    <h5 className="mb-2">メールアドレス</h5>
                    <div className="mb-6">
                        <input type="email" className="border rounded-md p-2 w-full" placeholder="メールアドレス" />
                    </div>
                    <h5 className="mb-2">電話番号</h5>
                    <div className="mb-6">
                        <input type="tel" className="border rounded-md p-2 w-full" placeholder="電話番号" />
                    </div>
                </div>
            </div>
        </div>
      </main>
    );
}