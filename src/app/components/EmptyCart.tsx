import React from 'react';
import { ShoppingBag, ArrowRight } from 'lucide-react';

interface EmptyCartProps {
  onStartShopping: () => void;
}

export const EmptyCart: React.FC<EmptyCartProps> = ({ onStartShopping }) => {
  return (
    <div className="text-center py-16">
      <div className="max-w-md mx-auto">
        <div className="bg-gray-50 rounded-full w-24 h-24 flex items-center justify-center mx-auto mb-6">
          <ShoppingBag className="w-12 h-12 text-gray-400" />
        </div>
        
        <h2 className="text-2xl font-semibold text-gray-900 mb-3">
          カートが空です
        </h2>
        
        <p className="text-gray-600 mb-8">
          まだ商品が追加されていません。<br />
          お気に入りの商品を見つけて、ショッピングを始めましょう。
        </p>
        
        <a
          href="http://localhost:3000/item"
          className="inline-flex items-center px-6 py-3 bg-gray-900 text-white font-medium rounded-sm hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-colors duration-200"
        >
          <span>ショッピングを始める</span>
          <ArrowRight className="w-5 h-5 ml-2" />
        </a>
      </div>
    </div>
  );
};