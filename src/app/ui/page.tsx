"use client";

import Image from 'next/image';
import { useState, useEffect, useRef } from "react";

export default function Page() {
  const [standardText, setStandardText] = useState("");
  const [email, setEmail] = useState("");
  const [radioValue, setRadioValue] = useState("option1");
  const [category, setCategory] = useState("TOPS");
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [mediumSheetOpen, setMediumSheetOpen] = useState(false);
  const [largeSheetOpen, setLargeSheetOpen] = useState(false);
  const [actionSheetOpen, setActionSheetOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // stack of toast notifications
  const [toasts, setToasts] = useState<{id: number; message: string; variant?: 'success' | 'error' | 'info'}[]>([]);
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const [infoTooltipVisible, setInfoTooltipVisible] = useState(false);
  const [floatMenuOpen, setFloatMenuOpen] = useState(false); 
  // banner visibility flags
  const [showInfoBanner, setShowInfoBanner] = useState(true);
  const [showPromoBanner, setShowPromoBanner] = useState(true);
  const [showAlertBanner, setShowAlertBanner] = useState(true);
  // tags that can be removed by user
  const [removableTags, setRemovableTags] = useState<string[]>(["TOPS", "BOTTOMS", "OUTERWEAR"]);
  const carouselImages = [
    "https://readdy.ai/api/search-image?query=minimalist%20elegant%20fashion%20collection%20display%20clean%20white%20background%20soft%20natural%20lighting%20high%20end%20luxury%20clothing%20simple%20composition%20professional%20photography%20modern%20aesthetic%20premium%20fabric%20textures&width=800&height=500&seq=carousel1&orientation=landscape",
    "https://readdy.ai/api/search-image?query=stylish%20model%20wearing%20luxury%20streetwear%20outfit%20on%20urban%20background%20professional%20photography%20soft%20lighting&width=800&height=500&seq=carousel2&orientation=landscape",
    "https://readdy.ai/api/search-image?query=high-end%20black%20leather%20jacket%20product%20shot%20on%20white%20background%20studio%20photography&width=800&height=500&seq=carousel3&orientation=landscape",
  ];
  const [slideIndex, setSlideIndex] = useState(0);
  const [openAccordion, setOpenAccordion] = useState<"shipping" | "returns" | "size" | null>("shipping");
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [menuOpen]);
  const categoryOptions = ["TOPS", "BOTTOMS", "OUTERWEAR", "ACCESSORIES"];

  const [sizes, setSizes] = useState(["S", "M"]);
  const [sizeOpen, setSizeOpen] = useState(false);
  const sizeOptions = ["S", "M", "L", "FREE"];
  const [notify, setNotify] = useState(false);

  // slider states
  const [singleValue, setSingleValue] = useState(50);
  // use 0–100 scale; default range corresponds to ¥0–¥10000
  const [rangeValues, setRangeValues] = useState<[number, number]>([0, 100]);
  // stepper demo value
  const [stepperValue, setStepperValue] = useState<number>(1);
  // rating demo
  const [rating, setRating] = useState<number>(3);
  // color picker states
  const presetColors = [
    { value: "#000000", swatchClass: "bg-black" },
    { value: "#F5F5DC", swatchClass: "bg-[#F5F5DC]" },
    { value: "#D4C5B9", swatchClass: "bg-[#D4C5B9]" },
    { value: "#808080", swatchClass: "bg-[#808080]" },
    { value: "#1A1A2E", swatchClass: "bg-[#1A1A2E]" },
    { value: "#8B4513", swatchClass: "bg-[#8B4513]" },
  ] as const;
  const [color, setColor] = useState<string>(presetColors[2].value); // default beige
  const [dateValue, setDateValue] = useState("2024-03-15");
  const [timeValue, setTimeValue] = useState("14:30");
  const [dateTimeValue, setDateTimeValue] = useState("2024-03-15T14:30");
  const [searchStandard, setSearchStandard] = useState("");
  const [searchWithClear, setSearchWithClear] = useState("");
  const pageNumbers = [1, 2, 3, 4, 5] as const;
  const [currentPage, setCurrentPage] = useState<number>(1);

  const bottomNavItems = [
    { key: "HOME", iconClass: "ri-home-line" },
    { key: "SEARCH", iconClass: "ri-search-line" },
    { key: "WISHLIST", iconClass: "ri-heart-line" },
    { key: "ACCOUNT", iconClass: "ri-user-line" },
  ] as const;
  const [activeBottomNav, setActiveBottomNav] = useState<(typeof bottomNavItems)[number]["key"]>("ACCOUNT");

  const standardTabs = ["ALL", "NEW", "SALE"] as const;
  const [activeStandardTab, setActiveStandardTab] = useState<(typeof standardTabs)[number]>("ALL");

  const segmentOptions = ["TOPS", "BOTTOMS", "OUTERWEAR", "ACCESSORIES"] as const;
  const [activeSegment, setActiveSegment] = useState<(typeof segmentOptions)[number]>("TOPS");

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
                  <div className="absolute left-0 top-1/2 h-1 w-full -translate-y-1/2 overflow-hidden rounded-full bg-black/20" data-testid="price-range-track">
                    <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 1" preserveAspectRatio="none" aria-hidden="true">
                      <rect
                        data-testid="price-range-fill"
                        x={rangeMin}
                        y={0}
                        width={Math.max(rangeMax - rangeMin, 0)}
                        height={1}
                        fill="currentColor"
                        className="text-black"
                      />
                    </svg>
                  </div>
                  <input
                    min="0"
                    max="100"
                    className="pointer-events-none absolute left-0 top-1/2 z-20 h-4 w-full -translate-y-1/2 appearance-none bg-transparent [accent-color:transparent] [&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:mt-[-6px] [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-black [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-track]:h-1 [&::-moz-range-track]:bg-transparent [&::-moz-range-progress]:bg-transparent [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-black [&::-moz-range-thumb]:cursor-pointer"
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
                    className="pointer-events-none absolute left-0 top-1/2 z-30 h-4 w-full -translate-y-1/2 appearance-none bg-transparent [accent-color:transparent] [&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:mt-[-6px] [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-black [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-track]:h-1 [&::-moz-range-track]:bg-transparent [&::-moz-range-progress]:bg-transparent [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-black [&::-moz-range-thumb]:cursor-pointer"
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
                  onClick={() => setStepperValue((v) => Math.max(1, v - 1))}
                >
                  <div className="w-4 h-4 flex items-center justify-center">
                    <i className="ri-subtract-line text-base"></i>
                  </div>
                </button>
                <input
                  className="flex-1 h-12 text-center text-sm focus:outline-none"
                  type="number"
                  min="1"
                  value={stepperValue}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    if (!isNaN(val)) {
                      setStepperValue(Math.max(1, val));
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setStepperValue((v) => v + 1);
                    } else if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setStepperValue((v) => Math.max(1, v - 1));
                    }
                  }}
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                />
                <button
                  type="button"
                  className="w-12 h-12 flex items-center justify-center border-l border-black/20 hover:bg-[#f5f5f5] transition-colors cursor-pointer"
                  onClick={() => setStepperValue((v) => v + 1)}
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
                  {[1, 2, 3, 4, 5].map((i) => (
                    <button
                      key={i}
                      type="button"
                      className="cursor-pointer"
                      onClick={() => setRating(i)}
                    >
                      <div className="w-6 h-6 flex items-center justify-center">
                        <i
                          className={`ri-star-${i <= rating ? "fill" : "line"} text-2xl text-black`}
                        ></i>
                      </div>
                    </button>
                  ))}
                  <span
                    className="ml-3 text-sm text-black"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    {rating} / 5
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
                  {presetColors.map((preset) => (
                    <button
                      key={preset.value}
                      type="button"
                      className={`w-10 h-10 rounded-full border-2 transition-all cursor-pointer ${preset.swatchClass} ${preset.value === color ? "border-black" : "border-black/20"}`}
                      title={preset.value}
                      onClick={() => setColor(preset.value)}
                    ></button>
                  ))}
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
                    value={color}
                    onChange={(e) => setColor(e.target.value)}
                  />
                  <input
                    className="flex-1 px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black transition-colors uppercase"
                    type="text"
                    value={color}
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (/^#[0-9A-Fa-f]{6}$/.test(v)) {
                        setColor(v);
                      }
                    }}
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
                  value={dateValue}
                  onChange={(e) => setDateValue(e.target.value)}
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
                  value={timeValue}
                  onChange={(e) => setTimeValue(e.target.value)}
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
                  value={dateTimeValue}
                  onChange={(e) => setDateTimeValue(e.target.value)}
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
                disabled={currentPage === pageNumbers[0]}
                aria-label="Previous page"
                onClick={() => setCurrentPage((prev) => Math.max(pageNumbers[0], prev - 1))}
                className="w-10 h-10 flex items-center justify-center border border-black/20 hover:bg-[#f5f5f5] transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <div className="w-4 h-4 flex items-center justify-center">
                  <i className="ri-arrow-left-s-line text-base"></i>
                </div>
              </button>
              {pageNumbers.map((pageNum) => (
                <button
                  key={pageNum}
                  type="button"
                  aria-current={currentPage === pageNum ? "page" : undefined}
                  onClick={() => setCurrentPage(pageNum)}
                  className={
                    "w-10 h-10 flex items-center justify-center text-sm transition-colors cursor-pointer " +
                    (currentPage === pageNum
                      ? "bg-black text-white"
                      : "border border-black/20 hover:bg-[#f5f5f5]")
                  }
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  {pageNum}
                </button>
              ))}
              <button
                type="button"
                disabled={currentPage === pageNumbers[pageNumbers.length - 1]}
                aria-label="Next page"
                onClick={() =>
                  setCurrentPage((prev) =>
                    Math.min(pageNumbers[pageNumbers.length - 1], prev + 1)
                  )
                }
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
                  {bottomNavItems.map((item) => {
                    const isActive = activeBottomNav === item.key;

                    return (
                      <button
                        key={item.key}
                        type="button"
                        aria-current={isActive ? "page" : undefined}
                        className="flex flex-col items-center gap-1 cursor-pointer group"
                        onClick={() => setActiveBottomNav(item.key)}
                      >
                        <div className="w-6 h-6 flex items-center justify-center">
                          <i
                            className={`${item.iconClass} text-2xl transition-colors ${isActive ? "text-black" : "text-black/40 group-hover:text-black/60"}`}
                          ></i>
                        </div>
                        <span
                          className={`text-[10px] tracking-wider transition-colors ${isActive ? "text-black" : "text-black/40 group-hover:text-black/60"}`}
                          style={{ fontFamily: "acumin-pro, sans-serif" }}
                        >
                          {item.key}
                        </span>
                      </button>
                    );
                  })}
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
                <div className="flex items-center gap-8 border-b border-black/20" role="tablist" aria-label="Standard tabs">
                  {standardTabs.map((tab) => {
                    const isActive = activeStandardTab === tab;

                    return (
                      <button
                        key={tab}
                        type="button"
                        role="tab"
                        aria-selected={isActive}
                        className={
                          "pb-4 text-sm tracking-widest transition-colors cursor-pointer relative " +
                          (isActive ? "text-black" : "text-black/40 hover:text-black/60")
                        }
                        style={{ fontFamily: "acumin-pro, sans-serif" }}
                        onClick={() => setActiveStandardTab(tab)}
                      >
                        {tab}
                        {isActive && <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-black"></span>}
                      </button>
                    );
                  })}
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
                  {segmentOptions.map((segment) => {
                    const isActive = activeSegment === segment;

                    return (
                      <button
                        key={segment}
                        type="button"
                        aria-pressed={isActive}
                        onClick={() => setActiveSegment(segment)}
                        className={
                          "px-6 py-2 text-xs tracking-widest transition-all cursor-pointer rounded-full whitespace-nowrap " +
                          (isActive
                            ? "bg-black text-white"
                            : "text-black/60 hover:text-black")
                        }
                        style={{ fontFamily: "acumin-pro, sans-serif" }}
                      >
                        {segment}
                      </button>
                    );
                  })}
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
                    className="search-no-native-clear w-full pl-12 pr-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black transition-colors"
                    type="search"
                    value={searchStandard}
                    onChange={(e) => setSearchStandard(e.target.value)}
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
                    className="search-no-native-clear w-full pl-12 pr-12 py-3 border border-black/20 text-sm focus:outline-none focus:border-black transition-colors"
                    type="search"
                    value={searchWithClear}
                    onChange={(e) => setSearchWithClear(e.target.value)}
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  />
                  {searchWithClear.length > 0 && (
                    <button
                      type="button"
                      aria-label="入力内容をクリア"
                      className="absolute right-4 top-1/2 -translate-y-1/2 cursor-pointer"
                      onClick={() => setSearchWithClear("")}
                    >
                      <i className="ri-close-line text-base text-black/60 hover:text-black transition-colors"></i>
                    </button>
                  )}
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
              onClick={() => setDialogOpen(true)}
            >
              OPEN DIALOG
            </button>
          </section>
          {/* overlay moved below container */}


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
                onClick={() => setMediumSheetOpen(true)}
              >
                MEDIUM SHEET
              </button>
              <button
                type="button"
                className="px-8 py-3 border border-black text-black text-sm tracking-widest hover:bg-black hover:text-white transition-all duration-300 cursor-pointer whitespace-nowrap"
                style={{ fontFamily: "acumin-pro, sans-serif" }}
                onClick={() => setLargeSheetOpen(true)}
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
              onClick={() => setActionSheetOpen(true)}
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
            <div className="relative inline-block" ref={menuRef}>
              <button
                type="button"
                className="px-8 py-3 border border-black text-black text-sm tracking-widest hover:bg-black hover:text-white transition-all duration-300 cursor-pointer whitespace-nowrap flex items-center gap-2"
                style={{ fontFamily: "acumin-pro, sans-serif" }}
                onClick={() => setMenuOpen((v) => !v)}
              >
                MENU
                <div className="w-4 h-4 flex items-center justify-center">
                  <i className="ri-arrow-down-s-line text-base"></i>
                </div>
              </button>
              {menuOpen && (
                <div
                  className="absolute top-full left-0 mt-2 w-56 bg-white border border-black/20 shadow-lg z-10"
                >
                  <button
                    type="button"
                    className="w-full px-6 py-3 text-sm text-black hover:bg-[#f5f5f5] transition-colors cursor-pointer text-left"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-5 h-5 flex items-center justify-center">
                        <i className="ri-user-line text-xl"></i>
                      </div>
                      <span>アカウント設定</span>
                    </div>
                  </button>
                  <button
                    type="button"
                    className="w-full px-6 py-3 text-sm text-black hover:bg-[#f5f5f5] transition-colors cursor-pointer text-left"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-5 h-5 flex items-center justify-center">
                        <i className="ri-heart-line text-xl"></i>
                      </div>
                      <span>お気に入り</span>
                    </div>
                  </button>
                  <button
                    type="button"
                    className="w-full px-6 py-3 text-sm text-black hover:bg-[#f5f5f5] transition-colors cursor-pointer text-left"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-5 h-5 flex items-center justify-center">
                        <i className="ri-shopping-bag-line text-xl"></i>
                      </div>
                      <span>注文履歴</span>
                    </div>
                  </button>
                  <div className="h-px bg-black/10 my-1"></div>
                  <button
                    type="button"
                    className="w-full px-6 py-3 text-sm text-black hover:bg-[#f5f5f5] transition-colors cursor-pointer text-left"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-5 h-5 flex items-center justify-center">
                        <i className="ri-logout-box-line text-xl"></i>
                      </div>
                      <span>ログアウト</span>
                    </div>
                  </button>
                </div>
              )}
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
              onClick={() => setDrawerOpen(true)}
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
                onClick={() => {
                  const id = Date.now();
                  setToasts((prev) => [...prev, { id, message: "操作が完了しました" }]);
                  setTimeout(() => {
                    setToasts((prev) => prev.filter((t) => t.id !== id));
                  }, 3000);
                }}
              >
                SUCCESS
              </button>
              <button
                type="button"
                className="px-8 py-3 border border-black text-black text-sm tracking-widest hover:bg-black hover:text-white transition-all duration-300 cursor-pointer whitespace-nowrap"
                style={{ fontFamily: "acumin-pro, sans-serif" }}
                onClick={() => {
                  const id = Date.now();
                  setToasts((prev) => [...prev, { id, message: "エラーが発生しました", variant: 'error' }]);
                  setTimeout(() => {
                    setToasts((prev) => prev.filter((t) => t.id !== id));
                  }, 3000);
                }}
              >
                ERROR
              </button>
              <button
                type="button"
                className="px-8 py-3 border border-black text-black text-sm tracking-widest hover:bg-black hover:text-white transition-all duration-300 cursor-pointer whitespace-nowrap"
                style={{ fontFamily: "acumin-pro, sans-serif" }}
                onClick={() => {
                  const id = Date.now();
                  setToasts((prev) => [...prev, { id, message: "情報を確認してください", variant: 'info' }]);
                  setTimeout(() => {
                    setToasts((prev) => prev.filter((t) => t.id !== id));
                  }, 3000);
                }}
              >
                INFO
              </button>
            </div>
            <div className="fixed bottom-8 right-8 z-50 space-y-3">
              {toasts.map((toast) => {
                const iconClass =
                  toast.variant === 'error'
                    ? 'ri-error-warning-line'
                    : toast.variant === 'info'
                    ? 'ri-information-line'
                    : 'ri-check-line';

                return (
                  <div
                    key={toast.id}
                    className="bg-black text-white px-6 py-4 shadow-2xl min-w-[300px] animate-[slideIn_0.3s_ease-out]"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-5 h-5 flex items-center justify-center">
                        <i className={`${iconClass} text-xl`}></i>
                      </div>
                      <span className="text-sm" style={{ fontFamily: "acumin-pro, sans-serif" }}>
                        {toast.message}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
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
                  onMouseEnter={() => setTooltipVisible(true)}
                  onMouseLeave={() => setTooltipVisible(false)}
                  onFocus={() => setTooltipVisible(true)}
                  onBlur={() => setTooltipVisible(false)}
                >
                  HOVER ME
                </button>
                {tooltipVisible && (
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-4 py-2 bg-black text-white text-xs whitespace-nowrap" style={{ fontFamily: "acumin-pro, sans-serif" }}>
                    これはツールチップです
                    <div className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-l-transparent border-r-transparent border-t-black"></div>
                  </div>
                )}
              </div>
              <div className="relative">
                <button
                  type="button"
                  className="w-10 h-10 flex items-center justify-center border border-black/20 hover:bg-[#f5f5f5] transition-colors cursor-pointer"
                  onMouseEnter={() => setInfoTooltipVisible(true)}
                  onMouseLeave={() => setInfoTooltipVisible(false)}
                  onFocus={() => setInfoTooltipVisible(true)}
                  onBlur={() => setInfoTooltipVisible(false)}
                >
                  <div className="w-5 h-5 flex items-center justify-center">
                    <i className="ri-information-line text-xl"></i>
                  </div>
                </button>
                {infoTooltipVisible && (
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-4 py-2 bg-black text-white text-xs whitespace-nowrap" style={{ fontFamily: "acumin-pro, sans-serif" }}>
                    詳細情報
                    <div className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-l-transparent border-r-transparent border-t-black"></div>
                  </div>
                )}
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
                {floatMenuOpen && (
                  <div className="absolute bottom-16 right-0 space-y-3 mb-3">
                    <button
                      type="button"
                      className="w-12 h-12 bg-white border border-black/20 shadow-lg flex items-center justify-center hover:bg-[#f5f5f5] transition-all cursor-pointer"
                    >
                      <div className="w-5 h-5 flex items-center justify-center">
                        <i className="ri-share-line text-xl"></i>
                      </div>
                    </button>
                    <button
                      type="button"
                      className="w-12 h-12 bg-white border border-black/20 shadow-lg flex items-center justify-center hover:bg-[#f5f5f5] transition-all cursor-pointer"
                    >
                      <div className="w-5 h-5 flex items-center justify-center">
                        <i className="ri-heart-line text-xl"></i>
                      </div>
                    </button>
                    <button
                      type="button"
                      className="w-12 h-12 bg-white border border-black/20 shadow-lg flex items-center justify-center hover:bg-[#f5f5f5] transition-all cursor-pointer"
                    >
                      <div className="w-5 h-5 flex items-center justify-center">
                        <i className="ri-message-line text-xl"></i>
                      </div>
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  className="w-14 h-14 bg-black text-white shadow-2xl flex items-center justify-center hover:bg-[#474747] transition-all cursor-pointer"
                  onClick={() => setFloatMenuOpen((v) => !v)}
                >
                  <div className="w-6 h-6 flex items-center justify-center">
                    <i className={`${floatMenuOpen ? 'ri-close-line' : 'ri-add-line'} text-2xl transition-transform`}></i>
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
              {/* shipping */}
              <div className="border-b border-black/10">
                <button
                  type="button"
                  className="w-full px-6 py-5 flex items-center justify-between hover:bg-[#f5f5f5] transition-colors cursor-pointer text-left"
                  onClick={() =>
                    setOpenAccordion((v) => (v === "shipping" ? null : "shipping"))
                  }
                >
                  <span
                    className="text-sm text-black tracking-wide"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    配送について
                  </span>
                  <div className="w-5 h-5 flex items-center justify-center">
                    <i
                      className={`ri-arrow-${openAccordion === "shipping" ? "up" : "down"}-s-line text-xl transition-transform`}
                    ></i>
                  </div>
                </button>
                {openAccordion === "shipping" && (
                  <div className="px-6 pb-5">
                    <p
                      className="text-sm text-black/60 leading-relaxed"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      国内配送は通常3-5営業日でお届けします。送料は全国一律¥500、¥10,000以上のご購入で送料無料となります。
                    </p>
                  </div>
                )}
              </div>

              {/* returns */}
              <div className="border-b border-black/10">
                <button
                  type="button"
                  className="w-full px-6 py-5 flex items-center justify-between hover:bg-[#f5f5f5] transition-colors cursor-pointer text-left"
                  onClick={() =>
                    setOpenAccordion((v) => (v === "returns" ? null : "returns"))
                  }
                >
                  <span
                    className="text-sm text-black tracking-wide"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    返品・交換について
                  </span>
                  <div className="w-5 h-5 flex items-center justify-center">
                    <i
                      className={`ri-arrow-${openAccordion === "returns" ? "up" : "down"}-s-line text-xl transition-transform`}
                    ></i>
                  </div>
                </button>
                {openAccordion === "returns" && (
                  <div className="px-6 pb-5">
                    <p
                      className="text-sm text-black/60 leading-relaxed"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      商品到着後14日以内であれば、未使用品に限り返品・交換を承ります。詳細は利用規約をご確認ください。
                    </p>
                  </div>
                )}
              </div>

              {/* size guide */}
              <div className="">
                <button
                  type="button"
                  className="w-full px-6 py-5 flex items-center justify-between hover:bg-[#f5f5f5] transition-colors cursor-pointer text-left"
                  onClick={() =>
                    setOpenAccordion((v) => (v === "size" ? null : "size"))
                  }
                >
                  <span
                    className="text-sm text-black tracking-wide"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    サイズガイド
                  </span>
                  <div className="w-5 h-5 flex items-center justify-center">
                    <i
                      className={`ri-arrow-${openAccordion === "size" ? "up" : "down"}-s-line text-xl transition-transform`}
                    ></i>
                  </div>
                </button>
                {openAccordion === "size" && (
                  <div className="px-6 pb-5">
                    <p
                      className="text-sm text-black/60 leading-relaxed"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      各商品ページにサイズ表を掲載しております。ご不明な点がございましたら、お気軽にお問い合わせください。
                    </p>
                  </div>
                )}
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
                  alt={`Slide ${slideIndex + 1}`}
                  className="w-full h-full object-cover object-top"
                  src={carouselImages[slideIndex]}
                  width={800}
                  height={500}
                  priority={false}
                />
                <button
                  type="button"
                  className="absolute left-4 top-1/2 -translate-y-1/2 w-12 h-12 bg-white/90 hover:bg-white flex items-center justify-center transition-colors cursor-pointer"
                  onClick={() =>
                    setSlideIndex((idx) => (idx - 1 + carouselImages.length) % carouselImages.length)
                  }
                >
                  <div className="w-6 h-6 flex items-center justify-center">
                    <i className="ri-arrow-left-s-line text-2xl"></i>
                  </div>
                </button>
                <button
                  type="button"
                  className="absolute right-4 top-1/2 -translate-y-1/2 w-12 h-12 bg-white/90 hover:bg-white flex items-center justify-center transition-colors cursor-pointer"
                  onClick={() =>
                    setSlideIndex((idx) => (idx + 1) % carouselImages.length)
                  }
                >
                  <div className="w-6 h-6 flex items-center justify-center">
                    <i className="ri-arrow-right-s-line text-2xl"></i>
                  </div>
                </button>
                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2">
                  {carouselImages.map((_, idx) => (
                    <button
                      key={idx}
                      type="button"
                      className={
                        `transition-all cursor-pointer ` +
                        (slideIndex === idx
                          ? "w-6 h-2 rounded-full bg-white"
                          : "w-2 h-2 rounded-full bg-white/50")
                      }
                      onClick={() => setSlideIndex(idx)}
                    ></button>
                  ))}
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
                  <i className="ri-currency-line text-3xl text-black"></i>
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
              {showInfoBanner && (
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
                    onClick={() => setShowInfoBanner(false)}
                  >
                    <div className="w-4 h-4 flex items-center justify-center">
                      <i className="ri-close-line text-base"></i>
                    </div>
                  </button>
                </div>
              )}
              {showPromoBanner && (
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
                    onClick={() => setShowPromoBanner(false)}
                  >
                    <div className="w-4 h-4 flex items-center justify-center">
                      <i className="ri-close-line text-base text-black"></i>
                    </div>
                  </button>
                </div>
              )}
              {showAlertBanner && (
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
                    onClick={() => setShowAlertBanner(false)}
                  >
                    <div className="w-4 h-4 flex items-center justify-center">
                      <i className="ri-close-line text-base text-black"></i>
                    </div>
                  </button>
                </div>
              )}
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

          <section>
            <h2 className="text-2xl text-black mb-8 tracking-tight" style={{ fontFamily: "Didot, serif" }}>
              Tag / Label
            </h2>
            <div className="space-y-8">
              <div>
                <p className="text-xs tracking-widest mb-4 text-black/80" style={{ fontFamily: "acumin-pro, sans-serif" }}>
                  BASIC TAGS
                </p>
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="px-4 py-2 bg-black text-white text-xs tracking-widest" style={{ fontFamily: "acumin-pro, sans-serif" }}>
                    NEW
                  </span>
                  <span className="px-4 py-2 border border-black text-black text-xs tracking-widest" style={{ fontFamily: "acumin-pro, sans-serif" }}>
                    SALE
                  </span>
                  <span className="px-4 py-2 bg-[#f5f5f5] text-black text-xs tracking-widest" style={{ fontFamily: "acumin-pro, sans-serif" }}>
                    LIMITED
                  </span>
                </div>
              </div>
              <div>
                <p className="text-xs tracking-widest mb-4 text-black/80" style={{ fontFamily: "acumin-pro, sans-serif" }}>
                  REMOVABLE TAGS
                </p>
                <div className="flex items-center gap-3 flex-wrap">
                  {removableTags.map((tag) => (
                    <span key={tag} className="px-4 py-2 bg-[#f5f5f5] text-black text-xs tracking-widest flex items-center gap-2" style={{ fontFamily: "acumin-pro, sans-serif" }}>
                      {tag}
                      <button
                        type="button"
                        className="w-4 h-4 flex items-center justify-center hover:bg-black/10 transition-colors cursor-pointer"
                        onClick={() => setRemovableTags((prev) => prev.filter((t) => t !== tag))}
                      >
                        <i className="ri-close-line text-sm"></i>
                      </button>
                    </span>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-xs tracking-widest mb-4 text-black/80" style={{ fontFamily: "acumin-pro, sans-serif" }}>
                  ROUNDED TAGS
                </p>
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="px-4 py-2 bg-black text-white text-xs tracking-widest rounded-full" style={{ fontFamily: "acumin-pro, sans-serif" }}>
                    FEATURED
                  </span>
                  <span className="px-4 py-2 border border-black text-black text-xs tracking-widest rounded-full" style={{ fontFamily: "acumin-pro, sans-serif" }}>
                    TRENDING
                  </span>
                  <span className="px-4 py-2 bg-[#f5f5f5] text-black text-xs tracking-widest rounded-full" style={{ fontFamily: "acumin-pro, sans-serif" }}>
                    POPULAR
                  </span>
                </div>
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
      {dialogOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          onClick={() => setDialogOpen(false)}
        >
          <div className="absolute inset-0 bg-black/40"></div>
          <div
            className="relative bg-white w-full max-w-md mx-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-8">
              <h3
                className="text-2xl text-black mb-4 tracking-tight"
                style={{ fontFamily: "Didot, serif" }}
              >
                Dialog Title
              </h3>
              <p
                className="text-sm text-black/60 mb-8 leading-relaxed"
                style={{ fontFamily: "acumin-pro, sans-serif" }}
              >
                これはダイアログの本文です。ユーザーに重要な情報を伝えたり、確認を求めたりする際に使用します。
              </p>
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  className="flex-1 px-6 py-3 border border-black text-black text-sm tracking-widest hover:bg-black hover:text-white transition-all duration-300 cursor-pointer whitespace-nowrap"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                  onClick={() => setDialogOpen(false)}
                >
                  CANCEL
                </button>
                <button
                  type="button"
                  className="flex-1 px-6 py-3 bg-black text-white text-sm tracking-widest hover:bg-[#474747] transition-all duration-300 cursor-pointer whitespace-nowrap"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                  onClick={() => setDialogOpen(false)}
                >
                  CONFIRM
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {mediumSheetOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center"
          onClick={() => setMediumSheetOpen(false)}
        >
          <div className="absolute inset-0 bg-black/40"></div>
          <div
            className="relative bg-white w-full max-h-[50vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-8">
              <div className="flex items-center justify-between mb-6">
                <h3
                  className="text-2xl text-black tracking-tight"
                  style={{ fontFamily: "Didot, serif" }}
                >
                  Medium Sheet
                </h3>
                <button
                  type="button"
                  className="w-8 h-8 flex items-center justify-center hover:bg-[#f5f5f5] transition-colors cursor-pointer"
                  onClick={() => setMediumSheetOpen(false)}
                >
                  <div className="w-5 h-5 flex items-center justify-center">
                    <i className="ri-close-line text-xl"></i>
                  </div>
                </button>
              </div>
              <p
                className="text-sm text-black/60 leading-relaxed"
                style={{ fontFamily: "acumin-pro, sans-serif" }}
              >
                画面の約50%を占めるシートです。フィルター設定やオプション選択などに適しています。
              </p>
            </div>
          </div>
        </div>
      )}
      {largeSheetOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center"
          onClick={() => setLargeSheetOpen(false)}
        >
          <div className="absolute inset-0 bg-black/40"></div>
          <div
            className="relative bg-white w-full max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-8">
              <div className="flex items-center justify-between mb-6">
                <h3
                  className="text-2xl text-black tracking-tight"
                  style={{ fontFamily: "Didot, serif" }}
                >
                  Large Sheet
                </h3>
                <button
                  type="button"
                  className="w-8 h-8 flex items-center justify-center hover:bg-[#f5f5f5] transition-colors cursor-pointer"
                  onClick={() => setLargeSheetOpen(false)}
                >
                  <div className="w-5 h-5 flex items-center justify-center">
                    <i className="ri-close-line text-xl"></i>
                  </div>
                </button>
              </div>
              <p
                className="text-sm text-black/60 leading-relaxed mb-6"
                style={{ fontFamily: "acumin-pro, sans-serif" }}
              >
                画面の約90%を占める大きなシートです。詳細情報の表示や複雑なフォームに適しています。
              </p>
              <div className="space-y-4">
                <div className="p-4 border border-black/10">
                  <p
                    className="text-sm text-black"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    コンテンツ項目 1
                  </p>
                </div>
                <div className="p-4 border border-black/10">
                  <p
                    className="text-sm text-black"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    コンテンツ項目 2
                  </p>
                </div>
                <div className="p-4 border border-black/10">
                  <p
                    className="text-sm text-black"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    コンテンツ項目 3
                  </p>
                </div>
                <div className="p-4 border border-black/10">
                  <p
                    className="text-sm text-black"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    コンテンツ項目 4
                  </p>
                </div>
                <div className="p-4 border border-black/10">
                  <p
                    className="text-sm text-black"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    コンテンツ項目 5
                  </p>
                </div>
                <div className="p-4 border border-black/10">
                  <p
                    className="text-sm text-black"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    コンテンツ項目 6
                  </p>
                </div>
                <div className="p-4 border border-black/10">
                  <p
                    className="text-sm text-black"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    コンテンツ項目 7
                  </p>
                </div>
                <div className="p-4 border border-black/10">
                  <p
                    className="text-sm text-black"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    コンテンツ項目 8
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      {actionSheetOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center"
          onClick={() => setActionSheetOpen(false)}
        >
          <div className="absolute inset-0 bg-black/40"></div>
          <div
            className="relative bg-white w-full max-w-md mx-4 mb-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-2">
              <button
                type="button"
                className="w-full px-6 py-4 text-sm text-black hover:bg-[#f5f5f5] transition-colors cursor-pointer text-left"
                style={{ fontFamily: "acumin-pro, sans-serif" }}
              >
                <div className="flex items-center gap-3">
                  <div className="w-5 h-5 flex items-center justify-center">
                    <i className="ri-share-line text-xl"></i>
                  </div>
                  <span>シェアする</span>
                </div>
              </button>
              <button
                type="button"
                className="w-full px-6 py-4 text-sm text-black hover:bg-[#f5f5f5] transition-colors cursor-pointer text-left"
                style={{ fontFamily: "acumin-pro, sans-serif" }}
              >
                <div className="flex items-center gap-3">
                  <div className="w-5 h-5 flex items-center justify-center">
                    <i className="ri-download-line text-xl"></i>
                  </div>
                  <span>ダウンロード</span>
                </div>
              </button>
              <button
                type="button"
                className="w-full px-6 py-4 text-sm text-black hover:bg-[#f5f5f5] transition-colors cursor-pointer text-left"
                style={{ fontFamily: "acumin-pro, sans-serif" }}
              >
                <div className="flex items-center gap-3">
                  <div className="w-5 h-5 flex items-center justify-center">
                    <i className="ri-edit-line text-xl"></i>
                  </div>
                  <span>編集する</span>
                </div>
              </button>
              <div className="h-px bg-black/10 my-2"></div>
              <button
                type="button"
                className="w-full px-6 py-4 text-sm text-black hover:bg-[#f5f5f5] transition-colors cursor-pointer text-left"
                style={{ fontFamily: "acumin-pro, sans-serif" }}
                onClick={() => setActionSheetOpen(false)}
              >
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}
      {drawerOpen && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/40" onClick={() => setDrawerOpen(false)}></div>
          <div
            className="absolute top-0 right-0 bottom-0 w-full max-w-md bg-white shadow-2xl overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-8">
              <div className="flex items-center justify-between mb-8">
                <h3
                  className="text-2xl text-black tracking-tight"
                  style={{ fontFamily: "Didot, serif" }}
                >
                  Drawer Menu
                </h3>
                <button
                  type="button"
                  className="w-8 h-8 flex items-center justify-center hover:bg-[#f5f5f5] transition-colors cursor-pointer"
                  onClick={() => setDrawerOpen(false)}
                >
                  <div className="w-5 h-5 flex items-center justify-center">
                    <i className="ri-close-line text-xl"></i>
                  </div>
                </button>
              </div>
              <nav className="space-y-2">
                {['ITEM','LOOK','NEWS','ABOUT','STOCKIST','CONTACT'].map(label => (
                  <button
                    key={label}
                    type="button"
                    className="w-full px-4 py-4 text-sm tracking-widest text-black hover:bg-[#f5f5f5] transition-colors cursor-pointer text-left"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    {label}
                  </button>
                ))}
              </nav>
              <div className="mt-12 pt-8 border-t border-black/10">
                <p
                  className="text-xs tracking-widest text-black/60 mb-4"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  FOLLOW US
                </p>
                <div className="flex items-center gap-4">
                  {['instagram','facebook','twitter'].map((icon) => (
                    <button
                      key={icon}
                      type="button"
                      className="w-10 h-10 flex items-center justify-center border border-black/20 hover:bg-black hover:text-white transition-all duration-300 cursor-pointer"
                    >
                      <div className="w-5 h-5 flex items-center justify-center">
                        <i className={`ri-${icon}-line text-xl`}></i>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
