import React from 'react';
import { CreditCard, Truck, Shield } from 'lucide-react';
import { CartSummary as CartSummaryType } from '../types/cart';

interface CartSummaryProps {
  summary: CartSummaryType;
  onCheckout: () => void;
}

export const CartSummary: React.FC<CartSummaryProps> = ({ summary, onCheckout }) => {
  return (
    <div className="bg-white p-6 border border-gray-200 shadow-sm sticky top-6">
      <h2 className="text-xl font-semibold text-gray-900 mb-6">注文内容</h2>
      
      {/* 価格の内訳 */}
      <div className="space-y-4 mb-6">
        <div className="flex justify-between text-gray-600">
          <span>小計</span>
          <span>¥{summary.subtotal.toLocaleString()}</span>
        </div>
        
        <div className="flex justify-between text-gray-600">
          <span>送料</span>
          <span>
            {summary.shipping === 0 ? '無料' : `¥${summary.shipping.toLocaleString()}`}
          </span>
        </div>
        
        <div className="flex justify-between text-gray-600">
          <span>消費税</span>
          <span>¥{summary.tax.toLocaleString()}</span>
        </div>
        
        <div className="border-t border-gray-200 pt-4">
          <div className="flex justify-between text-xl font-bold text-gray-900">
            <span>合計</span>
            <span>¥{summary.total.toLocaleString()}</span>
          </div>
        </div>
      </div>

      {/* チェックアウトボタン */}
      <button
        onClick={onCheckout}
        className="w-full bg-gray-900 text-white py-4 px-6 rounded-sm font-semibold text-lg hover:bg-gray-700 transition-colors duration-200 flex items-center justify-center space-x-2"
      >
        <CreditCard className="w-5 h-5" />
        <span>レジに進む</span>
      </button>

      {/* 安心できる情報 */}
      <div className="mt-6 space-y-3">
        <div className="flex items-center text-sm text-gray-600">
          <Truck className="w-4 h-4 mr-2 text-green-500" />
          <span>全国送料無料（¥3,000以上）</span>
        </div>
        
        <div className="flex items-center text-sm text-gray-600">
          <Shield className="w-4 h-4 mr-2 text-green-500" />
          <span>30日間返品・交換保証</span>
        </div>
      </div>

      {/* プロモーションコード */}
      <div className="mt-6 pt-6 border-t border-gray-200">
        <div className="flex space-x-2">
          <input
            type="text"
            placeholder="プロモーションコード"
            className="flex-1 px-3 py-2 border border-gray-300 rounded-sm text-sm focus:outline-none focus:ring-2 focus:ring-gray-500 focus:border-transparent"
          />
          <button className="px-4 py-2 bg-gray-100 text-gray-700 rounded-sm text-sm font-medium hover:bg-gray-200 transition-colors duration-200">
            適用
          </button>
        </div>
      </div>
    </div>
  );
};