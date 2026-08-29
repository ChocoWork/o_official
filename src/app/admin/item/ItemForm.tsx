"use client";

import "@/app/admin/item/item-form.css";
import { useEffect, useRef, useState } from "react";
// preview images now handled by Card component
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button/Button";
import { ColorPicker } from "@/components/ui/ColorPicker/ColorPicker";
import { RadioButtonGroup } from "@/components/ui/RadioButtonGroup/RadioButtonGroup";
import { SingleSelect } from "@/components/ui/SingleSelect/SingleSelect";
import { MultiSelect } from "@/components/ui/MultiSelect/MultiSelect";
import { Card } from "@/components/ui/Card/Card";
import { TextAreaField } from "@/components/ui/TextAreaField/TextAreaField";
import { TextField } from "@/components/ui/TextField/TextField";
import { clientFetch } from "@/lib/client-fetch";
import {
  CATEGORIES,
  SIZES,
  ColorInput,
  ColorPresetResponse,
  ItemFormValues,
  ItemStatus,
} from "./types";

// FREQ-310: 全セクションで同じ見出し処理を繰り返す（反復）。フィールドラベルとの
// 対比はサイズではなく字間と罫線で作る（FREQ-291 で確立したこのプロジェクトの作法）。
const SECTION_TITLE_CLASS =
  "border-b border-black/10 pb-2 text-xs tracking-widest text-black/80 font-acumin";

// フォームのシェル。xl 未満は1カラム、xl 以上は左=画像 / 右=入力の2カラム。
// 4K でも行長が伸びすぎないよう 3xl で頭打ちにする。
const FORM_SHELL_CLASS =
  "mx-auto w-full max-w-4xl xl:max-w-6xl 3xl:max-w-7xl px-6 lg:px-12";

interface ItemFormProps {
  submitUrl: string;
  submitMethod: "POST" | "PUT";
  initialValues?: ItemFormValues;
  isLoading?: boolean;
}

