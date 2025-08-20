'use client';

import React, { useState, useRef } from "react";

const initialOrders = [
  {
    id: "#ORD-001",
    customer: "田中太郎",
    item: "プレミアムコーヒー豆 × 2",
    date: "2025-01-09",
    payment: "クレジットカード",
    paid: "2025-01-09",
    shipped: "2025-01-10",
    status: "配送完了",
  },
  {
    id: "#ORD-002",
    customer: "佐藤花子",
    item: "オーガニック緑茶",
    date: "2025-01-09",
    payment: "銀行振込",
    paid: "-",
    shipped: "-",
    status: "入金待ち",
  },
  {
    id: "#ORD-003",
    customer: "鈴木次郎",
    item: "ハンドメイドマグカップ",
    date: "2025-01-08",
    payment: "PayPay",
    paid: "2025-01-08",
    shipped: "-",
    status: "発送済み",
  },
  {
    id: "#ORD-004",
    customer: "山田美咲",
    item: "アロマキャンドル × 2",
    date: "2025-01-07",
    payment: "コンビニ払い",
    paid: "2025-01-07",
    shipped: "2025-01-08",
    status: "発送済み",
  },
  {
    id: "#ORD-005",
    customer: "高橋健一",
    item: "オーガニックハニー",
    date: "2025-01-06",
    payment: "クレジットカード",
    paid: "-",
    shipped: "-",
    status: "キャンセル",
  },
];

const initialProducts = [
  {
    id: 1,
    name: "プレミアムコーヒー豆",
    price: 2500,
    description: "香り高いアラビカ種100%のコーヒー豆。",
    stock: 20,
    published: true,
    labels: ["食品"]
  },
  {
    id: 2,
    name: "オーガニック緑茶",
    price: 1200,
    description: "有機栽培の茶葉を使用した緑茶。",
    stock: 50,
    published: false,
    labels: ["飲料"]
  },
  {
    id: 3,
    name: "ハンドメイドマグカップ",
    price: 1800,
    description: "職人が手作りした温かみのあるマグカップ。",
    stock: 10,
    published: true,
    labels: ["雑貨", "メンズ"]
  },
  {
    id: 4,
    name: "アロマキャンドル",
    price: 900,
    description: "リラックス効果のあるアロマキャンドル。",
    stock: 35,
    published: true,
    labels: ["雑貨", "リラックス"]
  },
  {
    id: 5,
    name: "オーガニックハニー",
    price: 1500,
    description: "自然の恵みたっぷりのオーガニックはちみつ。",
    stock: 5,
    published: false,
    labels: ["食品"]
  },
];

const statusClass = (status: string) => {
  switch (status) {
    case "入金待ち":
      return "bg-gray-100 text-gray-700";
    case "発送待ち":
      return "bg-yellow-100 text-yellow-700";
    case "発送済み":
      return "bg-purple-100 text-purple-700";
    case "配送完了":
      return "bg-black text-white";
    case "キャンセル":
      return "bg-red-100 text-red-600";
    default:
      return "bg-gray-100 text-gray-700";
  }
};

const nextStatus = (status: string) => {
  switch (status) {
    case "入金待ち":
      return "発送待ち";
    case "発送待ち":
      return "発送済み";
    case "発送済み":
      return "配送完了";
    default:
      return status;
  }
};

