"use client";

import Image from 'next/image';
import { useState } from "react";
import { ComponentSize } from '@/components/ui/types';
import { cn } from '@/lib/utils';
import { Accordion } from '@/components/ui/Accordion';
import { ActionSheet } from '@/components/ui/ActionSheet';
import { Avatar } from '@/components/ui/Avatar';
import { BannerAlert } from '@/components/ui/BannerAlert';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Carousel } from '@/components/ui/Carousel';
import { Checkbox } from '@/components/ui/Checkbox';
import { ColorPicker } from '@/components/ui/ColorPicker';
import { DateTimePicker } from '@/components/ui/DateTimePicker';
import { DataTable } from '@/components/ui/DataTable';
import { Dialog } from '@/components/ui/Dialog';
import { Drawer } from '@/components/ui/Drawer';
import { Dropdown } from '@/components/ui/Dropdown';
import { FloatingButton } from '@/components/ui/FloatingButton';
import { Graph } from '@/components/ui/Graph';
import { List } from '@/components/ui/List';
import { MapView } from '@/components/ui/MapView';
import { MultiSelect } from '@/components/ui/MultiSelect';
import { BottomNavigation } from '@/components/ui/BottomNavigation';
import { PageControl } from '@/components/ui/PageControl';
import { RadioButtonGroup } from '@/components/ui/RadioButtonGroup';
import { Rating } from '@/components/ui/Rating';
import { SearchField } from '@/components/ui/SearchField';
import { SheetLarge } from '@/components/ui/SheetLarge';
import { SheetMedium } from '@/components/ui/SheetMedium';
import { SingleSelect } from '@/components/ui/SingleSelect';
import { Slider } from '@/components/ui/Slider';
import { Stats } from '@/components/ui/Stats';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Stepper } from '@/components/ui/Stepper';
import { SwitchToggle } from '@/components/ui/SwitchToggle';
import { TabSegmentControl } from '@/components/ui/TabSegmentControl';
import { TagLabel } from '@/components/ui/TagLabel';
import { TextAreaField } from '@/components/ui/TextAreaField';
import { TextField } from '@/components/ui/TextField';
import { ToastSnackbar } from '@/components/ui/ToastSnackbar';
import { Toolbar } from '@/components/ui/Toolbar';
import { Tooltip } from '@/components/ui/Tooltip';

