import React from 'react';
import Image from 'next/image';
import { Trash2, Heart } from 'lucide-react';
import { CartItem as CartItemType } from '../types/cart';
import { Button } from '@/app/components/ui/Button';
import { Stepper } from '@/app/components/ui/Stepper';

interface CartItemProps {
  item: CartItemType;
  onUpdateQuantity: (id: number, quantity: number) => void;
  onRemoveItem: (id: number) => void;
}

export const CartItem: React.FC<CartItemProps> = ({
  item,
  onUpdateQuantity,
  onRemoveItem,
}) => {
  const handleQuantityChange = (newQuantity: number) => {
    if (newQuantity >= 1) {
      onUpdateQuantity(item.id, newQuantity);
    }
  };

  return (
    <div className="bg-white p-6 border-t border-b border-l-0 border-r-0 border-gray-200 rounded-none transition-shadow duration-200">
      <div className="flex flex-col sm:flex-row gap-6">
        {/* 商品画像 */}
        <div className="flex-shrink-0">
          <Image
            src={item.image}
            alt={item.name}
            width={128}
            height={128}
            className="w-24 h-24 sm:w-32 sm:h-32 object-cover rounded-none border border-gray-200"
            unoptimized
          />
        </div>

        {/* 商品情報 */}
        <div className="flex-1 min-w-0">
          <div className="flex justify-between items-start mb-2">
            <div>
              <h3 className="text-lg font-semibold text-gray-900 truncate">
                {item.name}
              </h3>
              <p className="text-sm text-gray-500 mt-1">Color：{item.color}</p>
              <p className="text-sm text-gray-500 mt-1">Size：{item.size}</p>
              {/* 在庫表示・カテゴリ表示は削除済み */}
              <div className="mt-2">
                <Stepper
                  value={item.quantity}
                  min={1}
                  max={item.inStock ? Number.MAX_SAFE_INTEGER : item.quantity}
                  onChange={handleQuantityChange}
                 size="md"/>
              </div>
            </div>
            
            <div className="flex space-x-2">
              <Button variant="ghost" size="sm" className="p-2 text-gray-400 hover:text-red-500 transition-colors duration-200">
                <Heart className="w-5 h-5" />
              </Button>
              <Button
                onClick={() => onRemoveItem(item.id)}
                variant="ghost"
                size="sm"
                className="p-2 text-gray-400 hover:text-red-500 transition-colors duration-200"
              >
                <Trash2 className="w-5 h-5" />
              </Button>
            </div>
          </div>

          {/* 価格と数量コントロール */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="flex items-center space-x-4">
              <span className="text-2xl font-bold text-gray-900">
                ¥{item.price.toLocaleString()}
              </span>
            </div>

            <div className="flex items-center space-x-3">
              {/* 数量コントロールを削除済み */}
              <div className="text-right">
                <div className="text-lg font-semibold text-gray-900">
                  ¥{(item.price * item.quantity).toLocaleString()}
                </div>
                <div className="text-sm text-gray-500">小計</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};