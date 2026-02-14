"use client";

import React, { useState } from "react";

export default function Page({ params }: { params: { id: string } }) {
  const id = params.id;
  const [color, setColor] = useState<string>("Black");
  const [size, setSize] = useState<string | null>(null);
  const [quantity, setQuantity] = useState<number>(1);

  return (
    <main className="pt-32 pb-20 px-6 lg:px-12">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8">
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              history.back();
            }}
            className="text-sm text-[#474747] hover:text-black transition-colors duration-300 flex items-center gap-2 font-brand"
          >
            <i className="ri-arrow-left-line" />BACK TO ITEMS
          </a>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">
          <div>
            <div className="aspect-[3/4] bg-[#f5f5f5] mb-4 overflow-hidden">
              <img
                alt="Minimal Wool Coat"
                className="w-full h-full object-cover object-top"
                src="https://readdy.ai/api/search-image?query=Minimalist%20black%20wool%20coat%20on%20neutral%20beige%20background%20with%20clean%20lines%20and%20elegant%20silhouette%20showcasing%20timeless%20design%20and%20premium%20quality%20fabric%20texture%20in%20professional%20product%20photography&width=800&height=1200&seq=item001a&orientation=portrait"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="aspect-[3/4] bg-[#f5f5f5] overflow-hidden cursor-pointer ring-2 ring-black">
                <img
                  alt="Minimal Wool Coat 1"
                  className="w-full h-full object-cover object-top"
                  src="https://readdy.ai/api/search-image?query=Minimalist%20black%20wool%20coat%20on%20neutral%20beige%20background%20with%20clean%20lines%20and%20elegant%20silhouette%20showcasing%20timeless%20design%20and%20premium%20quality%20fabric%20texture%20in%20professional%20product%20photography&width=800&height=1200&seq=item001a&orientation=portrait"
                />
              </div>
              <div className="aspect-[3/4] bg-[#f5f5f5] overflow-hidden cursor-pointer ">
                <img
                  alt="Minimal Wool Coat 2"
                  className="w-full h-full object-cover object-top"
                  src="https://readdy.ai/api/search-image?query=Detail%20close%20up%20of%20minimalist%20black%20wool%20coat%20showing%20fabric%20texture%20buttons%20and%20precise%20stitching%20on%20neutral%20background%20highlighting%20craftsmanship%20and%20quality%20in%20professional%20product%20photography&width=800&height=1200&seq=item001b&orientation=portrait"
                />
              </div>
            </div>
          </div>

          <div className="space-y-8">
            <div>
              <p className="text-xs text-[#474747] tracking-widest mb-2 font-brand">
                OUTERWEAR
              </p>
              <h1 className="text-3xl lg:text-4xl text-black mb-4 tracking-tight font-display">
                Minimal Wool Coat
              </h1>
              <p className="text-2xl text-black font-brand">
                ¥89,000
              </p>
            </div>

            <div>
              <p className="text-base text-[#474747] leading-relaxed font-brand">
                上質なウールを使用したミニマルなコート。シンプルながら洗練されたデザインで、長く愛用していただける一着です。
              </p>
            </div>

            <div>
              <h3 className="text-sm tracking-widest mb-4 font-brand">
                COLOR
              </h3>
              <div className="flex gap-3">
                <button
                  onClick={() => setColor("Black")}
                  className={`px-6 py-2 text-xs tracking-widest transition-all duration-300 cursor-pointer whitespace-nowrap border border-black text-black hover:bg-black hover:text-white font-brand ${
                    color === "Black" ? "bg-black text-white" : ""
                  }`}
                >
                  Black
                </button>
                <button
                  onClick={() => setColor("Sand Beige")}
                  className={`px-6 py-2 text-xs tracking-widest transition-all duration-300 cursor-pointer whitespace-nowrap border border-black text-black hover:bg-black hover:text-white font-brand ${
                    color === "Sand Beige" ? "bg-black text-white" : ""
                  }`}
                >
                  Sand Beige
                </button>
              </div>
            </div>

            <div>
              <h3 className="text-sm tracking-widest mb-4 font-brand">
                SIZE
              </h3>
              <div className="flex gap-3">
                {(["S", "M", "L"] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setSize(s)}
                    className={`w-16 h-12 text-sm tracking-widest transition-all duration-300 cursor-pointer border border-black text-black hover:bg-black hover:text-white font-brand ${
                      size === s ? "bg-black text-white" : ""
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <h3 className="text-sm tracking-widest mb-4 font-brand">
                QUANTITY
              </h3>
              <div className="flex items-center gap-4">
                <button
                  onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                  className="w-10 h-10 border border-black flex items-center justify-center hover:bg-black hover:text-white transition-all duration-300 cursor-pointer"
                >
                  <i className="ri-subtract-line" />
                </button>
                <span className="text-lg w-12 text-center font-brand">
                  {quantity}
                </span>
                <button
                  onClick={() => setQuantity((q) => q + 1)}
                  className="w-10 h-10 border border-black flex items-center justify-center hover:bg-black hover:text-white transition-all duration-300 cursor-pointer"
                >
                  <i className="ri-add-line" />
                </button>
              </div>
            </div>

            <button
              onClick={(e) => e.preventDefault()}
              className="w-full py-4 bg-black text-white text-sm tracking-widest hover:bg-[#474747] transition-all duration-300 cursor-pointer whitespace-nowrap font-brand"
            >
              ADD TO CART
            </button>

            <div className="border-t border-black/10 pt-8">
              <h3 className="text-sm tracking-widest mb-4 font-brand">
                PRODUCT DETAILS
              </h3>
              <ul className="space-y-2">
                <li className="text-sm text-[#474747] font-brand">
                  素材：ウール100%
                </li>
                <li className="text-sm text-[#474747] font-brand">
                  裏地：キュプラ100%
                </li>
                <li className="text-sm text-[#474747] font-brand">
                  原産国：日本
                </li>
                <li className="text-sm text-[#474747] font-brand">
                  ドライクリーニング推奨
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
