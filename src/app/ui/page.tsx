"use client";

import Image from 'next/image';
import { useState } from "react";
import { ActionSheet } from '@/app/components/ui/ActionSheet';
import { Button } from '@/app/components/ui/Button';
import { Checkbox } from '@/app/components/ui/Checkbox';
import { ColorPicker } from '@/app/components/ui/ColorPicker';
import { DateTimePicker } from '@/app/components/ui/DateTimePicker';
import { DataTable } from '@/app/components/ui/DataTable';
import { Dialog } from '@/app/components/ui/Dialog';
import { Drawer } from '@/app/components/ui/Drawer';
import { Dropdown } from '@/app/components/ui/Dropdown';
import { FloatingButton } from '@/app/components/ui/FloatingButton';
import { List } from '@/app/components/ui/List';
import { MultiSelect } from '@/app/components/ui/MultiSelect';
import { BottomNavigation } from '@/app/components/ui/BottomNavigation';
import { PageControl } from '@/app/components/ui/PageControl';
import { RadioButtonGroup } from '@/app/components/ui/RadioButtonGroup';
import { Rating } from '@/app/components/ui/Rating';
import { SearchField } from '@/app/components/ui/SearchField';
import { SheetLarge } from '@/app/components/ui/SheetLarge';
import { SheetMedium } from '@/app/components/ui/SheetMedium';
import { SingleSelect } from '@/app/components/ui/SingleSelect';
import { Slider } from '@/app/components/ui/Slider';
import { Stepper } from '@/app/components/ui/Stepper';
import { SwitchToggle } from '@/app/components/ui/SwitchToggle';
import { TabSegmentControl } from '@/app/components/ui/TabSegmentControl';
import { TextAreaField } from '@/app/components/ui/TextAreaField';
import { TextField } from '@/app/components/ui/TextField';
import { ToastSnackbar } from '@/app/components/ui/ToastSnackbar';
import { Tooltip } from '@/app/components/ui/Tooltip';