const AdminPage = () => {
  const [tab, setTab] = useState<"dashboard" | "orders" | "products">("dashboard");
  const [orders, setOrders] = useState(initialOrders);
  const [products, setProducts] = useState(initialProducts);
  const [selectedProducts, setSelectedProducts] = useState<number[]>([]);
  const [editingProduct, setEditingProduct] = useState<{id: number, field: 'name' | 'description' | 'price' | 'stock' | 'published'}|null>(null);
  const [editValue, setEditValue] = useState('');
  const [openDropdownId, setOpenDropdownId] = useState<number|null>(null);
  const [labelInputs, setLabelInputs] = useState<{[id:number]: string}>({});
  const [openLabelId, setOpenLabelId] = useState<number|null>(null);
  const [allLabels, setAllLabels] = useState<string[]>(["食品", "飲料", "雑貨", "メンズ", "リラックス"]);
  const dropdownRefs = useRef<{[key:number]: HTMLDivElement|null}>({});

  // ドロップダウン外クリックで閉じる
  React.useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (openDropdownId !== null) {
        const ref = dropdownRefs.current[openDropdownId];
        if (ref && !ref.contains(e.target as Node)) {
          setOpenDropdownId(null);
        }
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [openDropdownId]);

  // --- ポップアップ外クリックで閉じる ---
  React.useEffect(() => {
    if (openLabelId === null) return;
    const handleClick = (e: MouseEvent) => {
      const popups = document.querySelectorAll('.z-20');
      let inside = false;
      popups.forEach(popup => {
        if (popup.contains(e.target as Node)) inside = true;
      });
      if (!inside) setOpenLabelId(null);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [openLabelId]);

  const handleNextStatus = (id: string) => {
    setOrders((prev) =>
      prev.map((order) =>
        order.id === id && order.status !== "配送完了" && order.status !== "キャンセル"
          ? { ...order, status: nextStatus(order.status) }
          : order
      )
    );
  };

  const handleCancel = (id: string) => {
    setOrders((prev) =>
      prev.map((order) =>
        order.id === id && order.status !== "配送完了"
          ? { ...order, status: "キャンセル" }
          : order
      )
    );
  };

  const handleProductSelect = (id: number) => {
    setSelectedProducts((prev) =>
      prev.includes(id) ? prev.filter((pid) => pid !== id) : [...prev, id]
    );
  };

  const handleSelectAllProducts = (checked: boolean) => {
    setSelectedProducts(checked ? products.map((p) => p.id) : []);
  };

  const handleDeleteProduct = (id: number) => {
    setProducts((prev) => prev.filter((p) => p.id !== id));
    setSelectedProducts((prev) => prev.filter((pid) => pid !== id));
  };

  const handleEditStart = (id: number, field: 'name' | 'description' | 'price' | 'stock', value: string | number) => {
    setEditingProduct({id, field});
    setEditValue(String(value));
  };

  const handleEditSave = (id: number, field: 'name' | 'description' | 'price' | 'stock') => {
    setProducts((prev) => prev.map((p) =>
      p.id === id ? {
        ...p,
        [field]: field === 'price' || field === 'stock' ? Number(editValue) : editValue
      } : p
    ));
    setEditingProduct(null);
    setEditValue('');
  };

  const handleEditCancel = () => {
    setEditingProduct(null);
    setEditValue('');
  };

  return (
    <div className="pt-20 p-8 bg-[#f8f9fb] min-h-screen">
      {/* ナビゲーションバー */}
      <nav className="flex gap-8 mb-8 bg-white rounded-lg shadow-sm px-6 py-3 items-center">
        <button
          className={`flex items-center gap-2 px-3 py-1 rounded font-medium border border-gray-200 focus:outline-none focus:ring-2 focus:ring-black ${
            tab === "dashboard"
              ? "text-gray-900 bg-gray-100"
              : "text-gray-500 hover:bg-gray-100"
          }`}
          onClick={() => setTab("dashboard")}
        >
          <span className="text-lg">山</span>
          <span>ダッシュボード</span>
        </button>
        <button
          className={`flex items-center gap-2 px-3 py-1 rounded font-medium ${tab === "products" ? "text-gray-900 bg-gray-100 border border-gray-200" : "text-gray-500 hover:bg-gray-100"}`}
          onClick={() => setTab("products")}
        >
          <span className="text-lg">📦</span>
          <span>商品管理</span>
        </button>
        <button
          className={`flex items-center gap-2 px-3 py-1 rounded font-medium ${tab === "orders" ? "text-gray-900 bg-gray-100 border border-gray-200" : "text-gray-500 hover:bg-gray-100"}`}
          onClick={() => setTab("orders")}
        >
          <span className="text-lg">🛒</span>
          <span>注文管理</span>
        </button>
      </nav>

      {tab === "dashboard" && (
        <>
          {/* ダッシュボードタイトル */}
          <h1 className="text-2xl font-bold mb-2">ダッシュボード</h1>
          <p className="text-gray-500 mb-8">ストアの売上と統計情報を確認できます</p>
          {/* カード一覧 */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
            {/* 総売上 */}
            <div className="bg-white rounded-lg shadow-sm p-6 border border-gray-100 flex flex-col">
              <span className="text-gray-500 text-sm mb-1">総売上</span>
              <span className="text-2xl font-bold mb-1">¥125,000</span>
              <span className="text-green-600 text-xs font-medium flex items-center gap-1">
                前月比 +12.5%{" "}
                <span className="text-green-400">↑</span>
              </span>
            </div>
            {/* 注文数 */}
            <div className="bg-white rounded-lg shadow-sm p-6 border border-gray-100 flex flex-col">
              <span className="text-gray-500 text-sm mb-1">注文数</span>
              <span className="text-2xl font-bold mb-1">342</span>
              <span className="text-purple-600 text-xs font-medium">今月の注文</span>
            </div>
            {/* 訪問者数 */}
            <div className="bg-white rounded-lg shadow-sm p-6 border border-gray-100 flex flex-col">
              <span className="text-gray-500 text-sm mb-1">訪問者数</span>
              <span className="text-2xl font-bold mb-1">1250</span>
              <span className="text-purple-600 text-xs font-medium">今週の訪問者</span>
            </div>
            {/* 登録商品数 */}
            <div className="bg-white rounded-lg shadow-sm p-6 border border-gray-100 flex flex-col">
              <span className="text-gray-500 text-sm mb-1">登録商品数</span>
              <span className="text-2xl font-bold mb-1">28</span>
              <span className="text-orange-600 text-xs font-medium">アクティブ商品</span>
            </div>
          </div>
        </>
      )}

      {tab === "orders" && (
        <div className="bg-white rounded-lg shadow-sm p-6 border border-gray-100 mt-4 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-gray-500 border-b">
                <th className="px-4 py-2 text-left">注文番号</th>
                <th className="px-4 py-2 text-left">顧客名</th>
                <th className="px-4 py-2 text-left">商品名</th>
                <th className="px-4 py-2 text-left">注文日</th>
                <th className="px-4 py-2 text-left">決済手段</th>
                <th className="px-4 py-2 text-left">入金日</th>
                <th className="px-4 py-2 text-left">発送日</th>
                <th className="px-4 py-2 text-left">ステータス</th>
                <th className="px-4 py-2 text-left">アクション</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.id} className="border-b last:border-b-0">
                  <td className="px-4 py-2 whitespace-nowrap font-mono">
                    {order.id}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap">
                    {order.customer}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap">{order.item}</td>
                  <td className="px-4 py-2 whitespace-nowrap">{order.date}</td>
                  <td className="px-4 py-2 whitespace-nowrap">{order.payment}</td>
                  <td className="px-4 py-2 whitespace-nowrap">{order.paid}</td>
                  <td className="px-4 py-2 whitespace-nowrap">{order.shipped}</td>
                  <td className="px-4 py-2 whitespace-nowrap">
                    <span
                      className={`px-3 py-1 rounded-full text-xs font-bold ${statusClass(
                        order.status
                      )}`}
                    >
                      {order.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap flex gap-2">
                    {order.status !== "配送完了" && order.status !== "キャンセル" && (
                      <button
                        className="px-3 py-1 rounded-full text-xs font-bold bg-blue-100 text-blue-700 hover:bg-blue-200"
                        onClick={() => handleNextStatus(order.id)}
                      >
                        {order.status === "入金待ち" && "発送待ちにする"}
                        {order.status === "発送待ち" && "発送済みにする"}
                        {order.status === "発送済み" && "配送完了にする"}
                      </button>
                    )}
                    {order.status !== "配送完了" && order.status !== "キャンセル" && (
                      <button
                        className="px-3 py-1 rounded-full text-xs font-bold bg-red-100 text-red-600 hover:bg-red-200"
                        onClick={() => handleCancel(order.id)}
                      >
                        キャンセル
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === "products" && (
        <div className="bg-white rounded-lg shadow-sm p-6 border border-gray-100 mt-4 overflow-x-auto">
          <table className="min-w-full text-sm border border-gray-200">
            <thead>
              <tr className="text-gray-500 border-b border-gray-200">
                <th className="px-4 py-2 border-r border-gray-200">
                  <input
                    type="checkbox"
                    checked={selectedProducts.length === products.length && products.length > 0}
                    onChange={e => handleSelectAllProducts(e.target.checked)}
                  />
                </th>
                <th className="px-4 py-2 text-left border-r border-gray-200">商品名</th>
                <th className="px-4 py-2 text-left border-r border-gray-200">商品説明</th>
                <th className="px-4 py-2 text-left border-r border-gray-200">ラベル</th>
                <th className="px-4 py-2 text-left border-r border-gray-200">価格</th>
                <th className="px-4 py-2 text-left border-r border-gray-200">在庫数</th>
                <th className="px-4 py-2 text-left border-r border-gray-200">公開/非公開</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {products.map((product) => (
                <tr key={product.id} className="border-b border-gray-200 last:border-b-0">
                  <td className="px-4 py-2 text-center border-r border-gray-200">
                    <input
                      type="checkbox"
                      checked={selectedProducts.includes(product.id)}
                      onChange={() => handleProductSelect(product.id)}
                    />
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap border-r border-gray-200 cursor-pointer" onClick={() => handleEditStart(product.id, 'name', product.name)}>
                    {editingProduct && editingProduct.id === product.id && editingProduct.field === 'name' ? (
                      <input
                        className="border rounded px-2 py-1 w-full"
                        value={editValue}
                        onBlur={() => handleEditSave(product.id, 'name')}
                        onKeyDown={e => { if (e.key === 'Enter') handleEditSave(product.id, 'name'); if (e.key === 'Escape') handleEditCancel(); }}
                        autoFocus
                      />
                    ) : (
                      product.name
                    )}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap border-r border-gray-200 cursor-pointer max-w-xs truncate" title={product.description} onClick={() => handleEditStart(product.id, 'description', product.description)}>
                    {editingProduct && editingProduct.id === product.id && editingProduct.field === 'description' ? (
                      <textarea
                        className="border rounded px-2 py-1 w-full"
                        value={editValue}
                        onBlur={() => handleEditSave(product.id, 'description')}
                        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleEditSave(product.id, 'description'); } if (e.key === 'Escape') handleEditCancel(); }}
                        rows={2}
                        autoFocus
                      />
                    ) : (
                      product.description
                    )}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap border-r border-gray-200 min-w-[120px] relative">
                    <div
                      className="flex flex-wrap gap-1 min-h-[28px] cursor-pointer"
                      onClick={() => setOpenLabelId(product.id)}
                      tabIndex={0}
                    >
                      {product.labels && product.labels.length > 0 ? product.labels.map((label, idx) => (
                        <span key={label+idx} className="bg-blue-100 text-blue-700 rounded-full px-2 py-0.5 text-xs font-bold flex items-center gap-1">
                          {label}
                          <button
                            type="button"
                            className="ml-1 text-blue-400 hover:text-red-400 focus:outline-none"
                            onClick={e => {
                              e.stopPropagation();
                              setProducts(prev => prev.map(p => p.id === product.id ? { ...p, labels: p.labels.filter(l => l !== label) } : p));
                            }}
                            aria-label="ラベル削除"
                          >×</button>
                        </span>
                      )) : <span className="text-gray-400 text-xs">ラベルを追加</span>}
                    </div>
                    {openLabelId === product.id && (
                      <div className="absolute z-20 left-0 top-8 bg-white border border-gray-200 rounded shadow p-2 min-w-[200px]" style={{minWidth:220}} onClick={e => e.stopPropagation()}>
                        <div className="flex flex-col gap-1 mb-2 max-h-32 overflow-y-auto">
                          {allLabels.length === 0 && <span className="text-gray-400 text-xs">ラベルがありません</span>}
                          {allLabels.map((label, idx) => (
                            <div key={label+idx} className="flex items-center gap-2 cursor-pointer group">
                              <input
                                type="checkbox"
                                checked={product.labels.includes(label)}
                                onChange={e => {
                                  if (e.target.checked) {
                                    setProducts(prev => prev.map(p => p.id === product.id ? { ...p, labels: [...(p.labels||[]), label] } : p));
                                  } else {
                                    setProducts(prev => prev.map(p => p.id === product.id ? { ...p, labels: p.labels.filter(l => l !== label) } : p));
                                  }
                                }}
                              />
                              <span className="bg-blue-100 text-blue-700 rounded-full px-2 py-0.5 text-xs font-bold flex items-center gap-1">
                                {label}
                                <button
                                  type="button"
                                  className="ml-1 text-blue-400 hover:text-red-400 focus:outline-none"
                                  onClick={e => {
                                    e.stopPropagation();
                                    setAllLabels(prev => prev.filter(l => l !== label));
                                    setProducts(prev => prev.map(p => ({ ...p, labels: p.labels.filter(l => l !== label) })));
                                  }}
                                  aria-label="全体ラベル削除"
                                >×</button>
                              </span>
                            </div>
                          ))}
                        </div>
                        <div className="flex items-center gap-1 mt-2">
                          <input
                            type="text"
                            className="border rounded px-2 py-0.5 text-xs flex-1"
                            value={labelInputs[product.id] || ''}
                            onChange={e => setLabelInputs(inputs => ({...inputs, [product.id]: e.target.value}))}
                            onKeyDown={e => {
                              if (e.key === 'Enter' && labelInputs[product.id]?.trim()) {
                                const newLabel = labelInputs[product.id].trim();
                                if (!allLabels.includes(newLabel)) setAllLabels(prev => [...prev, newLabel]);
                                if (!product.labels.includes(newLabel)) {
                                  setProducts(prev => prev.map(p => p.id === product.id ? { ...p, labels: [...(p.labels||[]), newLabel] } : p));
                                }
                                setLabelInputs(inputs => ({...inputs, [product.id]: ''}));
                              }
                            }}
                            placeholder="ラベル追加"
                            autoFocus
                          />
                          <button
                            type="button"
                            className="bg-blue-500 text-white rounded px-2 py-0.5 text-xs hover:bg-blue-600"
                            onClick={() => {
                              if (labelInputs[product.id]?.trim()) {
                                const newLabel = labelInputs[product.id].trim();
                                if (!allLabels.includes(newLabel)) setAllLabels(prev => [...prev, newLabel]);
                                if (!product.labels.includes(newLabel)) {
                                  setProducts(prev => prev.map(p => p.id === product.id ? { ...p, labels: [...(p.labels||[]), newLabel] } : p));
                                }
                                setLabelInputs(inputs => ({...inputs, [product.id]: ''}));
                              }
                            }}
                          >＋</button>
                        </div>
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap border-r border-gray-200 cursor-pointer" onClick={() => handleEditStart(product.id, 'price', product.price)}>
                    {editingProduct && editingProduct.id === product.id && editingProduct.field === 'price' ? (
                      <span className="flex items-center">
                        <span className="mr-1">¥</span>
                        <input
                          type="number"
                          className="border rounded px-2 py-1 w-20"
                          value={editValue}
                          onBlur={() => handleEditSave(product.id, 'price')}
                          onKeyDown={e => { if (e.key === 'Enter') handleEditSave(product.id, 'price'); if (e.key === 'Escape') handleEditCancel(); }}
                          autoFocus
                          min={0}
                        />
                      </span>
                    ) : (
                      <span>¥{product.price.toLocaleString()}</span>
                    )}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap border-r border-gray-200 cursor-pointer" onClick={() => handleEditStart(product.id, 'stock', product.stock)}>
                    {editingProduct && editingProduct.id === product.id && editingProduct.field === 'stock' ? (
                      <span className="flex items-center">
                        <input
                          type="number"
                          className="border rounded px-2 py-1 w-16"
                          value={editValue}
                          onBlur={() => handleEditSave(product.id, 'stock')}
                          onKeyDown={e => { if (e.key === 'Enter') handleEditSave(product.id, 'stock'); if (e.key === 'Escape') handleEditCancel(); }}
                          autoFocus
                          min={0}
                        />
                      </span>
                    ) : (
                      product.stock
                    )}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap border-r border-gray-200 relative">
                    <div
                      ref={el => { dropdownRefs.current[product.id] = el; }}
                      className="inline-block w-[80px]"
                    >
                      <button
                        type="button"
                        className={`w-full px-2 py-1 rounded-full text-xs font-bold focus:outline-none flex items-center justify-center ${product.published ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-600'}`}
                        onClick={() => setOpenDropdownId(openDropdownId === product.id ? null : product.id)}
                      >
                        {product.published ? '公開' : '非公開'}
                        <svg className="ml-1 w-3 h-3 text-gray-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7"/></svg>
                      </button>
                      {openDropdownId === product.id && (
                        <div className="absolute z-10 mt-1 left-0 w-[80px] bg-white border border-gray-200 rounded shadow">
                          <button
                            type="button"
                            className="w-full px-2 py-1 rounded-full text-xs font-bold mb-1 flex items-center justify-center bg-green-100 text-green-700 hover:bg-green-200"
                            onClick={() => {
                              setProducts(prev => prev.map(p => p.id === product.id ? { ...p, published: true } : p));
                              setOpenDropdownId(null);
                            }}
                          >公開</button>
                          <button
                            type="button"
                            className="w-full px-2 py-1 rounded-full text-xs font-bold flex items-center justify-center bg-gray-200 text-gray-600 hover:bg-gray-300"
                            onClick={() => {
                              setProducts(prev => prev.map(p => p.id === product.id ? { ...p, published: false } : p));
                              setOpenDropdownId(null);
                            }}
                          >非公開</button>
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2 text-center">
                    <button
                      className="text-red-500 hover:text-red-700"
                      onClick={() => handleDeleteProduct(product.id)}
                      title="削除"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" viewBox="0 0 24 24"><path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 7h12m-1 0v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V7m3 4v4m4-4v4m-5-7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default AdminPage;
