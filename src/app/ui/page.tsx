"use client";

import Image from 'next/image';
import { useState } from "react";

export default function Page() {
  const [standardText, setStandardText] = useState("");
  const [email, setEmail] = useState("");
  const [radioValue, setRadioValue] = useState("option1");
  const [category, setCategory] = useState("TOPS");
  const [categoryOpen, setCategoryOpen] = useState(false);
  const categoryOptions = ["TOPS", "BOTTOMS", "OUTERWEAR", "ACCESSORIES"];

  const [sizes, setSizes] = useState(["S", "M"]);
  const [sizeOpen, setSizeOpen] = useState(false);
  const sizeOptions = ["S", "M", "L", "FREE"];
  const [notify, setNotify] = useState(false);

  // slider states
  const [singleValue, setSingleValue] = useState(50);
  // use 0–100 scale; default range corresponds to ¥0–¥10000
  const [rangeValues, setRangeValues] = useState<[number, number]>([0, 100]);
  const rangeMin = Math.min(rangeValues[0], rangeValues[1]);
  const rangeMax = Math.max(rangeValues[0], rangeValues[1]);
  // ...existing code...
  return (    <main className="pt-32 pb-20">
      <div className="max-w-7xl mx-auto px-6 lg:px-12">
        <h1
          className="text-5xl text-black mb-4 tracking-tight"
          style={{ fontFamily: "Didot, serif" }}
        >
          UI Components
        </h1>
        <p
          className="text-sm text-black/60 mb-16 tracking-wider"
          style={{ fontFamily: "acumin-pro, sans-serif" }}
        >
          Le Fil des Heures オリジナルUIコンポーネントライブラリ
        </p>

        <div className="space-y-24">
          {/* --- Text Field --- */}
          <section>
            <h2
              className="text-2xl text-black mb-8 tracking-tight"
              style={{ fontFamily: "Didot, serif" }}
            >
              Text Field
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              <div>
                <label
                  className="block text-xs tracking-widest mb-2 text-black/80"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  STANDARD
                </label>
                <input
                  placeholder="テキストを入力"
                  className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black transition-colors"
                  type="text"
                  value={standardText}
                  onChange={e => setStandardText(e.target.value)}
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                />
              </div>
              <div>
                <label
                  className="block text-xs tracking-widest mb-2 text-black/80"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  WITH ICON
                </label>
                <div className="relative">
                  <div className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 flex items-center justify-center">
                    <i className="ri-mail-line text-base text-black/60"></i>
                  </div>
                  <input
                    placeholder="メールアドレス"
                    className="w-full pl-12 pr-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black transition-colors"
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  />
                </div>
              </div>
              <div>
                <label
                  className="block text-xs tracking-widest mb-2 text-black/80"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  DISABLED
                </label>
                <input
                  disabled
                  className="w-full px-4 py-3 border border-black/10 text-sm bg-[#f5f5f5] text-black/40 cursor-not-allowed"
                  type="text"
                  value="無効な入力フィールド"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                />
              </div>
              <div>
                <label
                  className="block text-xs tracking-widest mb-2 text-black/80"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  TEXTAREA
                </label>
                <textarea
                  placeholder="メッセージを入力"
                  rows={4}
                  className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black resize-none transition-colors"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                ></textarea>
              </div>
            </div>
          </section>

          {/* --- Button --- */}
          <section>
            <h2
              className="text-2xl text-black mb-8 tracking-tight"
              style={{ fontFamily: "Didot, serif" }}
            >
              Button
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
              <div>
                <p
                  className="text-xs tracking-widest mb-4 text-black/80"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  PRIMARY
                </p>
                <button
                  className="w-full px-8 py-3 bg-black text-white text-sm tracking-widest hover:bg-[#474747] transition-all duration-300 cursor-pointer whitespace-nowrap"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  PRIMARY BUTTON
                </button>
              </div>
              <div>
                <p
                  className="text-xs tracking-widest mb-4 text-black/80"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  SECONDARY
                </p>
                <button
                  className="w-full px-8 py-3 border border-black text-black text-sm tracking-widest hover:bg-black hover:text-white transition-all duration-300 cursor-pointer whitespace-nowrap"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  SECONDARY BUTTON
                </button>
              </div>
              <div>
                <p
                  className="text-xs tracking-widest mb-4 text-black/80"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  TEXT
                </p>
                <button
                  className="w-full px-8 py-3 text-black text-sm tracking-widest hover:text-[#474747] transition-colors cursor-pointer whitespace-nowrap"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  TEXT BUTTON
                </button>
              </div>
              <div>
                <p
                  className="text-xs tracking-widest mb-4 text-black/80"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  WITH ICON
                </p>
                <button
                  className="w-full px-8 py-3 bg-black text-white text-sm tracking-widest hover:bg-[#474747] transition-all duration-300 cursor-pointer whitespace-nowrap flex items-center justify-center gap-2"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  <div className="w-4 h-4 flex items-center justify-center">
                    <i className="ri-shopping-bag-line text-base"></i>
                  </div>
                  ADD TO CART
                </button>
              </div>
              <div>
                <p
                  className="text-xs tracking-widest mb-4 text-black/80"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  ICON ONLY
                </p>
                <button
                  className="px-4 py-3 border border-black text-black hover:bg-black hover:text-white transition-all duration-300 cursor-pointer"
                >
                  <div className="w-5 h-5 flex items-center justify-center">
                    <i className="ri-heart-line text-xl"></i>
                  </div>
                </button>
              </div>
              <div>
                <p
                  className="text-xs tracking-widest mb-4 text-black/80"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  DISABLED
                </p>
                <button
                  disabled
                  className="w-full px-8 py-3 bg-black/20 text-white text-sm tracking-widest cursor-not-allowed whitespace-nowrap"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  DISABLED BUTTON
                </button>
              </div>
            </div>
          </section>

          {/* --- Radio Button --- */}
          <section>
            <h2
              className="text-2xl text-black mb-8 tracking-tight"
              style={{ fontFamily: "Didot, serif" }}
            >
              Radio Button
            </h2>
            <div className="space-y-4">
              <label className="flex items-center gap-3 cursor-pointer group">
                <input
                  className="w-5 h-5 cursor-pointer accent-black"
                  type="radio"
                  value="option1"
                  checked={radioValue === "option1"}
                  onChange={() => setRadioValue("option1")}
                />
                <span
                  className="text-sm text-black group-hover:text-[#474747] transition-colors"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  オプション 1
                </span>
              </label>
              <label className="flex items-center gap-3 cursor-pointer group">
                <input
                  className="w-5 h-5 cursor-pointer accent-black"
                  type="radio"
                  value="option2"
                  checked={radioValue === "option2"}
                  onChange={() => setRadioValue("option2")}
                />
                <span
                  className="text-sm text-black group-hover:text-[#474747] transition-colors"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  オプション 2
                </span>
              </label>
              <label className="flex items-center gap-3 cursor-pointer group">
                <input
                  className="w-5 h-5 cursor-pointer accent-black"
                  type="radio"
                  value="option3"
                  checked={radioValue === "option3"}
                  onChange={() => setRadioValue("option3")}
                />
                <span
                  className="text-sm text-black group-hover:text-[#474747] transition-colors"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  オプション 3
                </span>
              </label>
              <label className="flex items-center gap-3 cursor-not-allowed opacity-40">
                <input
                  disabled
                  className="w-5 h-5 cursor-not-allowed"
                  type="radio"
                  value="option4"
                />
                <span
                  className="text-sm text-black"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  無効なオプション
                </span>
              </label>
            </div>
          </section>

          {/* --- Checkbox --- */}
          <section>
            <h2
              className="text-2xl text-black mb-8 tracking-tight"
              style={{ fontFamily: "Didot, serif" }}
            >
              Checkbox
            </h2>
            <div className="space-y-4">
              <label className="flex items-center gap-3 cursor-pointer group">
                <input
                  className="w-5 h-5 cursor-pointer accent-black"
                  type="checkbox"
                />
                <span
                  className="text-sm text-black group-hover:text-[#474747] transition-colors"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  利用規約に同意する
                </span>
              </label>
              <label className="flex items-center gap-3 cursor-pointer group">
                <input
                  className="w-5 h-5 cursor-pointer accent-black"
                  type="checkbox"
                />
                <span
                  className="text-sm text-black group-hover:text-[#474747] transition-colors"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  ニュースレターを受け取る
                </span>
              </label>
              <label className="flex items-center gap-3 cursor-pointer group">
                <input
                  className="w-5 h-5 cursor-pointer accent-black"
                  type="checkbox"
                />
                <span
                  className="text-sm text-black group-hover:text-[#474747] transition-colors"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  プライバシーポリシーに同意する
                </span>
              </label>
              <label className="flex items-center gap-3 cursor-not-allowed opacity-40">
                <input
                  disabled
                  className="w-5 h-5 cursor-not-allowed"
                  type="checkbox"
                />
                <span
                  className="text-sm text-black"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  無効なチェックボックス
                </span>
              </label>
            </div>
          </section>

          {/* --- Single Select --- */}
          <section>
            <h2
              className="text-2xl text-black mb-8 tracking-tight"
              style={{ fontFamily: "Didot, serif" }}
            >
              Single Select
            </h2>
            <div className="max-w-md">
              <label
                className="block text-xs tracking-widest mb-2 text-black/80"
                style={{ fontFamily: "acumin-pro, sans-serif" }}
              >
                CATEGORY
              </label>
              <div className="relative">
                <button
                  type="button"
                  className="w-full px-4 py-3 border border-black/20 text-sm text-left focus:outline-none focus:border-black transition-colors cursor-pointer flex items-center justify-between"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                  onClick={() => setCategoryOpen((v) => !v)}
                  aria-haspopup="listbox"
                  aria-expanded={categoryOpen}
                >
                  <span>{category}</span>
                  <div className="w-4 h-4 flex items-center justify-center">
                    <i className="ri-arrow-down-s-line text-base transition-transform" style={{ transform: categoryOpen ? "rotate(180deg)" : undefined }}></i>
                  </div>
                </button>
                {categoryOpen && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-black/20 shadow-lg z-10">
                    {categoryOptions.map((opt) => (
                      <button
                        key={opt}
                        type="button"
                        className={
                          "w-full px-4 py-3 text-sm text-left hover:bg-[#f5f5f5] transition-colors cursor-pointer" +
                          (category === opt ? " bg-[#f5f5f5]" : "")
                        }
                        style={{ fontFamily: "acumin-pro, sans-serif" }}
                        onClick={() => {
                          setCategory(opt);
                          setCategoryOpen(false);
                        }}
                      >
                        {opt}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* --- Multi Select --- */}
          <section>
            <h2
              className="text-2xl text-black mb-8 tracking-tight"
              style={{ fontFamily: "Didot, serif" }}
            >
              Multi Select
            </h2>
            <div className="max-w-md">
              <label
                className="block text-xs tracking-widest mb-2 text-black/80"
                style={{ fontFamily: "acumin-pro, sans-serif" }}
              >
                SIZE
              </label>
              <div className="relative">
                <button
                  type="button"
                  className="w-full px-4 py-3 border border-black/20 text-sm text-left focus:outline-none focus:border-black transition-colors cursor-pointer flex items-center justify-between"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                  onClick={() => setSizeOpen((v) => !v)}
                  aria-haspopup="listbox"
                  aria-expanded={sizeOpen}
                >
                  <span>{sizes.length > 0 ? sizes.join(", ") : "選択してください"}</span>
                  <div className="w-4 h-4 flex items-center justify-center">
                    <i className={"ri-arrow-" + (sizeOpen ? "up" : "down") + "-s-line text-base transition-transform"}></i>
                  </div>
                </button>
                {sizeOpen && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-black/20 shadow-lg z-10">
                    {sizeOptions.map((opt) => (
                      <label
                        key={opt}
                        className="flex items-center gap-3 px-4 py-3 hover:bg-[#f5f5f5] transition-colors cursor-pointer"
                      >
                        <input
                          className="w-4 h-4 cursor-pointer accent-black"
                          type="checkbox"
                          checked={sizes.includes(opt)}
                          onChange={() => {
                            setSizes((prev) =>
                              prev.includes(opt)
                                ? prev.filter((s) => s !== opt)
                                : [...prev, opt]
                            );
                          }}
                        />
                        <span className="text-sm" style={{ fontFamily: "acumin-pro, sans-serif" }}>{opt}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* --- Switch / Toggle --- */}
          <section>
            <h2
              className="text-2xl text-black mb-8 tracking-tight"
              style={{ fontFamily: "Didot, serif" }}
            >
              Switch / Toggle
            </h2>
            <div className="space-y-6">
              <div className="flex items-center justify-between max-w-md">
                <span
                  className="text-sm text-black"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  通知を受け取る
                </span>
                <button
                  type="button"
                  className={`relative w-12 h-6 rounded-full transition-colors cursor-pointer ${notify ? 'bg-black' : 'bg-black/20'}`}
                  aria-pressed={notify}
                  onClick={() => setNotify((v) => !v)}
                >
                  <span
                    className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${notify ? 'translate-x-7' : 'left-1'}`}
                  ></span>
                </button>
              </div>
              <div className="flex items-center justify-between max-w-md opacity-40">
                <span
                  className="text-sm text-black"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  無効なスイッチ
                </span>
                <button
                  type="button"
                  disabled
                  className="relative w-12 h-6 rounded-full bg-black/20 cursor-not-allowed"
                >
                  <span className="absolute top-1 left-1 w-4 h-4 bg-white rounded-full"></span>
                </button>
              </div>
            </div>
          </section>

          {/* --- Slider --- */}
          <section>
            <h2
              className="text-2xl text-black mb-8 tracking-tight"
              style={{ fontFamily: "Didot, serif" }}
            >
              Slider
            </h2>
            <div className="space-y-12 max-w-md">
              <div>
                <div className="flex items-center justify-between mb-4">
                  <label
                    className="text-xs tracking-widest text-black/80"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    SINGLE VALUE
                  </label>
                  <span
                    className="text-sm text-black"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    {singleValue}
                  </span>
                </div>
                <input
                  min="0"
                  max="100"
                  className="w-full h-1 bg-black/20 rounded-full appearance-none cursor-pointer [&amp;::-webkit-slider-thumb]:appearance-none [&amp;::-webkit-slider-thumb]:w-4 [&amp;::-webkit-slider-thumb]:h-4 [&amp;::-webkit-slider-thumb]:rounded-full [&amp;::-webkit-slider-thumb]:bg-black [&amp;::-webkit-slider-thumb]:cursor-pointer [&amp;::-moz-range-thumb]:w-4 [&amp;::-moz-range-thumb]:h-4 [&amp;::-moz-range-thumb]:rounded-full [&amp;::-moz-range-thumb]:bg-black [&amp;::-moz-range-thumb]:border-0 [&amp;::-moz-range-thumb]:cursor-pointer"
                  type="range"
                  value={singleValue}
                  onChange={(e) => setSingleValue(Number(e.target.value))}
                />
              </div>
              <div>
                <div className="flex items-center justify-between mb-4">
                  <label
                    className="text-xs tracking-widest text-black/80"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    PRICE RANGE
                  </label>
                  <span
                    className="text-sm text-black"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    ¥{rangeMin * 100} - ¥{rangeMax * 100}
                  </span>
                </div>
                <div className="relative h-4" data-testid="price-range-track-wrap">
                  <div className="absolute left-0 top-1/2 h-1 w-full -translate-y-1/2 rounded-full bg-black/20" data-testid="price-range-track">
                    <div
                      data-testid="price-range-fill"
                      className="absolute top-0 h-full rounded-full bg-black"
                      style={{
                        left: `${rangeMin}%`,
                        width: `${rangeMax - rangeMin}%`,
                      }}
                    ></div>
                  </div>
                  <input
                    min="0"
                    max="100"
                    className="pointer-events-none absolute left-0 top-1/2 z-20 h-1 w-full -translate-y-1/2 appearance-none bg-transparent [accent-color:transparent] [&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:mt-[-6px] [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-black [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-track]:h-1 [&::-moz-range-track]:bg-transparent [&::-moz-range-progress]:bg-transparent [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-black [&::-moz-range-thumb]:cursor-pointer"
                    type="range"
                    step="1"
                    value={rangeMin}
                    aria-label="Minimum price"
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setRangeValues(([currentMin, currentMax]) => [
                        Math.min(v, Math.max(currentMin, currentMax)),
                        Math.max(currentMin, currentMax),
                      ]);
                    }}
                  />
                  <input
                    min="0"
                    max="100"
                    className="pointer-events-none absolute left-0 top-1/2 z-30 h-1 w-full -translate-y-1/2 appearance-none bg-transparent [accent-color:transparent] [&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:mt-[-6px] [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-black [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-track]:h-1 [&::-moz-range-track]:bg-transparent [&::-moz-range-progress]:bg-transparent [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-black [&::-moz-range-thumb]:cursor-pointer"
                    type="range"
                    step="1"
                    value={rangeMax}
                    aria-label="Maximum price"
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setRangeValues(([currentMin, currentMax]) => [
                        Math.min(currentMin, currentMax),
                        Math.max(v, Math.min(currentMin, currentMax)),
                      ]);
                    }}
                  />
                </div>
              </div>
            </div>
          </section>

          {/* --- Stepper --- */}
          <section>
            <h2
              className="text-2xl text-black mb-8 tracking-tight"
              style={{ fontFamily: "Didot, serif" }}
            >
              Stepper
            </h2>
            <div className="max-w-xs">
              <label
                className="block text-xs tracking-widest mb-2 text-black/80"
                style={{ fontFamily: "acumin-pro, sans-serif" }}
              >
                QUANTITY
              </label>
              <div className="flex items-center border border-black/20">
                <button
                  type="button"
                  className="w-12 h-12 flex items-center justify-center border-r border-black/20 hover:bg-[#f5f5f5] transition-colors cursor-pointer"
                >
                  <div className="w-4 h-4 flex items-center justify-center">
                    <i className="ri-subtract-line text-base"></i>
                  </div>
                </button>
                <input
                  className="flex-1 h-12 text-center text-sm focus:outline-none"
                  type="number"
                  value="1"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                />
                <button
                  type="button"
                  className="w-12 h-12 flex items-center justify-center border-l border-black/20 hover:bg-[#f5f5f5] transition-colors cursor-pointer"
                >
                  <div className="w-4 h-4 flex items-center justify-center">
                    <i className="ri-add-line text-base"></i>
                  </div>
                </button>
              </div>
            </div>
          </section>

          {/* --- Rating --- */}
          <section>
            <h2
              className="text-2xl text-black mb-8 tracking-tight"
              style={{ fontFamily: "Didot, serif" }}
            >
              Rating
            </h2>
            <div className="space-y-6">
              <div>
                <label
                  className="block text-xs tracking-widest mb-3 text-black/80"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  INTERACTIVE
                </label>
                <div className="flex items-center gap-2">
                  <button type="button" className="cursor-pointer transition-transform hover:scale-110">
                    <div className="w-6 h-6 flex items-center justify-center">
                      <i className="ri-star-fill text-2xl text-black"></i>
                    </div>
                  </button>
                  <button type="button" className="cursor-pointer transition-transform hover:scale-110">
                    <div className="w-6 h-6 flex items-center justify-center">
                      <i className="ri-star-fill text-2xl text-black"></i>
                    </div>
                  </button>
                  <button type="button" className="cursor-pointer transition-transform hover:scale-110">
                    <div className="w-6 h-6 flex items-center justify-center">
                      <i className="ri-star-fill text-2xl text-black"></i>
                    </div>
                  </button>
                  <button type="button" className="cursor-pointer transition-transform hover:scale-110">
                    <div className="w-6 h-6 flex items-center justify-center">
                      <i className="ri-star-line text-2xl text-black"></i>
                    </div>
                  </button>
                  <button type="button" className="cursor-pointer transition-transform hover:scale-110">
                    <div className="w-6 h-6 flex items-center justify-center">
                      <i className="ri-star-line text-2xl text-black"></i>
                    </div>
                  </button>
                  <span
                    className="ml-3 text-sm text-black"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    3 / 5
                  </span>
                </div>
              </div>
              <div>
                <label
                  className="block text-xs tracking-widest mb-3 text-black/80"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  READ ONLY
                </label>
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 flex items-center justify-center">
                    <i className="ri-star-fill text-2xl text-black"></i>
                  </div>
                  <div className="w-6 h-6 flex items-center justify-center">
                    <i className="ri-star-fill text-2xl text-black"></i>
                  </div>
                  <div className="w-6 h-6 flex items-center justify-center">
                    <i className="ri-star-fill text-2xl text-black"></i>
                  </div>
                  <div className="w-6 h-6 flex items-center justify-center">
                    <i className="ri-star-fill text-2xl text-black"></i>
                  </div>
                  <div className="w-6 h-6 flex items-center justify-center">
                    <i className="ri-star-line text-2xl text-black"></i>
                  </div>
                  <span
                    className="ml-3 text-sm text-black"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    4.0 / 5
                  </span>
                </div>
              </div>
            </div>
          </section>

          {/* --- Color Picker --- */}
          <section>
            <h2
              className="text-2xl text-black mb-8 tracking-tight"
              style={{ fontFamily: "Didot, serif" }}
            >
              Color Picker
            </h2>
            <div className="space-y-6">
              <div>
                <label
                  className="block text-xs tracking-widest mb-3 text-black/80"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  PRESET COLORS
                </label>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    className="w-10 h-10 rounded-full border-2 transition-all cursor-pointer border-black scale-110"
                    title="BLACK"
                    style={{ backgroundColor: "rgb(0, 0, 0)" }}
                  ></button>
                  <button
                    type="button"
                    className="w-10 h-10 rounded-full border-2 transition-all cursor-pointer border-black/20"
                    title="IVORY"
                    style={{ backgroundColor: "rgb(245, 245, 220)" }}
                  ></button>
                  <button
                    type="button"
                    className="w-10 h-10 rounded-full border-2 transition-all cursor-pointer border-black/20"
                    title="BEIGE"
                    style={{ backgroundColor: "rgb(212, 197, 185)" }}
                  ></button>
                  <button
                    type="button"
                    className="w-10 h-10 rounded-full border-2 transition-all cursor-pointer border-black/20"
                    title="GREY"
                    style={{ backgroundColor: "rgb(128, 128, 128)" }}
                  ></button>
                  <button
                    type="button"
                    className="w-10 h-10 rounded-full border-2 transition-all cursor-pointer border-black/20"
                    title="NAVY"
                    style={{ backgroundColor: "rgb(26, 26, 46)" }}
                  ></button>
                  <button
                    type="button"
                    className="w-10 h-10 rounded-full border-2 transition-all cursor-pointer border-black/20"
                    title="BROWN"
                    style={{ backgroundColor: "rgb(139, 69, 19)" }}
                  ></button>
                </div>
              </div>
              <div className="max-w-xs">
                <label
                  className="block text-xs tracking-widest mb-3 text-black/80"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  CUSTOM COLOR
                </label>
                <div className="flex items-center gap-4">
                  <input
                    className="w-16 h-12 border border-black/20 cursor-pointer"
                    type="color"
                    value="#000000"
                  />
                  <input
                    className="flex-1 px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black transition-colors uppercase"
                    type="text"
                    value="#000000"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  />
                </div>
              </div>
            </div>
          </section>

          {/* --- Date / Time Picker --- */}
          <section>
            <h2
              className="text-2xl text-black mb-8 tracking-tight"
              style={{ fontFamily: "Didot, serif" }}
            >
              Date / Time Picker
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
              <div>
                <label
                  className="block text-xs tracking-widest mb-2 text-black/80"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  DATE
                </label>
                <input
                  className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black transition-colors cursor-pointer"
                  type="date"
                  value="2024-03-15"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                />
              </div>
              <div>
                <label
                  className="block text-xs tracking-widest mb-2 text-black/80"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  TIME
                </label>
                <input
                  className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black transition-colors cursor-pointer"
                  type="time"
                  value="14:30"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                />
              </div>
              <div>
                <label
                  className="block text-xs tracking-widest mb-2 text-black/80"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  DATETIME
                </label>
                <input
                  className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black transition-colors cursor-pointer"
                  type="datetime-local"
                  value="2024-03-15T14:30"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                />
              </div>
            </div>
          </section>

          {/* --- Page Control --- */}
          <section>
            <h2
              className="text-2xl text-black mb-8 tracking-tight"
              style={{ fontFamily: "Didot, serif" }}
            >
              Page Control
            </h2>
            <div className="flex items-center justify-center gap-2">
              <button
                type="button"
                disabled
                className="w-10 h-10 flex items-center justify-center border border-black/20 hover:bg-[#f5f5f5] transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <div className="w-4 h-4 flex items-center justify-center">
                  <i className="ri-arrow-left-s-line text-base"></i>
                </div>
              </button>
              <button
                type="button"
                className="w-10 h-10 flex items-center justify-center text-sm transition-colors cursor-pointer bg-black text-white"
                style={{ fontFamily: "acumin-pro, sans-serif" }}
              >
                1
              </button>
              <button
                type="button"
                className="w-10 h-10 flex items-center justify-center text-sm transition-colors cursor-pointer border border-black/20 hover:bg-[#f5f5f5]"
                style={{ fontFamily: "acumin-pro, sans-serif" }}
              >
                2
              </button>
              <button
                type="button"
                className="w-10 h-10 flex items-center justify-center text-sm transition-colors cursor-pointer border border-black/20 hover:bg-[#f5f5f5]"
                style={{ fontFamily: "acumin-pro, sans-serif" }}
              >
                3
              </button>
              <button
                type="button"
                className="w-10 h-10 flex items-center justify-center text-sm transition-colors cursor-pointer border border-black/20 hover:bg-[#f5f5f5]"
                style={{ fontFamily: "acumin-pro, sans-serif" }}
              >
                4
              </button>
              <button
                type="button"
                className="w-10 h-10 flex items-center justify-center text-sm transition-colors cursor-pointer border border-black/20 hover:bg-[#f5f5f5]"
                style={{ fontFamily: "acumin-pro, sans-serif" }}
              >
                5
              </button>
              <button
                type="button"
                className="w-10 h-10 flex items-center justify-center border border-black/20 hover:bg-[#f5f5f5] transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <div className="w-4 h-4 flex items-center justify-center">
                  <i className="ri-arrow-right-s-line text-base"></i>
                </div>
              </button>
            </div>
          </section>

          {/* --- Bottom Navigation --- */}
          <section>
            <h2
              className="text-2xl text-black mb-8 tracking-tight"
              style={{ fontFamily: "Didot, serif" }}
            >
              Bottom Navigation
            </h2>
            <div className="max-w-md mx-auto">
              <div className="bg-white border border-black/20 shadow-lg">
                <div className="flex items-center justify-around py-3">
                  <button
                    type="button"
                    className="flex flex-col items-center gap-1 cursor-pointer group"
                  >
                    <div className="w-6 h-6 flex items-center justify-center">
                      <i className="ri-home-line text-2xl transition-colors text-black/40 group-hover:text-black/60"></i>
                    </div>
                    <span
                      className="text-[10px] tracking-wider transition-colors text-black/40 group-hover:text-black/60"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      HOME
                    </span>
                  </button>
                  <button
                    type="button"
                    className="flex flex-col items-center gap-1 cursor-pointer group"
                  >
                    <div className="w-6 h-6 flex items-center justify-center">
                      <i className="ri-search-line text-2xl transition-colors text-black/40 group-hover:text-black/60"></i>
                    </div>
                    <span
                      className="text-[10px] tracking-wider transition-colors text-black/40 group-hover:text-black/60"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      SEARCH
                    </span>
                  </button>
                  <button
                    type="button"
                    className="flex flex-col items-center gap-1 cursor-pointer group"
                  >
                    <div className="w-6 h-6 flex items-center justify-center">
                      <i className="ri-heart-line text-2xl transition-colors text-black/40 group-hover:text-black/60"></i>
                    </div>
                    <span
                      className="text-[10px] tracking-wider transition-colors text-black/40 group-hover:text-black/60"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      WISHLIST
                    </span>
                  </button>
                  <button
                    type="button"
                    className="flex flex-col items-center gap-1 cursor-pointer group"
                  >
                    <div className="w-6 h-6 flex items-center justify-center">
                      <i className="ri-user-line text-2xl transition-colors text-black"></i>
                    </div>
                    <span
                      className="text-[10px] tracking-wider transition-colors text-black"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      ACCOUNT
                    </span>
                  </button>
                </div>
              </div>
            </div>
          </section>

          {/* --- Tab / Segment Control --- */}
          <section>
            <h2
              className="text-2xl text-black mb-8 tracking-tight"
              style={{ fontFamily: "Didot, serif" }}
            >
              Tab / Segment Control
            </h2>
            <div className="space-y-12">
              <div>
                <label
                  className="block text-xs tracking-widest mb-4 text-black/80"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  STANDARD TABS
                </label>
                <div className="flex items-center gap-8 border-b border-black/20">
                  <button
                    type="button"
                    className="pb-4 text-sm tracking-widest transition-colors cursor-pointer relative text-black"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    ALL
                    <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-black"></span>
                  </button>
                  <button
                    type="button"
                    className="pb-4 text-sm tracking-widest transition-colors cursor-pointer relative text-black/40 hover:text-black/60"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    NEW
                  </button>
                  <button
                    type="button"
                    className="pb-4 text-sm tracking-widest transition-colors cursor-pointer relative text-black/40 hover:text-black/60"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    SALE
                  </button>
                </div>
              </div>
              <div>
                <label
                  className="block text-xs tracking-widest mb-4 text-black/80"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  SEGMENT CONTROL
                </label>
                <div className="inline-flex items-center bg-[#f5f5f5] p-1 rounded-full">
                  <button
                    type="button"
                    className="px-6 py-2 text-xs tracking-widest transition-all cursor-pointer rounded-full whitespace-nowrap bg-black text-white"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    TOPS
                  </button>
                  <button
                    type="button"
                    className="px-6 py-2 text-xs tracking-widest transition-all cursor-pointer rounded-full whitespace-nowrap text-black/60 hover:text-black"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    BOTTOMS
                  </button>
                  <button
                    type="button"
                    className="px-6 py-2 text-xs tracking-widest transition-all cursor-pointer rounded-full whitespace-nowrap text-black/60 hover:text-black"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    OUTERWEAR
                  </button>
                  <button
                    type="button"
                    className="px-6 py-2 text-xs tracking-widest transition-all cursor-pointer rounded-full whitespace-nowrap text-black/60 hover:text-black"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    ACCESSORIES
                  </button>
                </div>
              </div>
            </div>
          </section>

          {/* --- Search Field --- */}
          <section>
            <h2
              className="text-2xl text-black mb-8 tracking-tight"
              style={{ fontFamily: "Didot, serif" }}
            >
              Search Field
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              <div>
                <label
                  className="block text-xs tracking-widest mb-2 text-black/80"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  STANDARD
                </label>
                <div className="relative">
                  <div className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 flex items-center justify-center">
                    <i className="ri-search-line text-base text-black/60"></i>
                  </div>
                  <input
                    placeholder="商品を検索"
                    className="w-full pl-12 pr-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black transition-colors"
                    type="search"
                    value=""
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  />
                </div>
              </div>
              <div>
                <label
                  className="block text-xs tracking-widest mb-2 text-black/80"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  WITH CLEAR BUTTON
                </label>
                <div className="relative">
                  <div className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 flex items-center justify-center">
                    <i className="ri-search-line text-base text-black/60"></i>
                  </div>
                  <input
                    placeholder="商品を検索"
                    className="w-full pl-12 pr-12 py-3 border border-black/20 text-sm focus:outline-none focus:border-black transition-colors"
                    type="search"
                    value=""
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  />
                </div>
              </div>
            </div>
          </section>

          {/* --- Dialog --- */}
          <section>
            <h2
              className="text-2xl text-black mb-8 tracking-tight"
              style={{ fontFamily: "Didot, serif" }}
            >
              Dialog
            </h2>
            <button
              type="button"
              className="px-8 py-3 bg-black text-white text-sm tracking-widest hover:bg-[#474747] transition-all duration-300 cursor-pointer whitespace-nowrap"
              style={{ fontFamily: "acumin-pro, sans-serif" }}
            >
              OPEN DIALOG
            </button>
          </section>

          {/* --- Sheet --- */}
          <section>
            <h2
              className="text-2xl text-black mb-8 tracking-tight"
              style={{ fontFamily: "Didot, serif" }}
            >
              Sheet
            </h2>
            <div className="flex items-center gap-4">
              <button
                type="button"
                className="px-8 py-3 bg-black text-white text-sm tracking-widest hover:bg-[#474747] transition-all duration-300 cursor-pointer whitespace-nowrap"
                style={{ fontFamily: "acumin-pro, sans-serif" }}
              >
                MEDIUM SHEET
              </button>
              <button
                type="button"
                className="px-8 py-3 border border-black text-black text-sm tracking-widest hover:bg-black hover:text-white transition-all duration-300 cursor-pointer whitespace-nowrap"
                style={{ fontFamily: "acumin-pro, sans-serif" }}
              >
                LARGE SHEET
              </button>
            </div>
          </section>

          {/* --- Action Sheet --- */}
          <section>
            <h2
              className="text-2xl text-black mb-8 tracking-tight"
              style={{ fontFamily: "Didot, serif" }}
            >
              Action Sheet
            </h2>
            <button
              type="button"
              className="px-8 py-3 bg-black text-white text-sm tracking-widest hover:bg-[#474747] transition-all duration-300 cursor-pointer whitespace-nowrap"
              style={{ fontFamily: "acumin-pro, sans-serif" }}
            >
              OPEN ACTION SHEET
            </button>
          </section>

          {/* --- Dropdown --- */}
          <section>
            <h2
              className="text-2xl text-black mb-8 tracking-tight"
              style={{ fontFamily: "Didot, serif" }}
            >
              Dropdown
            </h2>
            <div className="relative inline-block">
              <button
                type="button"
                className="px-8 py-3 border border-black text-black text-sm tracking-widest hover:bg-black hover:text-white transition-all duration-300 cursor-pointer whitespace-nowrap flex items-center gap-2"
                style={{ fontFamily: "acumin-pro, sans-serif" }}
              >
                MENU
                <div className="w-4 h-4 flex items-center justify-center">
                  <i className="ri-arrow-down-s-line text-base"></i>
                </div>
              </button>
            </div>
          </section>

          {/* --- Drawer --- */}
          <section>
            <h2
              className="text-2xl text-black mb-8 tracking-tight"
              style={{ fontFamily: "Didot, serif" }}
            >
              Drawer
            </h2>
            <button
              type="button"
              className="px-8 py-3 bg-black text-white text-sm tracking-widest hover:bg-[#474747] transition-all duration-300 cursor-pointer whitespace-nowrap"
              style={{ fontFamily: "acumin-pro, sans-serif" }}
            >
              OPEN DRAWER
            </button>
          </section>

          {/* --- Toast / Snackbar --- */}
          <section>
            <h2
              className="text-2xl text-black mb-8 tracking-tight"
              style={{ fontFamily: "Didot, serif" }}
            >
              Toast / Snackbar
            </h2>
            <div className="flex items-center gap-4 flex-wrap">
              <button
                type="button"
                className="px-8 py-3 bg-black text-white text-sm tracking-widest hover:bg-[#474747] transition-all duration-300 cursor-pointer whitespace-nowrap"
                style={{ fontFamily: "acumin-pro, sans-serif" }}
              >
                SUCCESS
              </button>
              <button
                type="button"
                className="px-8 py-3 border border-black text-black text-sm tracking-widest hover:bg-black hover:text-white transition-all duration-300 cursor-pointer whitespace-nowrap"
                style={{ fontFamily: "acumin-pro, sans-serif" }}
              >
                ERROR
              </button>
              <button
                type="button"
                className="px-8 py-3 border border-black text-black text-sm tracking-widest hover:bg-black hover:text-white transition-all duration-300 cursor-pointer whitespace-nowrap"
                style={{ fontFamily: "acumin-pro, sans-serif" }}
              >
                INFO
              </button>
            </div>
            <div className="fixed bottom-8 right-8 z-50 space-y-3"></div>
          </section>

          {/* --- Tooltip --- */}
          <section>
            <h2
              className="text-2xl text-black mb-8 tracking-tight"
              style={{ fontFamily: "Didot, serif" }}
            >
              Tooltip
            </h2>
            <div className="flex items-center gap-8">
              <div className="relative">
                <button
                  type="button"
                  className="px-8 py-3 bg-black text-white text-sm tracking-widest hover:bg-[#474747] transition-all duration-300 cursor-pointer whitespace-nowrap"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  HOVER ME
                </button>
              </div>
              <div className="relative">
                <button
                  type="button"
                  className="w-10 h-10 flex items-center justify-center border border-black/20 hover:bg-[#f5f5f5] transition-colors cursor-pointer"
                >
                  <div className="w-5 h-5 flex items-center justify-center">
                    <i className="ri-information-line text-xl"></i>
                  </div>
                </button>
              </div>
            </div>
          </section>

          {/* --- Float Button --- */}
          <section>
            <h2
              className="text-2xl text-black mb-8 tracking-tight"
              style={{ fontFamily: "Didot, serif" }}
            >
              Float Button
            </h2>
            <div className="relative h-64 bg-[#f5f5f5] flex items-center justify-center">
              <p
                className="text-sm text-black/60"
                style={{ fontFamily: "acumin-pro, sans-serif" }}
              >
                右下のフローティングボタンをクリック
              </p>
              <div className="absolute bottom-6 right-6">
                <button
                  type="button"
                  className="w-14 h-14 bg-black text-white shadow-2xl flex items-center justify-center hover:bg-[#474747] transition-all cursor-pointer"
                >
                  <div className="w-6 h-6 flex items-center justify-center">
                    <i className="ri-add-line text-2xl transition-transform"></i>
                  </div>
                </button>
              </div>
            </div>
          </section>

          {/* --- Table --- */}
          <section>
            <h2
              className="text-2xl text-black mb-8 tracking-tight"
              style={{ fontFamily: "Didot, serif" }}
            >
              Table
            </h2>
            <div className="overflow-x-auto border border-black/20">
              <table className="w-full">
                <thead className="bg-[#f5f5f5]">
                  <tr>
                    <th
                      className="px-6 py-4 text-left text-xs tracking-widest text-black/80"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      ORDER ID
                    </th>
                    <th
                      className="px-6 py-4 text-left text-xs tracking-widest text-black/80"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      DATE
                    </th>
                    <th
                      className="px-6 py-4 text-left text-xs tracking-widest text-black/80"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      PRODUCT
                    </th>
                    <th
                      className="px-6 py-4 text-left text-xs tracking-widest text-black/80"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      QTY
                    </th>
                    <th
                      className="px-6 py-4 text-left text-xs tracking-widest text-black/80"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      TOTAL
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-black/10 hover:bg-[#f5f5f5] transition-colors">
                    <td
                      className="px-6 py-4 text-sm text-black"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      ORD-001
                    </td>
                    <td
                      className="px-6 py-4 text-sm text-black/60"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      2024-03-15
                    </td>
                    <td
                      className="px-6 py-4 text-sm text-black"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      Minimal Cotton Shirt
                    </td>
                    <td
                      className="px-6 py-4 text-sm text-black/60"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      1
                    </td>
                    <td
                      className="px-6 py-4 text-sm text-black"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      ¥18,000
                    </td>
                  </tr>
                  <tr className="border-b border-black/10 hover:bg-[#f5f5f5] transition-colors">
                    <td
                      className="px-6 py-4 text-sm text-black"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      ORD-002
                    </td>
                    <td
                      className="px-6 py-4 text-sm text-black/60"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      2024-03-14
                    </td>
                    <td
                      className="px-6 py-4 text-sm text-black"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      Pleated Skirt
                    </td>
                    <td
                      className="px-6 py-4 text-sm text-black/60"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      2
                    </td>
                    <td
                      className="px-6 py-4 text-sm text-black"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      ¥32,000
                    </td>
                  </tr>
                  <tr className="border-b border-black/10 hover:bg-[#f5f5f5] transition-colors">
                    <td
                      className="px-6 py-4 text-sm text-black"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      ORD-003
                    </td>
                    <td
                      className="px-6 py-4 text-sm text-black/60"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      2024-03-13
                    </td>
                    <td
                      className="px-6 py-4 text-sm text-black"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      Cashmere Blend Coat
                    </td>
                    <td
                      className="px-6 py-4 text-sm text-black/60"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      1
                    </td>
                    <td
                      className="px-6 py-4 text-sm text-black"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      ¥68,000
                    </td>
                  </tr>
                  <tr className="hover:bg-[#f5f5f5] transition-colors">
                    <td
                      className="px-6 py-4 text-sm text-black"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      ORD-004
                    </td>
                    <td
                      className="px-6 py-4 text-sm text-black/60"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      2024-03-12
                    </td>
                    <td
                      className="px-6 py-4 text-sm text-black"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      Leather Tote Bag
                    </td>
                    <td
                      className="px-6 py-4 text-sm text-black/60"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      1
                    </td>
                    <td
                      className="px-6 py-4 text-sm text-black"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      ¥24,000
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          {/* --- List --- */}
          <section>
            <h2
              className="text-2xl text-black mb-8 tracking-tight"
              style={{ fontFamily: "Didot, serif" }}
            >
              List
            </h2>
            <div className="max-w-2xl space-y-px border border-black/20">
              <div className="flex items-center justify-between px-6 py-5 hover:bg-[#f5f5f5] transition-colors cursor-pointer border-b border-black/10">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-[#f5f5f5] flex items-center justify-center">
                    <div className="w-5 h-5 flex items-center justify-center">
                      <i className="ri-image-line text-xl text-black/40"></i>
                    </div>
                  </div>
                  <div>
                    <p
                      className="text-sm text-black mb-1"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      Minimal Cotton Shirt
                    </p>
                    <p
                      className="text-xs text-black/40 tracking-wider"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      TOPS
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <span
                    className="text-sm text-black"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    ¥18,000
                  </span>
                  <div className="w-5 h-5 flex items-center justify-center">
                    <i className="ri-arrow-right-s-line text-xl text-black/40"></i>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between px-6 py-5 hover:bg-[#f5f5f5] transition-colors cursor-pointer border-b border-black/10">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-[#f5f5f5] flex items-center justify-center">
                    <div className="w-5 h-5 flex items-center justify-center">
                      <i className="ri-image-line text-xl text-black/40"></i>
                    </div>
                  </div>
                  <div>
                    <p
                      className="text-sm text-black mb-1"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      Pleated Skirt
                    </p>
                    <p
                      className="text-xs text-black/40 tracking-wider"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      BOTTOMS
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <span
                    className="text-sm text-black"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    ¥16,000
                  </span>
                  <div className="w-5 h-5 flex items-center justify-center">
                    <i className="ri-arrow-right-s-line text-xl text-black/40"></i>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between px-6 py-5 hover:bg-[#f5f5f5] transition-colors cursor-pointer border-b border-black/10">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-[#f5f5f5] flex items-center justify-center">
                    <div className="w-5 h-5 flex items-center justify-center">
                      <i className="ri-image-line text-xl text-black/40"></i>
                    </div>
                  </div>
                  <div>
                    <p
                      className="text-sm text-black mb-1"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      Cashmere Blend Coat
                    </p>
                    <p
                      className="text-xs text-black/40 tracking-wider"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      OUTERWEAR
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <span
                    className="text-sm text-black"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    ¥68,000
                  </span>
                  <div className="w-5 h-5 flex items-center justify-center">
                    <i className="ri-arrow-right-s-line text-xl text-black/40"></i>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between px-6 py-5 hover:bg-[#f5f5f5] transition-colors ">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-[#f5f5f5] flex items-center justify-center">
                    <div className="w-5 h-5 flex items-center justify-center">
                      <i className="ri-image-line text-xl text-black/40"></i>
                    </div>
                  </div>
                  <div>
                    <p
                      className="text-sm text-black mb-1"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      Leather Tote Bag
                    </p>
                    <p
                      className="text-xs text-black/40 tracking-wider"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      ACCESSORIES
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <span
                    className="text-sm text-black"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    ¥24,000
                  </span>
                  <div className="w-5 h-5 flex items-center justify-center">
                    <i className="ri-arrow-right-s-line text-xl text-black/40"></i>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* --- Accordion --- */}
          <section>
            <h2
              className="text-2xl text-black mb-8 tracking-tight"
              style={{ fontFamily: "Didot, serif" }}
            >
              Accordion
            </h2>
            <div className="max-w-2xl border border-black/20">
              <div className="border-b border-black/10">
                <button
                  type="button"
                  className="w-full px-6 py-5 flex items-center justify-between hover:bg-[#f5f5f5] transition-colors cursor-pointer text-left"
                >
                  <span
                    className="text-sm text-black tracking-wide"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    配送について
                  </span>
                  <div className="w-5 h-5 flex items-center justify-center">
                    <i className="ri-arrow-up-s-line text-xl transition-transform"></i>
                  </div>
                </button>
                <div className="px-6 pb-5">
                  <p
                    className="text-sm text-black/60 leading-relaxed"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    国内配送は通常3-5営業日でお届けします。送料は全国一律¥500、¥10,000以上のご購入で送料無料となります。
                  </p>
                </div>
              </div>
              <div className="border-b border-black/10">
                <button
                  type="button"
                  className="w-full px-6 py-5 flex items-center justify-between hover:bg-[#f5f5f5] transition-colors cursor-pointer text-left"
                >
                  <span
                    className="text-sm text-black tracking-wide"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    返品・交換について
                  </span>
                  <div className="w-5 h-5 flex items-center justify-center">
                    <i className="ri-arrow-down-s-line text-xl transition-transform"></i>
                  </div>
                </button>
              </div>
              <div className="">
                <button
                  type="button"
                  className="w-full px-6 py-5 flex items-center justify-between hover:bg-[#f5f5f5] transition-colors cursor-pointer text-left"
                >
                  <span
                    className="text-sm text-black tracking-wide"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    サイズガイド
                  </span>
                  <div className="w-5 h-5 flex items-center justify-center">
                    <i className="ri-arrow-down-s-line text-xl transition-transform"></i>
                  </div>
                </button>
              </div>
            </div>
          </section>

          {/* --- Card --- */}
          <section>
            <h2
              className="text-2xl text-black mb-8 tracking-tight"
              style={{ fontFamily: "Didot, serif" }}
            >
              Card
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
              <div className="group cursor-pointer">
                <div className="relative aspect-[4/5] bg-[#f5f5f5] mb-4 overflow-hidden">
                  <Image
                    alt="Minimal Cotton Shirt"
                    className="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-500"
                    src="https://readdy.ai/api/search-image?query=minimalist%20elegant%20white%20cotton%20shirt%20on%20clean%20white%20background%20professional%20product%20photography%20soft%20natural%20lighting%20high%20end%20fashion%20simple%20composition%20luxury%20fabric%20texture%20studio%20shot&width=400&height=500&seq=card1&orientation=portrait"
                    width={400}
                    height={500}
                    priority={false}
                  />
                  <button
                    type="button"
                    className="absolute top-4 right-4 w-10 h-10 bg-white/90 flex items-center justify-center hover:bg-white transition-colors"
                  >
                    <div className="w-5 h-5 flex items-center justify-center">
                      <i className="ri-heart-line text-xl"></i>
                    </div>
                  </button>
                </div>
                <div>
                  <p
                    className="text-xs tracking-widest text-black/40 mb-2"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    TOPS
                  </p>
                  <h3
                    className="text-sm text-black mb-2"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    Minimal Cotton Shirt
                  </h3>
                  <p
                    className="text-sm text-black"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    ¥18,000
                  </p>
                </div>
              </div>

              <div className="group cursor-pointer">
                <div className="relative aspect-[4/5] bg-[#f5f5f5] mb-4 overflow-hidden">
                  <Image
                    alt="Pleated Skirt"
                    className="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-500"
                    src="https://readdy.ai/api/search-image?query=elegant%20beige%20pleated%20midi%20skirt%20on%20clean%20white%20background%20professional%20product%20photography%20soft%20natural%20lighting%20high%20end%20fashion%20simple%20composition%20luxury%20fabric%20texture%20studio%20shot&width=400&height=500&seq=card2&orientation=portrait"
                    width={400}
                    height={500}
                    priority={false}
                  />
                  <button
                    type="button"
                    className="absolute top-4 right-4 w-10 h-10 bg-white/90 flex items-center justify-center hover:bg-white transition-colors"
                  >
                    <div className="w-5 h-5 flex items-center justify-center">
                      <i className="ri-heart-line text-xl"></i>
                    </div>
                  </button>
                </div>
                <div>
                  <p
                    className="text-xs tracking-widest text-black/40 mb-2"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    BOTTOMS
                  </p>
                  <h3
                    className="text-sm text-black mb-2"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    Pleated Skirt
                  </h3>
                  <p
                    className="text-sm text-black"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    ¥16,000
                  </p>
                </div>
              </div>

              <div className="group cursor-pointer">
                <div className="relative aspect-[4/5] bg-[#f5f5f5] mb-4 overflow-hidden">
                  <Image
                    alt="Cashmere Blend Coat"
                    className="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-500"
                    src="https://readdy.ai/api/search-image?query=luxurious%20camel%20cashmere%20wool%20coat%20on%20clean%20white%20background%20professional%20product%20photography%20soft%20natural%20lighting%20high%20end%20fashion%20simple%20composition%20premium%20fabric%20texture%20studio%20shot&width=400&height=500&seq=card3&orientation=portrait"
                    width={400}
                    height={500}
                    priority={false}
                  />
                  <button
                    type="button"
                    className="absolute top-4 right-4 w-10 h-10 bg-white/90 flex items-center justify-center hover:bg-white transition-colors"
                  >
                    <div className="w-5 h-5 flex items-center justify-center">
                      <i className="ri-heart-line text-xl"></i>
                    </div>
                  </button>
                </div>
                <div>
                  <p
                    className="text-xs tracking-widest text-black/40 mb-2"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    OUTERWEAR
                  </p>
                  <h3
                    className="text-sm text-black mb-2"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    Cashmere Blend Coat
                  </h3>
                  <p
                    className="text-sm text-black"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    ¥68,000
                  </p>
                </div>
              </div>
            </div>
          </section>

          {/* --- Carousel --- */}
          <section>
            <h2
              className="text-2xl text-black mb-8 tracking-tight"
              style={{ fontFamily: "Didot, serif" }}
            >
              Carousel
            </h2>
            <div className="relative max-w-4xl mx-auto">
              <div className="relative aspect-[16/10] bg-[#f5f5f5] overflow-hidden">
                <Image
                  alt="Slide 1"
                  className="w-full h-full object-cover object-top"
                  src="https://readdy.ai/api/search-image?query=minimalist%20elegant%20fashion%20collection%20display%20clean%20white%20background%20soft%20natural%20lighting%20high%20end%20luxury%20clothing%20simple%20composition%20professional%20photography%20modern%20aesthetic%20premium%20fabric%20textures&width=800&height=500&seq=carousel1&orientation=landscape"
                  width={800}
                  height={500}
                  priority={false}
                />
                <button
                  type="button"
                  className="absolute left-4 top-1/2 -translate-y-1/2 w-12 h-12 bg-white/90 hover:bg-white flex items-center justify-center transition-colors cursor-pointer"
                >
                  <div className="w-6 h-6 flex items-center justify-center">
                    <i className="ri-arrow-left-s-line text-2xl"></i>
                  </div>
                </button>
                <button
                  type="button"
                  className="absolute right-4 top-1/2 -translate-y-1/2 w-12 h-12 bg-white/90 hover:bg-white flex items-center justify-center transition-colors cursor-pointer"
                >
                  <div className="w-6 h-6 flex items-center justify-center">
                    <i className="ri-arrow-right-s-line text-2xl"></i>
                  </div>
                </button>
                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2">
                  <button type="button" className="w-2 h-2 rounded-full transition-all cursor-pointer bg-white w-6"></button>
                  <button type="button" className="w-2 h-2 rounded-full transition-all cursor-pointer bg-white/50"></button>
                  <button type="button" className="w-2 h-2 rounded-full transition-all cursor-pointer bg-white/50"></button>
                </div>
              </div>
            </div>
          </section>

          {/* --- Map --- */}
          <section>
            <h2
              className="text-2xl text-black mb-8 tracking-tight"
              style={{ fontFamily: "Didot, serif" }}
            >
              Map
            </h2>
            <div className="aspect-video bg-[#f5f5f5] border border-black/20">
              <iframe
                src="https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3240.8280108514437!2d139.7671248!3d35.6812362!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x60188bfbd89f700b%3A0x277c49ba34ed38!2z5p2x5Lqs6aeF!5e0!3m2!1sja!2sjp!4v1234567890123"
                width="100%"
                height="100%"
                allowFullScreen={true}
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
                style={{ border: "0px" }}
              ></iframe>
            </div>
          </section>

          {/* --- Chart --- */}
          <section>
            <h2
              className="text-2xl text-black mb-8 tracking-tight"
              style={{ fontFamily: "Didot, serif" }}
            >
              Chart
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              <div className="border border-black/20 p-6">
                <h3
                  className="text-xs tracking-widest text-black/80 mb-6"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  SALES TREND
                </h3>
                <div className="h-64 flex items-end justify-between gap-2">
                  <div className="flex-1 flex flex-col items-center gap-2">
                    <div className="w-full bg-black hover:bg-[#474747] transition-colors cursor-pointer" style={{ height: "40%" }}></div>
                    <span className="text-xs text-black/40" style={{ fontFamily: "acumin-pro, sans-serif" }}>1月</span>
                  </div>
                  <div className="flex-1 flex flex-col items-center gap-2">
                    <div className="w-full bg-black hover:bg-[#474747] transition-colors cursor-pointer" style={{ height: "65%" }}></div>
                    <span className="text-xs text-black/40" style={{ fontFamily: "acumin-pro, sans-serif" }}>2月</span>
                  </div>
                  <div className="flex-1 flex flex-col items-center gap-2">
                    <div className="w-full bg-black hover:bg-[#474747] transition-colors cursor-pointer" style={{ height: "45%" }}></div>
                    <span className="text-xs text-black/40" style={{ fontFamily: "acumin-pro, sans-serif" }}>3月</span>
                  </div>
                  <div className="flex-1 flex flex-col items-center gap-2">
                    <div className="w-full bg-black hover:bg-[#474747] transition-colors cursor-pointer" style={{ height: "80%" }}></div>
                    <span className="text-xs text-black/40" style={{ fontFamily: "acumin-pro, sans-serif" }}>4月</span>
                  </div>
                  <div className="flex-1 flex flex-col items-center gap-2">
                    <div className="w-full bg-black hover:bg-[#474747] transition-colors cursor-pointer" style={{ height: "55%" }}></div>
                    <span className="text-xs text-black/40" style={{ fontFamily: "acumin-pro, sans-serif" }}>5月</span>
                  </div>
                  <div className="flex-1 flex flex-col items-center gap-2">
                    <div className="w-full bg-black hover:bg-[#474747] transition-colors cursor-pointer" style={{ height: "90%" }}></div>
                    <span className="text-xs text-black/40" style={{ fontFamily: "acumin-pro, sans-serif" }}>6月</span>
                  </div>
                  <div className="flex-1 flex flex-col items-center gap-2">
                    <div className="w-full bg-black hover:bg-[#474747] transition-colors cursor-pointer" style={{ height: "70%" }}></div>
                    <span className="text-xs text-black/40" style={{ fontFamily: "acumin-pro, sans-serif" }}>7月</span>
                  </div>
                </div>
              </div>
              <div className="border border-black/20 p-6">
                <h3
                  className="text-xs tracking-widest text-black/80 mb-6"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  CATEGORY DISTRIBUTION
                </h3>
                <div className="h-64 flex items-center justify-center">
                  <div className="relative w-48 h-48">
                    <svg viewBox="0 0 100 100" className="transform -rotate-90">
                      <circle
                        cx="50"
                        cy="50"
                        r="40"
                        fill="none"
                        stroke="#000000"
                        stroke-width="20"
                        stroke-dasharray="75.4 251.2"
                      ></circle>
                      <circle
                        cx="50"
                        cy="50"
                        r="40"
                        fill="none"
                        stroke="#474747"
                        stroke-width="20"
                        stroke-dasharray="62.8 251.2"
                        stroke-dashoffset="-75.4"
                      ></circle>
                      <circle
                        cx="50"
                        cy="50"
                        r="40"
                        fill="none"
                        stroke="#808080"
                        stroke-width="20"
                        stroke-dasharray="50.2 251.2"
                        stroke-dashoffset="-138.2"
                      ></circle>
                      <circle
                        cx="50"
                        cy="50"
                        r="40"
                        fill="none"
                        stroke="#B0B0B0"
                        stroke-width="20"
                        stroke-dasharray="62.8 251.2"
                        stroke-dashoffset="-188.4"
                      ></circle>
                    </svg>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4 mt-6">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3" style={{ backgroundColor: "rgb(0, 0, 0)" }}></div>
                    <span
                      className="text-xs text-black/60"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      TOPS 30%
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3" style={{ backgroundColor: "rgb(71, 71, 71)" }}></div>
                    <span
                      className="text-xs text-black/60"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      BOTTOMS 25%
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3" style={{ backgroundColor: "rgb(128, 128, 128)" }}></div>
                    <span
                      className="text-xs text-black/60"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      OUTERWEAR 20%
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3" style={{ backgroundColor: "rgb(176, 176, 176)" }}></div>
                    <span
                      className="text-xs text-black/60"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      ACCESSORIES 25%
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* --- Stats --- */}
          <section>
            <h2
              className="text-2xl text-black mb-8 tracking-tight"
              style={{ fontFamily: "Didot, serif" }}
            >
              Stats
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
              <div className="border border-black/20 p-6 hover:border-black transition-colors">
                <div className="w-10 h-10 flex items-center justify-center mb-4">
                  <i className="ri-shopping-bag-line text-3xl text-black"></i>
                </div>
                <p
                  className="text-3xl text-black mb-2"
                  style={{ fontFamily: "Didot, serif" }}
                >
                  1,234
                </p>
                <p
                  className="text-xs tracking-widest text-black/60"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  TOTAL ORDERS
                </p>
              </div>
              <div className="border border-black/20 p-6 hover:border-black transition-colors">
                <div className="w-10 h-10 flex items-center justify-center mb-4">
                  <i className="ri-money-yen-circle-line text-3xl text-black"></i>
                </div>
                <p
                  className="text-3xl text-black mb-2"
                  style={{ fontFamily: "Didot, serif" }}
                >
                  ¥2,450,000
                </p>
                <p
                  className="text-xs tracking-widest text-black/60"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  REVENUE
                </p>
              </div>
              <div className="border border-black/20 p-6 hover:border-black transition-colors">
                <div className="w-10 h-10 flex items-center justify-center mb-4">
                  <i className="ri-user-line text-3xl text-black"></i>
                </div>
                <p
                  className="text-3xl text-black mb-2"
                  style={{ fontFamily: "Didot, serif" }}
                >
                  856
                </p>
                <p
                  className="text-xs tracking-widest text-black/60"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  CUSTOMERS
                </p>
              </div>
              <div className="border border-black/20 p-6 hover:border-black transition-colors">
                <div className="w-10 h-10 flex items-center justify-center mb-4">
                  <i className="ri-shirt-line text-3xl text-black"></i>
                </div>
                <p
                  className="text-3xl text-black mb-2"
                  style={{ fontFamily: "Didot, serif" }}
                >
                  142
                </p>
                <p
                  className="text-xs tracking-widest text-black/60"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  PRODUCTS
                </p>
              </div>
            </div>
          </section>

          {/* --- Banner / Alert --- */}
          <section>
            <h2
              className="text-2xl text-black mb-8 tracking-tight"
              style={{ fontFamily: "Didot, serif" }}
            >
              Banner / Alert
            </h2>
            <div className="space-y-4 max-w-4xl">
              <div className="bg-black text-white px-6 py-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-5 h-5 flex items-center justify-center">
                    <i className="ri-information-line text-xl"></i>
                  </div>
                  <p className="text-sm" style={{ fontFamily: "acumin-pro, sans-serif" }}>
                    春の新作コレクションが入荷しました
                  </p>
                </div>
                <button
                  type="button"
                  className="w-6 h-6 flex items-center justify-center hover:bg-white/20 transition-colors cursor-pointer"
                >
                  <div className="w-4 h-4 flex items-center justify-center">
                    <i className="ri-close-line text-base"></i>
                  </div>
                </button>
              </div>
              <div className="bg-[#f5f5f5] border border-black/20 px-6 py-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-5 h-5 flex items-center justify-center">
                    <i className="ri-gift-line text-xl text-black"></i>
                  </div>
                  <p className="text-sm text-black" style={{ fontFamily: "acumin-pro, sans-serif" }}>
                    ¥10,000以上のご購入で送料無料
                  </p>
                </div>
                <button
                  type="button"
                  className="w-6 h-6 flex items-center justify-center hover:bg-black/10 transition-colors cursor-pointer"
                >
                  <div className="w-4 h-4 flex items-center justify-center">
                    <i className="ri-close-line text-base text-black"></i>
                  </div>
                </button>
              </div>
              <div className="border-l-4 border-black bg-[#f5f5f5] px-6 py-4 flex items-start justify-between">
                <div className="flex items-start gap-3">
                  <div className="w-5 h-5 flex items-center justify-center mt-0.5">
                    <i className="ri-error-warning-line text-xl text-black"></i>
                  </div>
                  <div>
                    <p className="text-sm text-black mb-1" style={{ fontFamily: "acumin-pro, sans-serif" }}>
                      重要なお知らせ
                    </p>
                    <p className="text-sm text-black/60 leading-relaxed" style={{ fontFamily: "acumin-pro, sans-serif" }}>
                      システムメンテナンスのため、3月20日 2:00-4:00の間、一時的にサービスをご利用いただけません。
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  className="w-6 h-6 flex items-center justify-center hover:bg-black/10 transition-colors cursor-pointer flex-shrink-0"
                >
                  <div className="w-4 h-4 flex items-center justify-center">
                    <i className="ri-close-line text-base text-black"></i>
                  </div>
                </button>
              </div>
            </div>
          </section>

          {/* --- Avatar --- */}
          <section>
            <h2
              className="text-2xl text-black mb-8 tracking-tight"
              style={{ fontFamily: "Didot, serif" }}
            >
              Avatar
            </h2>
            <div className="flex items-center gap-8 flex-wrap">
              <div className="flex flex-col items-center gap-3">
                <div className="w-16 h-16 rounded-full bg-black flex items-center justify-center text-white text-xl" style={{ fontFamily: "Didot, serif" }}>
                  A
                </div>
                <p
                  className="text-xs tracking-wider text-black/60"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  LARGE
                </p>
              </div>
              <div className="flex flex-col items-center gap-3">
                <div className="w-12 h-12 rounded-full bg-black flex items-center justify-center text-white text-base" style={{ fontFamily: "Didot, serif" }}>
                  B
                </div>
                <p
                  className="text-xs tracking-wider text-black/60"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  MEDIUM
                </p>
              </div>
              <div className="flex flex-col items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-black flex items-center justify-center text-white text-sm" style={{ fontFamily: "Didot, serif" }}>
                  C
                </div>
                <p
                  className="text-xs tracking-wider text-black/60"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  SMALL
                </p>
              </div>
              <div className="flex flex-col items-center gap-3">
                <div className="w-12 h-12 rounded-full overflow-hidden bg-[#f5f5f5]">
                    <Image
                      alt="Avatar"
                      className="w-full h-full object-cover"
                      src="https://readdy.ai/api/search-image?query=professional%20elegant%20portrait%20photo%20clean%20white%20background%20soft%20natural%20lighting%20minimalist%20aesthetic%20high%20quality%20studio%20photography&width=100&height=100&seq=avatar1&orientation=squarish"
                      width={100}
                      height={100}
                      priority={false}
                    />
                  </div>
                <p
                  className="text-xs tracking-wider text-black/60"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  WITH IMAGE
                </p>
              </div>
              <div className="flex flex-col items-center gap-3">
                <div className="w-12 h-12 rounded-full bg-black flex items-center justify-center relative">
                  <div className="w-5 h-5 flex items-center justify-center">
                    <i className="ri-user-line text-xl text-white"></i>
                  </div>
                  <div className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 rounded-full border-2 border-white"></div>
                </div>
                <p
                  className="text-xs tracking-wider text-black/60"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  WITH STATUS
                </p>
              </div>
            </div>
          </section>

          {/* --- Toolbar --- */}
          <section>
            <h2
              className="text-2xl text-black mb-8 tracking-tight"
              style={{ fontFamily: "Didot, serif" }}
            >
              Toolbar
            </h2>
            <div className="space-y-6">
              <div className="border border-black/20 p-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="w-10 h-10 flex items-center justify-center hover:bg-[#f5f5f5] transition-colors cursor-pointer"
                  >
                    <div className="w-5 h-5 flex items-center justify-center">
                      <i className="ri-bold text-xl"></i>
                    </div>
                  </button>
                  <button
                    type="button"
                    className="w-10 h-10 flex items-center justify-center hover:bg-[#f5f5f5] transition-colors cursor-pointer"
                  >
                    <div className="w-5 h-5 flex items-center justify-center">
                      <i className="ri-italic text-xl"></i>
                    </div>
                  </button>
                  <button
                    type="button"
                    className="w-10 h-10 flex items-center justify-center hover:bg-[#f5f5f5] transition-colors cursor-pointer"
                  >
                    <div className="w-5 h-5 flex items-center justify-center">
                      <i className="ri-underline text-xl"></i>
                    </div>
                  </button>
                  <div className="w-px h-6 bg-black/20 mx-2"></div>
                  <button
                    type="button"
                    className="w-10 h-10 flex items-center justify-center hover:bg-[#f5f5f5] transition-colors cursor-pointer"
                  >
                    <div className="w-5 h-5 flex items-center justify-center">
                      <i className="ri-align-left text-xl"></i>
                    </div>
                  </button>
                  <button
                    type="button"
                    className="w-10 h-10 flex items-center justify-center hover:bg-[#f5f5f5] transition-colors cursor-pointer"
                  >
                    <div className="w-5 h-5 flex items-center justify-center">
                      <i className="ri-align-center text-xl"></i>
                    </div>
                  </button>
                  <button
                    type="button"
                    className="w-10 h-10 flex items-center justify-center hover:bg-[#f5f5f5] transition-colors cursor-pointer"
                  >
                    <div className="w-5 h-5 flex items-center justify-center">
                      <i className="ri-align-right text-xl"></i>
                    </div>
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="w-10 h-10 flex items-center justify-center hover:bg-[#f5f5f5] transition-colors cursor-pointer"
                  >
                    <div className="w-5 h-5 flex items-center justify-center">
                      <i className="ri-link text-xl"></i>
                    </div>
                  </button>
                  <button
                    type="button"
                    className="w-10 h-10 flex items-center justify-center hover:bg-[#f5f5f5] transition-colors cursor-pointer"
                  >
                    <div className="w-5 h-5 flex items-center justify-center">
                      <i className="ri-image-line text-xl"></i>
                    </div>
                  </button>
                </div>
              </div>
              <div className="bg-[#f5f5f5] border border-black/20 p-4 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <button
                    type="button"
                    className="flex items-center gap-2 px-4 py-2 hover:bg-white/50 transition-colors cursor-pointer"
                  >
                    <div className="w-5 h-5 flex items-center justify-center">
                      <i className="ri-filter-line text-xl"></i>
                    </div>
                    <span className="text-sm" style={{ fontFamily: "acumin-pro, sans-serif" }}>
                      フィルター
                    </span>
                  </button>
                  <button
                    type="button"
                    className="flex items-center gap-2 px-4 py-2 hover:bg-white/50 transition-colors cursor-pointer"
                  >
                    <div className="w-5 h-5 flex items-center justify-center">
                      <i className="ri-sort-desc text-xl"></i>
                    </div>
                    <span className="text-sm" style={{ fontFamily: "acumin-pro, sans-serif" }}>
                      並び替え
                    </span>
                  </button>
                </div>
                <button
                  type="button"
                  className="flex items-center gap-2 px-4 py-2 hover:bg-white/50 transition-colors cursor-pointer"
                >
                  <div className="w-5 h-5 flex items-center justify-center">
                    <i className="ri-layout-grid-line text-xl"></i>
                  </div>
                </button>
              </div>
            </div>
          </section>

          {/* --- Tag / Label --- */}
            <section>
            <h2
              className="text-2xl text-black mb-8 tracking-tight"
              style={{ fontFamily: "Didot, serif" }}
            >
              Badge
            </h2>
            <div className="flex items-center gap-12 flex-wrap">
              <div className="relative">
              <button
                type="button"
                className="w-12 h-12 flex items-center justify-center border border-black/20 hover:bg-[#f5f5f5] transition-colors cursor-pointer"
              >
                <div className="w-6 h-6 flex items-center justify-center">
                <i className="ri-notification-line text-2xl"></i>
                </div>
              </button>
              <span
                className="absolute -top-1 -right-1 w-5 h-5 bg-black text-white text-xs flex items-center justify-center rounded-full"
                style={{ fontFamily: "acumin-pro, sans-serif" }}
              >
                3
              </span>
              </div>
              <div className="relative">
              <button
                type="button"
                className="w-12 h-12 flex items-center justify-center border border-black/20 hover:bg-[#f5f5f5] transition-colors cursor-pointer"
              >
                <div className="w-6 h-6 flex items-center justify-center">
                <i className="ri-message-line text-2xl"></i>
                </div>
              </button>
              <span
                className="absolute -top-1 -right-1 w-5 h-5 bg-black text-white text-xs flex items-center justify-center rounded-full"
                style={{ fontFamily: "acumin-pro, sans-serif" }}
              >
                12
              </span>
              </div>
              <div className="relative">
              <button
                type="button"
                className="w-12 h-12 flex items-center justify-center border border-black/20 hover:bg-[#f5f5f5] transition-colors cursor-pointer"
              >
                <div className="w-6 h-6 flex items-center justify-center">
                <i className="ri-shopping-cart-line text-2xl"></i>
                </div>
              </button>
              <span className="absolute -top-1 -right-1 w-2 h-2 bg-black rounded-full"></span>
              </div>
              <div className="relative">
              <span
                className="text-sm text-black"
                style={{ fontFamily: "acumin-pro, sans-serif" }}
              >
                新着メッセージ
              </span>
              <span
                className="absolute -top-2 -right-6 px-2 py-0.5 bg-black text-white text-[10px] tracking-wider rounded-full"
                style={{ fontFamily: "acumin-pro, sans-serif" }}
              >
                NEW
              </span>
              </div>
            </div>
            </section>
        </div>
      </div>
    </main>
  );
}