export default function Page() {
  const [standardText, setStandardText] = useState("");
  const [email, setEmail] = useState("");
  const [radioValue, setRadioValue] = useState("option1");
  const [checkboxTerms, setCheckboxTerms] = useState(false);
  const [checkboxNewsletter, setCheckboxNewsletter] = useState(false);
  const [checkboxPrivacy, setCheckboxPrivacy] = useState(false);
  const [category, setCategory] = useState("TOPS");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [mediumSheetOpen, setMediumSheetOpen] = useState(false);
  const [largeSheetOpen, setLargeSheetOpen] = useState(false);
  const [actionSheetOpen, setActionSheetOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // stack of toast notifications
  const [toasts, setToasts] = useState<{id: number; message: string; variant?: 'success' | 'error' | 'info'}[]>([]);
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
  const categoryOptions = ["TOPS", "BOTTOMS", "OUTERWEAR", "ACCESSORIES"];

  const [sizes, setSizes] = useState(["S", "M"]);
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
  const radioOptions = [
    { value: 'option1', label: 'オプション 1' },
    { value: 'option2', label: 'オプション 2' },
    { value: 'option3', label: 'オプション 3' },
    { value: 'option4', label: '無効なオプション', disabled: true },
  ];
  const singleSelectOptions = categoryOptions.map((option) => ({ value: option, label: option }));
  const multiSelectOptions = ["S", "M", "L", "FREE"].map((option) => ({ value: option, label: option }));
  const orderRows = [
    { id: 'ORD-001', date: '2024-03-15', product: 'Minimal Cotton Shirt', qty: '1', total: '¥18,000' },
    { id: 'ORD-002', date: '2024-03-14', product: 'Pleated Skirt', qty: '2', total: '¥32,000' },
    { id: 'ORD-003', date: '2024-03-13', product: 'Cashmere Blend Coat', qty: '1', total: '¥68,000' },
    { id: 'ORD-004', date: '2024-03-12', product: 'Leather Tote Bag', qty: '1', total: '¥24,000' },
  ] as const;
  const showcaseListItems = [
    { name: 'Minimal Cotton Shirt', category: 'TOPS', price: '¥18,000' },
    { name: 'Pleated Skirt', category: 'BOTTOMS', price: '¥16,000' },
    { name: 'Cashmere Blend Coat', category: 'OUTERWEAR', price: '¥68,000' },
    { name: 'Leather Tote Bag', category: 'ACCESSORIES', price: '¥24,000' },
  ] as const;
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
                <TextField
                  label="STANDARD"
                  placeholder="テキストを入力"
                  type="text"
                  value={standardText}
                  onChange={e => setStandardText(e.target.value)}
                />
              </div>
              <div>
                <TextField
                  label="WITH ICON"
                  placeholder="メールアドレス"
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  leadingIcon={<i className="ri-mail-line text-base"></i>}
                />
              </div>
              <div>
                <TextField
                  label="DISABLED"
                  disabled
                  type="text"
                  value="無効な入力フィールド"
                />
              </div>
              <div>
                <TextAreaField
                  label="TEXTAREA"
                  placeholder="メッセージを入力"
                  rows={4}
                />
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
                <Button className="w-full" size="md">
                  PRIMARY BUTTON
                </Button>
              </div>
              <div>
                <p
                  className="text-xs tracking-widest mb-4 text-black/80"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  SECONDARY
                </p>
                <Button variant="secondary" className="w-full" size="md">
                  SECONDARY BUTTON
                </Button>
              </div>
              <div>
                <p
                  className="text-xs tracking-widest mb-4 text-black/80"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  TEXT
                </p>
                <Button variant="text" className="w-full" size="md">
                  TEXT BUTTON
                </Button>
              </div>
              <div>
                <p
                  className="text-xs tracking-widest mb-4 text-black/80"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  WITH ICON
                </p>
                <Button className="w-full gap-2" size="md">
                  <div className="w-4 h-4 flex items-center justify-center">
                    <i className="ri-shopping-bag-line text-base"></i>
                  </div>
                  ADD TO CART
                </Button>
              </div>
              <div>
                <p
                  className="text-xs tracking-widest mb-4 text-black/80"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  ICON ONLY
                </p>
                <Button variant="secondary" className="px-4 py-3" size="sm" aria-label="Add to wishlist">
                  <div className="w-5 h-5 flex items-center justify-center">
                    <i className="ri-heart-line text-xl"></i>
                  </div>
                </Button>
              </div>
              <div>
                <p
                  className="text-xs tracking-widest mb-4 text-black/80"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  DISABLED
                </p>
                <Button disabled className="w-full" size="md">
                  DISABLED BUTTON
                </Button>
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
            <RadioButtonGroup
              name="demo-radio"
              value={radioValue}
              options={radioOptions}
              onChange={setRadioValue}
            />
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
              <Checkbox
                checked={checkboxTerms}
                onChange={(e) => setCheckboxTerms(e.target.checked)}
                label="利用規約に同意する"
              />
              <Checkbox
                checked={checkboxNewsletter}
                onChange={(e) => setCheckboxNewsletter(e.target.checked)}
                label="ニュースレターを受け取る"
              />
              <Checkbox
                checked={checkboxPrivacy}
                onChange={(e) => setCheckboxPrivacy(e.target.checked)}
                label="プライバシーポリシーに同意する"
              />
              <Checkbox disabled label="無効なチェックボックス" />
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
              <SingleSelect
                label="CATEGORY"
                variant="dropdown"
                options={singleSelectOptions}
                value={category}
                onValueChange={setCategory}
              />
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
              <MultiSelect
                label="SIZE"
                variant="dropdown"
                options={multiSelectOptions}
                values={sizes}
                onChange={setSizes}
              />
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
              <div className="max-w-md">
                <SwitchToggle
                  label="通知を受け取る"
                  checked={notify}
                  onChange={setNotify}
                  fullWidth
                />
              </div>
              <div className="max-w-md">
                <SwitchToggle
                  label="無効なスイッチ"
                  checked={false}
                  onChange={() => undefined}
                  disabled
                  fullWidth
                />
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
                <Slider
                  label="SINGLE VALUE"
                  value={singleValue}
                  min={0}
                  max={100}
                  step={1}
                  onValueChange={setSingleValue}
                  valueDisplay={String(singleValue)}
                />
              </div>
              <div>
                <Slider
                  mode="range"
                  label="PRICE RANGE"
                  rangeValue={rangeValues}
                  min={0}
                  max={100}
                  step={1}
                  onRangeChange={setRangeValues}
                  valueDisplay={`¥${rangeMin * 100} - ¥${rangeMax * 100}`}
                />
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
              <Stepper
                label="QUANTITY"
                value={stepperValue}
                min={1}
                onChange={setStepperValue}
                variant="field"
              />
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
              <Rating
                label="INTERACTIVE"
                value={rating}
                onChange={setRating}
                showValue
              />
              <Rating
                label="READ ONLY"
                value={4}
                readOnly
                showValue
                valueText="4.0 / 5"
              />
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
              <ColorPicker
                label="PRESET COLORS"
                variant="preset"
                value={color}
                presets={presetColors}
                onValueChange={setColor}
              />
              <div className="max-w-xs">
                <ColorPicker
                  label="CUSTOM COLOR"
                  variant="custom"
                  value={color}
                  onValueChange={setColor}
                />
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
              <DateTimePicker
                mode="date"
                value={dateValue}
                onChange={(event) => setDateValue(event.target.value)}
                className="cursor-pointer"
              />
              <DateTimePicker
                mode="time"
                value={timeValue}
                onChange={(event) => setTimeValue(event.target.value)}
                className="cursor-pointer"
              />
              <DateTimePicker
                mode="datetime-local"
                value={dateTimeValue}
                onChange={(event) => setDateTimeValue(event.target.value)}
                className="cursor-pointer"
              />
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
            <PageControl
              page={currentPage}
              totalPages={pageNumbers.length}
              onPageChange={setCurrentPage}
            />
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
              <BottomNavigation
                items={bottomNavItems.map((item) => ({ key: item.key, label: item.key, iconClass: item.iconClass }))}
                activeKey={activeBottomNav}
                onChange={(key) => setActiveBottomNav(key as (typeof bottomNavItems)[number]["key"])}
                fixed={false}
                appearance="minimal"
                className="shadow-lg"
              />
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
                <TabSegmentControl
                  variant="tabs-standard"
                  items={standardTabs.map((tab) => ({ key: tab, label: tab }))}
                  activeKey={activeStandardTab}
                  onChange={(key) => setActiveStandardTab(key as (typeof standardTabs)[number])}
                />
              </div>
              <div>
                <label
                  className="block text-xs tracking-widest mb-4 text-black/80"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  SEGMENT CONTROL
                </label>
                <TabSegmentControl
                  variant="segment-pill"
                  items={segmentOptions.map((segment) => ({ key: segment, label: segment }))}
                  activeKey={activeSegment}
                  onChange={(key) => setActiveSegment(key as (typeof segmentOptions)[number])}
                />
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
              <SearchField
                label="STANDARD"
                placeholder="商品を検索"
                value={searchStandard}
                onChange={(event) => setSearchStandard(event.target.value)}
              />
              <SearchField
                label="WITH CLEAR BUTTON"
                placeholder="商品を検索"
                value={searchWithClear}
                onChange={(event) => setSearchWithClear(event.target.value)}
                showClearButton
                onClear={() => setSearchWithClear('')}
              />
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
            <Button type="button" className="px-8" onClick={() => setDialogOpen(true)}>
              OPEN DIALOG
            </Button>
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
            <Button type="button" className="px-8" onClick={() => setActionSheetOpen(true)}>
              OPEN ACTION SHEET
            </Button>
          </section>

          {/* --- Dropdown --- */}
          <section>
            <h2
              className="text-2xl text-black mb-8 tracking-tight"
              style={{ fontFamily: "Didot, serif" }}
            >
              Dropdown
            </h2>
            <Dropdown
              triggerLabel="MENU"
              items={[
                { key: 'account', label: 'アカウント設定', iconClass: 'ri-user-line', onSelect: () => {} },
                { key: 'favorite', label: 'お気に入り', iconClass: 'ri-heart-line', onSelect: () => {} },
                { key: 'orders', label: '注文履歴', iconClass: 'ri-shopping-bag-line', onSelect: () => {} },
                {
                  key: 'logout',
                  label: 'ログアウト',
                  iconClass: 'ri-logout-box-line',
                  hasDividerBefore: true,
                  onSelect: () => {},
                },
              ]}
            />
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
              <Button
                type="button"
                className="px-8"
                onClick={() => {
                  const id = Date.now();
                  setToasts((prev) => [...prev, { id, message: "操作が完了しました" }]);
                  setTimeout(() => {
                    setToasts((prev) => prev.filter((t) => t.id !== id));
                  }, 3000);
                }}
              >
                SUCCESS
              </Button>
              <Button
                type="button"
                variant="secondary"
                className="px-8"
                onClick={() => {
                  const id = Date.now();
                  setToasts((prev) => [...prev, { id, message: "エラーが発生しました", variant: 'error' }]);
                  setTimeout(() => {
                    setToasts((prev) => prev.filter((t) => t.id !== id));
                  }, 3000);
                }}
              >
                ERROR
              </Button>
              <Button
                type="button"
                variant="secondary"
                className="px-8"
                onClick={() => {
                  const id = Date.now();
                  setToasts((prev) => [...prev, { id, message: "情報を確認してください", variant: 'info' }]);
                  setTimeout(() => {
                    setToasts((prev) => prev.filter((t) => t.id !== id));
                  }, 3000);
                }}
              >
                INFO
              </Button>
            </div>
            <div className="fixed bottom-8 right-8 z-50 space-y-3">
              {toasts.map((toast) => (
                <ToastSnackbar key={toast.id} message={toast.message} variant={toast.variant} />
              ))}
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
              <Tooltip content="これはツールチップです">
                <Button type="button" className="px-8">
                  HOVER ME
                </Button>
              </Tooltip>
              <Tooltip content="詳細情報">
                <Button type="button" variant="secondary" className="h-10 w-10 px-0 py-0" aria-label="詳細情報">
                  <div className="w-5 h-5 flex items-center justify-center">
                    <i className="ri-information-line text-xl"></i>
                  </div>
                </Button>
              </Tooltip>
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
              <FloatingButton
                label="FLOAT"
                onClick={() => undefined}
                actions={[
                  { key: 'share', iconClass: 'ri-share-line', onClick: () => undefined },
                  { key: 'heart', iconClass: 'ri-heart-line', onClick: () => undefined },
                  { key: 'message', iconClass: 'ri-message-line', onClick: () => undefined },
                ]}
                open={floatMenuOpen}
                onOpenChange={setFloatMenuOpen}
                fixed={false}
                className="absolute bottom-6 right-6"
              />
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
            <DataTable
              columns={[
                {
                  key: 'id',
                  header: 'ORDER ID',
                  render: (row) => row.id,
                  headerClassName: 'text-black/80',
                  cellClassName: 'text-black',
                },
                {
                  key: 'date',
                  header: 'DATE',
                  render: (row) => row.date,
                  headerClassName: 'text-black/80',
                  cellClassName: 'text-black/60',
                },
                {
                  key: 'product',
                  header: 'PRODUCT',
                  render: (row) => row.product,
                  headerClassName: 'text-black/80',
                  cellClassName: 'text-black',
                },
                {
                  key: 'qty',
                  header: 'QTY',
                  render: (row) => row.qty,
                  headerClassName: 'text-black/80',
                  cellClassName: 'text-black/60',
                },
                {
                  key: 'total',
                  header: 'TOTAL',
                  render: (row) => row.total,
                  headerClassName: 'text-black/80',
                  cellClassName: 'text-black',
                },
              ]}
              rows={orderRows}
              rowKey={(row) => row.id}
              hoverableRows
              containerClassName="border-black/20"
              tableClassName="w-full min-w-0"
              rowClassName="border-black/10"
            />
          </section>

          {/* --- List --- */}
          <section>
            <h2
              className="text-2xl text-black mb-8 tracking-tight"
              style={{ fontFamily: "Didot, serif" }}
            >
              List
            </h2>
            <List<(typeof showcaseListItems)[number]>
              items={showcaseListItems}
              itemKey={(item) => item.name}
              className="max-w-2xl space-y-px border border-black/20"
              renderItem={(item, index) => (
                <div
                  className={`flex cursor-pointer items-center justify-between px-6 py-5 transition-colors hover:bg-[#f5f5f5] ${
                    index < showcaseListItems.length - 1 ? 'border-b border-black/10' : ''
                  }`}
                >
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 bg-[#f5f5f5] flex items-center justify-center">
                      <div className="w-5 h-5 flex items-center justify-center">
                        <i className="ri-image-line text-xl text-black/40"></i>
                      </div>
                    </div>
                    <div>
                      <p className="text-sm text-black mb-1" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                        {item.name}
                      </p>
                      <p className="text-xs text-black/40 tracking-wider" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                        {item.category}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-sm text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                      {item.price}
                    </span>
                    <div className="w-5 h-5 flex items-center justify-center">
                      <i className="ri-arrow-right-s-line text-xl text-black/40"></i>
                    </div>
                  </div>
                </div>
              )}
            />
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
      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title="Dialog Title"
        description="これはダイアログの本文です。ユーザーに重要な情報を伝えたり、確認を求めたりする際に使用します。"
      />
      <SheetMedium open={mediumSheetOpen} onClose={() => setMediumSheetOpen(false)} title="Medium Sheet">
        <p
          className="text-sm text-black/60 leading-relaxed"
          style={{ fontFamily: "acumin-pro, sans-serif" }}
        >
          画面の約50%を占めるシートです。フィルター設定やオプション選択などに適しています。
        </p>
      </SheetMedium>
      <SheetLarge open={largeSheetOpen} onClose={() => setLargeSheetOpen(false)} title="Large Sheet">
        <p
          className="text-sm text-black/60 leading-relaxed mb-6"
          style={{ fontFamily: "acumin-pro, sans-serif" }}
        >
          画面の約90%を占める大きなシートです。詳細情報の表示や複雑なフォームに適しています。
        </p>
        <div className="space-y-4">
          {[1, 2, 3, 4, 5, 6, 7, 8].map((item) => (
            <div key={item} className="p-4 border border-black/10">
              <p className="text-sm text-black" style={{ fontFamily: "acumin-pro, sans-serif" }}>
                {`コンテンツ項目 ${item}`}
              </p>
            </div>
          ))}
        </div>
      </SheetLarge>
      <ActionSheet
        open={actionSheetOpen}
        onClose={() => setActionSheetOpen(false)}
        actions={[
          { key: 'share', label: 'シェアする', iconClass: 'ri-share-line', onSelect: () => {} },
          { key: 'download', label: 'ダウンロード', iconClass: 'ri-download-line', onSelect: () => {} },
          { key: 'edit', label: '編集する', iconClass: 'ri-edit-line', onSelect: () => {} },
        ]}
      />
      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)}>
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
      </Drawer>
    </main>
  );
}
