import React from 'react';
import { Mail, Instagram, Twitter, Facebook } from 'lucide-react';

const Footer = () => {
  return (
    <footer className="border-t border-gray-200">
      {/* メインフッターセクション */}
      <div className="w-full px-4 sm:px-6 lg:px-16 xl:px-24 py-12">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
          {/* ロゴとブランド情報 */}
          <div className="lg:col-span-1">
            <div className="flex items-center mb-4">
              <img 
                src="/logo.png" 
                alt="Logo" 
                className="w-20 h-20 object-cover"
              />
            </div>
            {/* ソーシャルメディアアイコン */}
            <div className="flex space-x-4">
              <a href="#" className="text-gray-400 hover:text-gray-600 transition-colors">
                <Instagram className="w-5 h-5" />
              </a>
              <a href="#" className="text-gray-400 hover:text-gray-600 transition-colors">
                <Twitter className="w-5 h-5" />
              </a>
              <a href="#" className="text-gray-400 hover:text-gray-600 transition-colors">
                <Facebook className="w-5 h-5" />
              </a>
            </div>
          </div>

          {/* ナビゲーションリンク */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:col-span-2 gap-8">
            <div>
              {/* <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wider mb-4">
                CATEGORY
              </h3> */}
              <ul className="space-y-3">
                <li><a href="#" className="text-gray-600 hover:text-gray-900 transition-colors text-sm">ALL ITEM</a></li>
                <li><a href="#" className="text-gray-600 hover:text-gray-900 transition-colors text-sm">OUTER</a></li>
                <li><a href="#" className="text-gray-600 hover:text-gray-900 transition-colors text-sm">TOPS</a></li>
                <li><a href="#" className="text-gray-600 hover:text-gray-900 transition-colors text-sm">BOTTOMS</a></li>
              </ul>
            </div>

            <div>
              {/* <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wider mb-4">
                情報
              </h3> */}
              <ul className="space-y-3">
                <li><a href="#" className="text-gray-600 hover:text-gray-900 transition-colors text-sm">NEWS</a></li>
                <li><a href="#" className="text-gray-600 hover:text-gray-900 transition-colors text-sm">LOOK</a></li>
                <li><a href="#" className="text-gray-600 hover:text-gray-900 transition-colors text-sm">STORY</a></li>
                <li><a href="#" className="text-gray-600 hover:text-gray-900 transition-colors text-sm">STOCKIST</a></li>
              </ul>
            </div>

            <div>
              {/* <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wider mb-4">
                サポート
              </h3> */}
              <ul className="space-y-3">
                <li><a href="#" className="text-gray-600 hover:text-gray-900 transition-colors text-sm">CONTACT</a></li>
                <li><a href="#" className="text-gray-600 hover:text-gray-900 transition-colors text-sm">SIZE GUIDE</a></li>
                <li><a href="#" className="text-gray-600 hover:text-gray-900 transition-colors text-sm">SHIPPING & RETURNS</a></li>
                <li><a href="#" className="text-gray-600 hover:text-gray-900 transition-colors text-sm">FAQ</a></li>
              </ul>
            </div>
          </div>

          {/* ニュースレター登録 */}
          <div className="lg:col-span-1">
            <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wider mb-4">
              NEWS LETTER
            </h3>
            {/* <p className="text-gray-600 text-sm mb-4">
              最新情報やお得な情報をお届けします
            </p> */}
            <div className="flex gap-2">
              <input
              type="email"
              placeholder="Enter your email address"
              className="flex-1 px-4 py-2 border border-gray-300 rounded-sm focus:ring-2 focus:ring-gray-500 focus:border-transparent outline-none transition-all text-sm"
              />
              <button className="px-4 py-2 bg-gray-900 text-white rounded-sm hover:bg-gray-800 transition-colors text-sm font-medium flex items-center justify-center whitespace-nowrap">
              <Mail className="w-4 h-4 mr-2" />
              Subscribe
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* フッター下部 */}
      <div className="border-t border-gray-200 bg-white">
        <div className="w-full px-4 sm:px-6 lg:px-16 xl:px-24 py-6">
          <div className="flex flex-col sm:flex-row justify-between items-center space-y-4 sm:space-y-0">
            <div className="text-sm text-gray-600">
              © 2026 O. All rights reserved.
            </div>
            <div className="flex space-x-6">
              <a href="#" className="text-sm text-gray-600 hover:text-gray-900 transition-colors">
                Privacy Policy
              </a>
              <a href="#" className="text-sm text-gray-600 hover:text-gray-900 transition-colors">
                Terms Of Use
              </a>
                <a href="#" className="text-sm text-gray-600 hover:text-gray-900 transition-colors">
                Legal Notice
                </a>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;