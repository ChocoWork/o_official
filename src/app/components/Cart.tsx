import React, { useState } from 'react';
import { CartItem as CartItemType, CartSummary as CartSummaryType } from '../types/cart';
import { CartItem } from './CartItem';
import { CartSummary } from './CartSummary';
import { EmptyCart } from './EmptyCart';

const SAMPLE_ITEMS: CartItemType[] = [
  {
    id: '1',
    name: 'ワイヤレスノイズキャンセリングヘッドホン',
    price: 29800,
    image: 'https://images.pexels.com/photos/3394650/pexels-photo-3394650.jpeg?auto=compress&cs=tinysrgb&w=300',
    quantity: 1,
    category: 'オーディオ機器',
    color: 'ブラック',
    size: 'フリー', // サイズ追加
    inStock: true,
  },
  {
    id: '2',
    name: 'スマートウォッチ シリーズ8',
    price: 45800,
    image: 'https://images.pexels.com/photos/393047/pexels-photo-393047.jpeg?auto=compress&cs=tinysrgb&w=300',
    quantity: 2,
    category: 'ウェアラブル',
    color: 'シルバー',
    size: 'M', // サイズ追加
    inStock: true,
  },
  {
    id: '3',
    name: 'ワイヤレス充電器',
    price: 3980,
    image: 'https://images.pexels.com/photos/4526129/pexels-photo-4526129.jpeg?auto=compress&cs=tinysrgb&w=300',
    quantity: 1,
    category: 'アクセサリー',
    color: 'ホワイト',
    size: 'S', // サイズ追加
    inStock: false,
  },
];

export const Cart: React.FC = () => {
  const [cartItems, setCartItems] = useState<CartItemType[]>(SAMPLE_ITEMS);

  const updateQuantity = (id: string, quantity: number) => {
    setCartItems(items =>
      items.map(item =>
        item.id === id ? { ...item, quantity } : item
      )
    );
  };

  const removeItem = (id: string) => {
    setCartItems(items => items.filter(item => item.id !== id));
  };

  const startShopping = () => {
    // ショッピング開始の処理
    console.log('ショッピングを開始');
  };

  const handleCheckout = () => {
    // チェックアウトの処理
    console.log('チェックアウトに進む');
  };

  // 価格計算
  const subtotal = cartItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  const shipping = subtotal >= 3000 ? 0 : 500;
  const tax = Math.floor(subtotal * 0.1);
  const total = subtotal + shipping + tax;

  const summary: CartSummaryType = {
    subtotal,
    shipping,
    tax,
    total,
  };

  return (
    <div className="">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {cartItems.length === 0 ? (
          <EmptyCart onStartShopping={startShopping} />
        ) : (
          <div className="lg:grid lg:grid-cols-3 lg:gap-8">
            {/* カート商品リスト */}
            <div className="lg:col-span-2">
              <div>
                {cartItems.map(item => (
                  <CartItem
                    key={item.id}
                    item={item}
                    onUpdateQuantity={updateQuantity}
                    onRemoveItem={removeItem}
                  />
                ))}
              </div>
            </div>

            {/* 注文サマリー */}
            <div className="mt-8 lg:mt-0">
              <CartSummary
                summary={summary}
                onCheckout={handleCheckout}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};