export function ItemForm({
  submitUrl,
  submitMethod,
  initialValues,
  isLoading = false,
}: ItemFormProps) {
  const router = useRouter();

  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitSuccess, setSubmitSuccess] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>(
    initialValues?.category ?? CATEGORIES[0],
  );
  const [itemName, setItemName] = useState(initialValues?.name ?? "");
  const [price, setPrice] = useState(
    initialValues ? String(initialValues.price) : "",
  );
  const [description, setDescription] = useState(
    initialValues?.description ?? "",
  );
  const [status, setStatus] = useState<ItemStatus>(
    initialValues?.status ?? "private",
  );
  const [colors, setColors] = useState<ColorInput[]>(
    () =>
      (initialValues?.colors ?? []).map((c, i) => ({
        id: String(i + 1),
        name: c.name,
        hex: c.hex,
      })) || [{ id: "1", name: "", hex: "#000000" }],
  );
  const [savedColors, setSavedColors] = useState<ColorInput[]>([]);
  const [selectedSizes, setSelectedSizes] = useState<Set<string>>(
    new Set(initialValues?.sizes ?? []),
  );
  const [material, setMaterial] = useState(initialValues?.material ?? "");
  const [madeIn, setMadeIn] = useState(initialValues?.origin ?? "");
  const [care, setCare] = useState(initialValues?.care ?? "");
  const [productNote, setProductNote] = useState(
    initialValues?.productNote ?? "",
  );

  // load preview urls after mount or when initialValues change
  useEffect(() => {
    if (initialValues?.previewUrls) {
      setPreviewUrls(initialValues.previewUrls.slice());
    }
  }, [initialValues]);

  const fetchSavedColors = async () => {
    try {
      const response = await clientFetch("/api/admin/item-color-presets");
      if (!response.ok) {
        throw new Error("Failed to fetch color presets");
      }

      const json = await response.json();
      const presetList = (json?.data ?? []) as ColorPresetResponse[];
      setSavedColors(
        presetList.map((preset) => ({
          id: String(preset.id),
          name: preset.name,
          hex: preset.hex,
        })),
      );
    } catch (error) {
      console.error("Failed to load color presets:", error);
    }
  };

  useEffect(() => {
    void fetchSavedColors();
  }, []);

  const updateSelectedImage = (file: File) => {
    const supportedTypes = new Set([
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
    ]);
    if (!supportedTypes.has(file.type)) {
      setSubmitError("画像は JPEG / PNG / WebP / GIF を選択してください");
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      setSubmitError("画像サイズは5MB以下にしてください");
      return;
    }

    setSubmitError(null);

    const reader = new FileReader();
    reader.onload = () => {
      const loadedResult = reader.result;
      if (typeof loadedResult === "string") {
        setImageFiles((previousFiles) => [...previousFiles, file]);
        setPreviewUrls((previousUrls) => [...previousUrls, loadedResult]);
      }
    };
    reader.onerror = () => {
      setSubmitError("画像プレビューの読み込みに失敗しました");
    };
    reader.readAsDataURL(file);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (selected) {
      updateSelectedImage(selected);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) {
      updateSelectedImage(dropped);
    }
  };

  const removeImage = (index: number) => {
    setImageFiles((prev) => prev.filter((_, i) => i !== index));
    setPreviewUrls((prev) => prev.filter((_, i) => i !== index));
  };

  const handleColorChange = (
    id: string,
    field: "name" | "hex",
    value: string,
  ) => {
    setColors(
      colors.map((color) =>
        color.id === id ? { ...color, [field]: value } : color,
      ),
    );
  };

  const handleAddColor = () => {
    const newId = String(
      Math.max(...colors.map((c) => parseInt(c.id) || 0), 0) + 1,
    );
    setColors([...colors, { id: newId, name: "", hex: "#000000" }]);
  };

  const handleRemoveColor = (id: string) => {
    if (colors.length > 1) {
      setColors(colors.filter((color) => color.id !== id));
    }
  };

  const handleSaveColor = (color: ColorInput) => {
    const trimmedName = color.name.trim();
    if (!trimmedName) {
      setSubmitError("保存するカラー名を入力してください");
      return;
    }

    const exists = savedColors.some(
      (saved) => saved.hex === color.hex && saved.name === trimmedName,
    );

    if (exists) {
      window.alert("このカラー名と色の組み合わせは既に保存されています。");
      return;
    }

    void (async () => {
      try {
        const response = await clientFetch("/api/admin/item-color-presets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: trimmedName, hex: color.hex }),
        });

        const json = await response.json().catch(() => null);
        if (!response.ok) {
          setSubmitError(json?.error ?? "カラー保存に失敗しました");
          return;
        }

        const savedPreset = json?.data as ColorPresetResponse | undefined;
        if (savedPreset) {
          setSavedColors((previous) => {
            if (previous.some((entry) => entry.id === String(savedPreset.id))) {
              return previous;
            }

            return [
              {
                id: String(savedPreset.id),
                name: savedPreset.name,
                hex: savedPreset.hex,
              },
              ...previous,
            ];
          });
        }
      } catch (error) {
        console.error("Failed to save color preset:", error);
        setSubmitError("カラー保存に失敗しました");
      }
    })();
  };

  const handleApplySavedColor = (color: ColorInput) => {
    const newId = String(
      Math.max(...colors.map((c) => parseInt(c.id) || 0), 0) + 1,
    );
    setColors([...colors, { id: newId, name: color.name, hex: color.hex }]);
  };

  const handleRemoveSavedColor = (id: string) => {
    void (async () => {
      try {
        const response = await clientFetch(
          `/api/admin/item-color-presets/${id}`,
          {
            method: "DELETE",
          },
        );

        if (!response.ok) {
          throw new Error("Failed to delete color preset");
        }

        setSavedColors((previous) =>
          previous.filter((color) => color.id !== id),
        );
      } catch (error) {
        console.error("Failed to delete color preset:", error);
        setSubmitError("保存済みカラーの削除に失敗しました");
      }
    })();
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSubmitError(null);
    setSubmitSuccess(null);

    const trimmedName = itemName.trim();
    const trimmedDescription = description.trim();
    const parsedPrice = Number(price);
    const normalizedColors = colors
      .map((color) => ({ name: color.name.trim(), hex: color.hex }))
      .filter((color) => color.name.length > 0);
    const normalizedSizes = Array.from(selectedSizes);

    if (!trimmedName) {
      setSubmitError("商品名を入力してください");
      return;
    }

    if (!trimmedDescription) {
      setSubmitError("PRODUCT DETAILSを入力してください");
      return;
    }

    if (!Number.isInteger(parsedPrice) || parsedPrice < 0) {
      setSubmitError("価格は0以上の整数で入力してください");
      return;
    }

    if (previewUrls.length === 0 && imageFiles.length === 0) {
      setSubmitError("画像を1枚以上追加してください");
      return;
    }

    if (normalizedColors.length === 0) {
      setSubmitError("カラー名を1つ以上入力してください");
      return;
    }

    if (normalizedSizes.length === 0) {
      setSubmitError("サイズを1つ以上選択してください");
      return;
    }

    setIsSubmitting(true);

    try {
      const formData = new FormData();
      formData.append("name", trimmedName);
      formData.append("description", trimmedDescription);
      formData.append("price", String(parsedPrice));
      formData.append("category", category);
      formData.append("material", material.trim());
      formData.append("origin", madeIn.trim());
      formData.append("care", care.trim());
      formData.append("product_note", productNote.trim());
      formData.append("status", status);
      formData.append("sizes", JSON.stringify(normalizedSizes));
      formData.append("colors", JSON.stringify(normalizedColors));

      for (const file of imageFiles) {
        formData.append("images", file);
      }

      const response = await clientFetch(submitUrl, {
        method: submitMethod,
        body: formData,
      });

      const responseJson = await response.json().catch(() => null);
      if (!response.ok) {
        setSubmitError(responseJson?.error ?? "商品の保存に失敗しました");
        return;
      }

      setSubmitSuccess(
        submitMethod === "PUT" ? "商品を更新しました" : "商品を保存しました",
      );
      router.push("/admin?tab=ITEM");
    } catch (error) {
      console.error("Failed to submit item:", error);
      setSubmitError(
        "通信エラーが発生しました。時間をおいて再度お試しください",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="pb-20">
        <div className={`${FORM_SHELL_CLASS} text-center`}>読み込み中...</div>
      </div>
    );
  }

  const submitLabel = submitMethod === "PUT" ? "更新" : "保存";

  return (
    <div className="pb-20">
      <div className={FORM_SHELL_CLASS}>
        <form
          className="item-form grid gap-8 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] xl:items-start xl:gap-12 3xl:gap-16"
          onSubmit={handleSubmit}
        >
          {/* 左列：商品画像。xl 以上では入力欄をスクロールしても見えるよう追従させる */}
          <section
            data-testid="item-form-media"
            className="item-form__fields xl:sticky xl:top-[var(--site-header-height)]">
            <h2 className={SECTION_TITLE_CLASS}>商品画像</h2>
            {previewUrls.length > 0 && (
              <Card
                previewUrls={previewUrls}
                onRemovePreview={removeImage}
                className="p-0 border-0"
              />
            )}
            <div
              role="button"
              tabIndex={0}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              className={`w-full border border-black/20 text-sm px-4 py-10 text-center cursor-pointer transition-colors ${
                isDragging ? "border-black bg-black/5" : "bg-white"
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                onChange={handleFileSelect}
                className="hidden"
              />
              <div className="space-y-2">
                <p className="text-sm tracking-widest">
                  画像をドラッグ&ドロップ
                </p>
                <p className="text-xs text-black/70">
                  またはクリックしてファイルを追加（JPEG / PNG / WebP /
                  GIF、5MB以下）
                </p>
              </div>
            </div>
          </section>

          {/* 右列：入力。セクション間 > グループ間 > フィールド間 の3段で近接を作る */}
          <div className="item-form__sections min-w-0" data-testid="item-form-fields">
            <section className="item-form__fields">
              <h2 className={SECTION_TITLE_CLASS}>基本情報</h2>

              <TextField
                required
                label="商品名"
                placeholder="商品名を入力"
                type="text"
                value={itemName}
                onChange={(e) => setItemName(e.target.value)}
                size="md"
              />

              <div className="item-form__pair">
                <SingleSelect
                  label="カテゴリー"
                  variant="dropdown"
                  options={CATEGORIES.map((itemCategory) => ({
                    value: itemCategory,
                    label: itemCategory,
                  }))}
                  value={category}
                  onValueChange={(val) =>
                    setCategory(val as (typeof CATEGORIES)[number])
                  }
                  className="font-acumin"
                  size="md"
                />

                <TextField
                  required
                  label="価格（円）"
                  placeholder="価格を入力"
                  type="number"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  size="md"
                />
              </div>
            </section>

            <section className="item-form__fields">
              <h2 className={SECTION_TITLE_CLASS}>商品説明</h2>

              <TextAreaField
                label="PRODUCT DETAILS"
                placeholder="PRODUCT DETAILSを入力"
                rows={4}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                required
                size="md"
              />
            </section>

            <section className="item-form__group">
              <h2 className={SECTION_TITLE_CLASS}>バリエーション</h2>

              <div className="item-form__group">
                <div className="space-y-2">
                  <span className="block text-xs tracking-widest text-black/80">
                    カラー
                  </span>
                  {colors.map((color) => (
                    <div
                      key={color.id}
                      className="flex flex-wrap gap-3 items-end"
                    >
                      <TextField
                        className="w-full sm:w-auto sm:flex-1"
                        placeholder="カラー名"
                        type="text"
                        value={color.name}
                        onChange={(e) =>
                          handleColorChange(color.id, "name", e.target.value)
                        }
                        size="md"
                      />
                      <ColorPicker
                        value={color.hex}
                        onChange={(e) =>
                          handleColorChange(color.id, "hex", e.target.value)
                        }
                        aria-label="カラーを選択"
                        size="md"
                      />
                      <Button
                        type="button"
                        onClick={() => handleSaveColor(color)}
                        variant="secondary"
                        size="md"
                      >
                        保存
                      </Button>
                      {colors.length > 1 && (
                        <Button
                          type="button"
                          onClick={() => handleRemoveColor(color.id)}
                          variant="danger"
                          size="md"
                        >
                          削除
                        </Button>
                      )}
                    </div>
                  ))}
                  <Button
                    type="button"
                    onClick={handleAddColor}
                    variant="secondary"
                    size="md"
                  >
                    カラーを追加
                  </Button>
                </div>

                {savedColors.length > 0 && (
                  <div>
                    <p className="text-xs tracking-widest mb-3">
                      保存済みカラー
                    </p>
                    <div className="flex flex-wrap gap-3">
                      {savedColors.map((color) => (
                        <div key={color.id} className="relative w-10 h-10">
                          <Button
                            type="button"
                            onClick={() => handleApplySavedColor(color)}
                            variant="ghost"
                            size="md"
                            className="relative h-10 w-10 rounded-full border-2 border-black/20 overflow-hidden p-0"
                            aria-label={`保存済みカラー ${color.name || color.hex}`}
                          >
                            <span
                              className="absolute inset-0"
                              style={{ backgroundColor: color.hex }}
                            />
                          </Button>
                          <Button
                            type="button"
                            onClick={() => handleRemoveSavedColor(color.id)}
                            size="md"
                            className="absolute -top-1 -right-1 h-5 w-5 rounded-full p-0 text-2.5"
                            aria-label="保存済みカラーを削除"
                          >
                            <i className="ri-close-line text-xs" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <MultiSelect
                label="サイズ（複数選択可能）"
                variant="buttons"
                options={SIZES.map((s) => ({ value: s, label: s }))}
                values={Array.from(selectedSizes)}
                onChange={(vals) => setSelectedSizes(new Set(vals))}
                size="md"
              />
            </section>

            <section className="item-form__fields">
              <h2 className={SECTION_TITLE_CLASS}>商品仕様</h2>

              <div className="item-form__pair">
                <TextField
                  label="MATERIAL（素材）"
                  placeholder="例: Wool 100%"
                  type="text"
                  value={material}
                  onChange={(e) => setMaterial(e.target.value)}
                  size="md"
                />

                <TextField
                  label="CARE（お手入れ方法）"
                  placeholder="例: ドライクリーニング"
                  type="text"
                  value={care}
                  onChange={(e) => setCare(e.target.value)}
                  size="md"
                />

                <TextField
                  label="PRODUCT NOTE（商品の注意書き）"
                  placeholder="例: 素材の特性上、摩擦により毛羽立ちが生じる場合があります。"
                  type="text"
                  value={productNote}
                  onChange={(e) => setProductNote(e.target.value)}
                  size="md"
                />

                <TextField
                  label="MADE IN（生産国）"
                  placeholder="例: Japan"
                  type="text"
                  value={madeIn}
                  onChange={(e) => setMadeIn(e.target.value)}
                  size="md"
                />
              </div>
            </section>

            <section className="item-form__fields">
              <h2 className={SECTION_TITLE_CLASS}>公開設定</h2>

              <RadioButtonGroup
                label="ステータス"
                name="status"
                value={status}
                onChange={(value) => setStatus(value as ItemStatus)}
                options={[
                  { value: "private", label: "非公開" },
                  { value: "published", label: "公開" },
                ]}
                size="md"
              />
            </section>

            {/* 主要 CTA。フォームが縦に長い xl 以上では末尾に貼り付けて常に見えるようにする（対比） */}
            <div className="item-form__fields xl:sticky xl:bottom-0 xl:border-t xl:border-black/10 xl:bg-white xl:py-4">
              {submitSuccess && (
                <p className="text-sm text-black" role="status">
                  {submitSuccess}
                </p>
              )}

              {submitError && (
                <p className="text-sm text-red-600" role="alert">
                  {submitError}
                </p>
              )}

              <div className="flex gap-4">
                <Button
                  type="button"
                  onClick={() => router.push("/admin?tab=ITEM")}
                  disabled={isSubmitting}
                  variant="secondary"
                  size="md"
                >
                  キャンセル
                </Button>
                <Button type="submit" disabled={isSubmitting} size="md">
                  {isSubmitting ? `${submitLabel}中...` : submitLabel}
                </Button>
              </div>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