export default function Page() {
  const [demoSize, setDemoSize] = useState<ComponentSize>('md');
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

  // helper maps for the drawer demo buttons
  const navItemClassMap: Record<ComponentSize, string> = {
    sm: 'px-4 py-3 text-xs',
    md: 'px-4 py-4 text-sm',
    lg: 'px-4 py-5 text-base',
  };

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
  type ShowcaseItem = { name: string; category: string; price: string; imageUrl: string };
  const showcaseListItems: ShowcaseItem[] = [
    { name: 'Minimal Cotton Shirt', category: 'TOPS', price: '¥18,000', imageUrl: '/placeholder.png' },
    { name: 'Pleated Skirt', category: 'BOTTOMS', price: '¥16,000', imageUrl: '/placeholder.png' },
    { name: 'Cashmere Blend Coat', category: 'OUTERWEAR', price: '¥68,000', imageUrl: '/placeholder.png' },
    { name: 'Leather Tote Bag', category: 'ACCESSORIES', price: '¥24,000', imageUrl: '/placeholder.png' },
  ];
  const accordionItems = [
    {
      key: 'shipping',
      title: '配送について',
      content: '国内配送は通常3-5営業日でお届けします。送料は全国一律¥500、¥10,000以上のご購入で送料無料となります。',
    },
    {
      key: 'returns',
      title: '返品・交換について',
      content: '商品到着後14日以内であれば、未使用品に限り返品・交換を承ります。詳細は利用規約をご確認ください。',
    },
    {
      key: 'size',
      title: 'サイズガイド',
      content: '各商品ページにサイズ表を掲載しております。ご不明な点がございましたら、お気軽にお問い合わせください。',
    },
  ] as const;
  const cardItems = [
    {
      alt: 'Minimal Cotton Shirt',
      src: 'https://readdy.ai/api/search-image?query=minimalist%20elegant%20white%20cotton%20shirt%20on%20clean%20white%20background%20professional%20product%20photography%20soft%20natural%20lighting%20high%20end%20fashion%20simple%20composition%20luxury%20fabric%20texture%20studio%20shot&width=400&height=500&seq=card1&orientation=portrait',
      category: 'TOPS',
      title: 'Minimal Cotton Shirt',
      price: '¥18,000',
    },
    {
      alt: 'Pleated Skirt',
      src: 'https://readdy.ai/api/search-image?query=elegant%20beige%20pleated%20midi%20skirt%20on%20clean%20white%20background%20professional%20product%20photography%20soft%20natural%20lighting%20high%20end%20fashion%20simple%20composition%20luxury%20fabric%20texture%20studio%20shot&width=400&height=500&seq=card2&orientation=portrait',
      category: 'BOTTOMS',
      title: 'Pleated Skirt',
      price: '¥16,000',
    },
    {
      alt: 'Cashmere Blend Coat',
      src: 'https://readdy.ai/api/search-image?query=luxurious%20camel%20cashmere%20wool%20coat%20on%20clean%20white%20background%20professional%20product%20photography%20soft%20natural%20lighting%20high%20end%20fashion%20simple%20composition%20premium%20fabric%20texture%20studio%20shot&width=400&height=500&seq=card3&orientation=portrait',
      category: 'OUTERWEAR',
      title: 'Cashmere Blend Coat',
      price: '¥68,000',
    },
  ] as const;
  const carouselSlides = carouselImages.map((src, index) => ({
    src,
    alt: `Slide ${index + 1}`,
  }));
  const salesTrendData = [
    { label: '1月', value: 40 },
    { label: '2月', value: 65 },
    { label: '3月', value: 45 },
    { label: '4月', value: 80 },
    { label: '5月', value: 55 },
    { label: '6月', value: 90 },
    { label: '7月', value: 70 },
  ] as const;
  const categoryDistributionData = [
    { label: 'TOPS', value: 30, color: '#000000' },
    { label: 'BOTTOMS', value: 25, color: '#474747' },
    { label: 'OUTERWEAR', value: 20, color: '#808080' },
    { label: 'ACCESSORIES', value: 25, color: '#B0B0B0' },
  ] as const;
  const statsItems = [
    { label: 'TOTAL ORDERS', value: '1,234', iconClass: 'ri-shopping-bag-line' },
    { label: 'REVENUE', value: '¥2,450,000', iconClass: 'ri-currency-line' },
    { label: 'CUSTOMERS', value: '856', iconClass: 'ri-user-line' },
    { label: 'PRODUCTS', value: '142', iconClass: 'ri-shirt-line' },
  ] as const;
  const toolbarPrimaryLeftItems = [
    { key: 'bold', iconClass: 'ri-bold' },
    { key: 'italic', iconClass: 'ri-italic' },
    { key: 'underline', iconClass: 'ri-underline' },
    { key: 'align-left', iconClass: 'ri-align-left' },
    { key: 'align-center', iconClass: 'ri-align-center' },
    { key: 'align-right', iconClass: 'ri-align-right' },
  ] as const;
  const toolbarPrimaryRightItems = [
    { key: 'link', iconClass: 'ri-link' },
    { key: 'image', iconClass: 'ri-image-line' },
  ] as const;
  const toolbarSecondaryLeftItems = [
    { key: 'filter', iconClass: 'ri-filter-line', label: 'フィルター' },
    { key: 'sort', iconClass: 'ri-sort-desc', label: '並び替え' },
  ] as const;
  const toolbarSecondaryRightItems = [
    { key: 'layout', iconClass: 'ri-layout-grid-line' },
  ] as const;
  // ...existing code...
  return (    <main className="pt-32 pb-20">
      <div className="max-w-7xl mx-auto px-6 lg:px-12">
        <div className="mb-12 flex items-center gap-3 sticky top-32 bg-white z-50 py-4">
          {(['sm', 'md', 'lg'] as const).map((size) => (
            <Button
              key={size}
              type="button"
              variant={demoSize === size ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => setDemoSize(size)}
              className="min-w-14 uppercase"
            >
              {size}
            </Button>
          ))}
        </div>

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
                  size={demoSize}/>
              </div>
              <div>
                <TextField
                  label="WITH ICON"
                  placeholder="メールアドレス"
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  leadingIcon={<i className="ri-mail-line text-base"></i>}
                 size={demoSize}/>
              </div>
              <div>
                <TextField
                  label="DISABLED"
                  disabled
                  type="text"
                  value="無効な入力フィールド"
                 size={demoSize}/>
              </div>
              <div>
                <TextAreaField
                  label="TEXTAREA"
                  placeholder="メッセージを入力"
                  rows={4}
                 size={demoSize}/>
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
                <Button className="w-full" size={demoSize}>
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
                <Button variant="secondary" className="w-full" size={demoSize}>
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
                <Button variant="text" className="w-full" size={demoSize}>
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
                <Button className="w-full gap-2" size={demoSize}>
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
                <Button variant="secondary" className="aspect-square px-0" size={demoSize} aria-label="Add to wishlist">
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
                <Button disabled className="w-full" size={demoSize}>
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
             size={demoSize}/>
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
               size={demoSize}/>
              <Checkbox
                checked={checkboxNewsletter}
                onChange={(e) => setCheckboxNewsletter(e.target.checked)}
                label="ニュースレターを受け取る"
               size={demoSize}/>
              <Checkbox
                checked={checkboxPrivacy}
                onChange={(e) => setCheckboxPrivacy(e.target.checked)}
                label="プライバシーポリシーに同意する"
               size={demoSize}/>
              <Checkbox disabled label="無効なチェックボックス"  size={demoSize}/>
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
               size={demoSize}/>
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
               size={demoSize}/>
            </div>
            {/* button-style example */}
            <div className="max-w-md mt-8">
              <MultiSelect
                label="SIZE (BUTTONS)"
                variant="buttons"
                options={multiSelectOptions}
                values={sizes}
                onChange={setSizes}
               size={demoSize}/>
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
                  size={demoSize}/>
              </div>
              <div className="max-w-md">
                <SwitchToggle
                  label="無効なスイッチ"
                  checked={false}
                  onChange={() => undefined}
                  disabled
                  fullWidth
                  size={demoSize}/>
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
                 size={demoSize}/>
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
                 size={demoSize}/>
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
                size={demoSize}/>
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
                size={demoSize}/>
              <Rating
                label="READ ONLY"
                value={4}
                readOnly
                showValue
                valueText="4.0 / 5"
                size={demoSize}/>
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
               size={demoSize}/>
              <div className="max-w-xs">
                <ColorPicker
                  label="CUSTOM COLOR"
                  variant="custom"
                  value={color}
                  onValueChange={setColor}
                 size={demoSize}/>
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
                size={demoSize}/>
              <DateTimePicker
                mode="time"
                value={timeValue}
                onChange={(event) => setTimeValue(event.target.value)}
                className="cursor-pointer"
                size={demoSize}/>
              <DateTimePicker
                mode="datetime-local"
                value={dateTimeValue}
                onChange={(event) => setDateTimeValue(event.target.value)}
                className="cursor-pointer"
                size={demoSize}/>
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
              size={demoSize}/>
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
                size={demoSize}/>
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
                 size={demoSize}/>
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
                 size={demoSize}/>
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
               size={demoSize}/>
              <SearchField
                label="WITH CLEAR BUTTON"
                placeholder="商品を検索"
                value={searchWithClear}
                onChange={(event) => setSearchWithClear(event.target.value)}
                showClearButton
                onClear={() => setSearchWithClear('')}
               size={demoSize}/>
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
            <Button type="button" className="px-8" onClick={() => setDialogOpen(true)} size={demoSize}>
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
            <Button type="button" className="px-8" onClick={() => setActionSheetOpen(true)} size={demoSize}>
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
              size={demoSize}/>
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
               size={demoSize}>
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
               size={demoSize}>
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
               size={demoSize}>
                INFO
              </Button>
            </div>
            <div className="fixed bottom-8 right-8 z-50 space-y-3">
              {toasts.map((toast) => (
                <ToastSnackbar key={toast.id} message={toast.message} variant={toast.variant}  size={demoSize}/>
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
              <Tooltip content="これはツールチップです" size={demoSize}>
                <Button type="button" className="px-8" size={demoSize}>
                  HOVER ME
                </Button>
              </Tooltip>
              <Tooltip content="詳細情報" size={demoSize}>
                <Button type="button" variant="secondary" className="h-10 w-10 px-0 py-0" aria-label="詳細情報" size={demoSize}>
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
                size={demoSize}/>
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
             size={demoSize}/>
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
              variant="showcase"
              getName={(item) => item.name}
              getCategory={(item) => item.category}
              getPrice={(item) => item.price}
              getImage={(item) => item.imageUrl}
              size={demoSize}
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
            <Accordion
              items={accordionItems}
              openKey={openAccordion}
              onOpenChange={(key) => setOpenAccordion(key as "shipping" | "returns" | "size" | null)}
             size={demoSize}/>
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
              {cardItems.map((item) => (
                <Card
                  key={item.title}
                  className="group"
                  category={item.category}
                  title={item.title}
                  price={item.price}
                  image={
                    <Image
                      alt={item.alt}
                      className="h-full w-full object-cover object-top transition-transform duration-500 group-hover:scale-105"
                      src={item.src}
                      width={400}
                      height={500}
                      priority={false}
                    />
                  }
                  overlayAction={
                    <button
                      type="button"
                      className="flex h-10 w-10 items-center justify-center bg-white/90 transition-colors hover:bg-white"
                    >
                      <div className="flex h-5 w-5 items-center justify-center">
                        <i className="ri-heart-line text-xl"></i>
                      </div>
                    </button>
                  }
                  size={demoSize}/>
              ))}
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
            <Carousel slides={carouselSlides} index={slideIndex} onIndexChange={setSlideIndex}  size={demoSize}/>
          </section>

          {/* --- Map --- */}
          <section>
            <h2
              className="text-2xl text-black mb-8 tracking-tight"
              style={{ fontFamily: "Didot, serif" }}
            >
              Map
            </h2>
            <MapView
              embedUrl="https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3240.8280108514437!2d139.7671248!3d35.6812362!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x60188bfbd89f700b%3A0x277c49ba34ed38!2z5p2x5Lqs6aeF!5e0!3m2!1sja!2sjp!4v1234567890123"
              className="border-black/20"
             size={demoSize}/>
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
                <Graph data={salesTrendData} variant="bars"  size={demoSize}/>
              </div>
              <div className="border border-black/20 p-6">
                <h3
                  className="text-xs tracking-widest text-black/80 mb-6"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  CATEGORY DISTRIBUTION
                </h3>
                <Graph data={categoryDistributionData} variant="donut"  size={demoSize}/>
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
            <Stats
              items={statsItems.map((item) => ({
                label: item.label,
                value: item.value,
                icon: <i className={`${item.iconClass} text-3xl text-black`}></i>,
              }))}
             size={demoSize}/>
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
                <BannerAlert
                  variant="info"
                  icon={<i className="ri-information-line text-xl"></i>}
                  message="春の新作コレクションが入荷しました"
                  dismissible
                  onDismiss={() => setShowInfoBanner(false)}
                 size={demoSize}/>
              )}
              {showPromoBanner && (
                <BannerAlert
                  variant="warning"
                  icon={<i className="ri-gift-line text-xl text-black"></i>}
                  message="¥10,000以上のご購入で送料無料"
                  dismissible
                  onDismiss={() => setShowPromoBanner(false)}
                 size={demoSize}/>
              )}
              {showAlertBanner && (
                <BannerAlert
                  variant="error"
                  icon={<i className="ri-error-warning-line text-xl text-black"></i>}
                  message="重要なお知らせ"
                  description="システムメンテナンスのため、3月20日 2:00-4:00の間、一時的にサービスをご利用いただけません。"
                  dismissible
                  onDismiss={() => setShowAlertBanner(false)}
                 size={demoSize}/>
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
                <Avatar alt="A" fallback="A" size="lg" className="text-xl" />
                <p
                  className="text-xs tracking-wider text-black/60"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  LARGE
                </p>
              </div>
              <div className="flex flex-col items-center gap-3">
                <Avatar alt="B" fallback="B" size={demoSize} className="text-base" />
                <p
                  className="text-xs tracking-wider text-black/60"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  MEDIUM
                </p>
              </div>
              <div className="flex flex-col items-center gap-3">
                <Avatar alt="C" fallback="C" size="sm" className="text-sm" />
                <p
                  className="text-xs tracking-wider text-black/60"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  SMALL
                </p>
              </div>
              <div className="flex flex-col items-center gap-3">
                <Avatar
                  alt="Avatar"
                  fallback=""
                  src="https://readdy.ai/api/search-image?query=professional%20elegant%20portrait%20photo%20clean%20white%20background%20soft%20natural%20lighting%20minimalist%20aesthetic%20high%20quality%20studio%20photography&width=100&height=100&seq=avatar1&orientation=squarish"
                  size={demoSize}
                />
                <p
                  className="text-xs tracking-wider text-black/60"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  WITH IMAGE
                </p>
              </div>
              <div className="flex flex-col items-center gap-3">
                <Avatar
                  alt="User"
                  fallback=""
                  icon={<i className="ri-user-line text-xl text-white"></i>}
                  size={demoSize}
                  status="online"
                />
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
              <Toolbar leftItems={toolbarPrimaryLeftItems} rightItems={toolbarPrimaryRightItems} splitIndex={3} size={demoSize} />
              <Toolbar variant="muted" leftItems={toolbarSecondaryLeftItems} rightItems={toolbarSecondaryRightItems} size={demoSize} />
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
                  <TagLabel variant="solid" size={demoSize}>NEW</TagLabel>
                  <TagLabel variant="outline" size={demoSize}>SALE</TagLabel>
                  <TagLabel variant="subtle" size={demoSize}>LIMITED</TagLabel>
                </div>
              </div>
              <div>
                <p className="text-xs tracking-widest mb-4 text-black/80" style={{ fontFamily: "acumin-pro, sans-serif" }}>
                  REMOVABLE TAGS
                </p>
                <div className="flex items-center gap-3 flex-wrap">
                  {removableTags.map((tag) => (
                    <TagLabel
                      key={tag}
                      variant="subtle"
                      removable
                      onRemove={() => setRemovableTags((prev) => prev.filter((t) => t !== tag))}
                     size={demoSize}>
                      {tag}
                    </TagLabel>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-xs tracking-widest mb-4 text-black/80" style={{ fontFamily: "acumin-pro, sans-serif" }}>
                  ROUNDED TAGS
                </p>
                <div className="flex items-center gap-3 flex-wrap">
                  <TagLabel variant="solid" rounded size={demoSize}>FEATURED</TagLabel>
                  <TagLabel variant="outline" rounded size={demoSize}>TRENDING</TagLabel>
                  <TagLabel variant="subtle" rounded size={demoSize}>POPULAR</TagLabel>
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
                className="absolute -top-1 -right-1"
              >
                <StatusBadge variant="count" count={3}  size={demoSize}/>
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
                className="absolute -top-1 -right-1"
              >
                <StatusBadge variant="count" count={12}  size={demoSize}/>
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
              <span className="absolute -top-1 -right-1"><StatusBadge variant="dot"  size={demoSize}/></span>
              </div>
              <div className="relative">
              <span
                className="text-sm text-black"
                style={{ fontFamily: "acumin-pro, sans-serif" }}
              >
                新着メッセージ
              </span>
              <span className="absolute -top-2 -right-6"><StatusBadge tone="positive" className="rounded-full px-2 py-0.5 text-[10px]" size={demoSize}>NEW</StatusBadge></span>
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
       size={demoSize}/>
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
        size={demoSize}
      />
      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} size={demoSize}>
        <div className="p-8">
          <div className="flex items-center justify-between mb-8">
            <h3
              className="text-2xl text-black tracking-tight"
              style={{ fontFamily: "Didot, serif" }}
            >
              Drawer Menu
            </h3>
            <Button
              variant="ghost"
              size={demoSize}
              className="aspect-square px-0 flex items-center justify-center hover:bg-[#f5f5f5] transition-colors cursor-pointer"
              onClick={() => setDrawerOpen(false)}
              aria-label="Close drawer"
            >
              <div className="w-5 h-5 flex items-center justify-center">
                <i className="ri-close-line text-xl"></i>
              </div>
            </Button>
          </div>
          <nav className="space-y-2">
            {['ITEM','LOOK','NEWS','ABOUT','STOCKIST','CONTACT'].map(label => (
              <Button
                key={label}
                variant="ghost"
                size={demoSize}
                className={cn('w-full justify-start text-left', navItemClassMap[demoSize])}
                style={{ fontFamily: "acumin-pro, sans-serif" }}
              >
                {label}
              </Button>
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
                <Button
                  key={icon}
                  variant="secondary"
                  size={demoSize}
                  className="aspect-square px-0"
                >
                  <div className="w-5 h-5 flex items-center justify-center">
                    <i className={`ri-${icon}-line text-xl`}></i>
                  </div>
                </Button>
              ))}
            </div>
          </div>
        </div>
      </Drawer>
    </main>
  );
}
