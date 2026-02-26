'use client';

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { Button } from '@/app/components/ui/Button';
import { ColorPicker } from '@/app/components/ui/ColorPicker';
import { RadioButtonGroup } from '@/app/components/ui/RadioButtonGroup';
import { SingleSelect } from '@/app/components/ui/SingleSelect';
import { TextAreaField } from '@/app/components/ui/TextAreaField';
import { TextField } from '@/app/components/ui/TextField';
import { clientFetch } from '@/lib/client-fetch';

const CATEGORIES = ['TOPS', 'BOTTOMS', 'OUTERWEAR', 'ACCESSORIES'] as const;
const SIZES = ['S', 'M', 'L', 'FREE'] as const;

interface ColorInput {
	id: string;
	name: string;
	hex: string;
}

type ColorPresetResponse = {
	id: number;
	name: string;
	hex: string;
	created_at: string;
};

export default function AdminItemCreatePage() {
	const router = useRouter();
	const [imageFiles, setImageFiles] = useState<File[]>([]);
	const [previewUrls, setPreviewUrls] = useState<string[]>([]);
	const [isDragging, setIsDragging] = useState(false);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [submitSuccess, setSubmitSuccess] = useState<string | null>(null);
	const [submitError, setSubmitError] = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const [category, setCategory] = useState<(typeof CATEGORIES)[number]>('TOPS');
	const [itemName, setItemName] = useState('');
	const [price, setPrice] = useState('');
	const [description, setDescription] = useState('');
	const [status, setStatus] = useState<'private' | 'published'>('private');

	const [colors, setColors] = useState<ColorInput[]>([
		{ id: '1', name: '', hex: '#000000' }
	]);
	const [savedColors, setSavedColors] = useState<ColorInput[]>([]);
	const [selectedSizes, setSelectedSizes] = useState<Set<string>>(new Set());
	const [productDetails, setProductDetails] = useState<string>('Material : \nMade in : ');

	const fetchSavedColors = async () => {
		try {
			const response = await clientFetch('/api/admin/item-color-presets');
			if (!response.ok) {
				throw new Error('Failed to fetch color presets');
			}

			const json = await response.json();
			const presetList = (json?.data ?? []) as ColorPresetResponse[];
			setSavedColors(
				presetList.map((preset) => ({
					id: String(preset.id),
					name: preset.name,
					hex: preset.hex,
				}))
			);
		} catch (error) {
			console.error('Failed to load color presets:', error);
		}
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

	const updateSelectedImage = (file: File) => {
		const supportedTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
		if (!supportedTypes.has(file.type)) {
			setSubmitError('画像は JPEG / PNG / WebP / GIF を選択してください');
			return;
		}

		if (file.size > 5 * 1024 * 1024) {
			setSubmitError('画像サイズは5MB以下にしてください');
			return;
		}

		setSubmitError(null);

		const reader = new FileReader();
		reader.onload = () => {
			const loadedResult = reader.result;
			if (typeof loadedResult === 'string') {
				setImageFiles((previousFiles) => [...previousFiles, file]);
				setPreviewUrls((previousUrls) => [...previousUrls, loadedResult]);
			}
		};
		reader.onerror = () => {
			setSubmitError('画像プレビューの読み込みに失敗しました');
		};
		reader.readAsDataURL(file);
	};

	const removeImage = (index: number) => {
		setImageFiles(imageFiles.filter((_, i) => i !== index));
		setPreviewUrls(previewUrls.filter((_, i) => i !== index));
	};

	const handleColorChange = (id: string, field: 'name' | 'hex', value: string) => {
		setColors(colors.map(color =>
			color.id === id ? { ...color, [field]: value } : color
		));
	};

	const handleAddColor = () => {
		const newId = String(Math.max(...colors.map(c => parseInt(c.id) || 0), 0) + 1);
		setColors([...colors, { id: newId, name: '', hex: '#000000' }]);
	};

	const handleRemoveColor = (id: string) => {
		if (colors.length > 1) {
			setColors(colors.filter(color => color.id !== id));
		}
	};

	const handleSaveColor = (color: ColorInput) => {
		const trimmedName = color.name.trim();
		if (!trimmedName) {
			setSubmitError('保存するカラー名を入力してください');
			return;
		}

		const exists = savedColors.some(
			(saved) => saved.hex === color.hex && saved.name === trimmedName
		);

		if (exists) {
			window.alert('このカラー名と色の組み合わせは既に保存されています。');
			return;
		}

		void (async () => {
			try {
				const response = await clientFetch('/api/admin/item-color-presets', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ name: trimmedName, hex: color.hex }),
				});

				const json = await response.json().catch(() => null);
				if (!response.ok) {
					setSubmitError(json?.error ?? 'カラー保存に失敗しました');
					return;
				}

				const savedPreset = json?.data as ColorPresetResponse | undefined;
				if (savedPreset) {
					setSavedColors((previous) => {
						if (previous.some((entry) => entry.id === String(savedPreset.id))) {
							return previous;
						}

						return [
							{ id: String(savedPreset.id), name: savedPreset.name, hex: savedPreset.hex },
							...previous,
						];
					});
				}
			} catch (error) {
				console.error('Failed to save color preset:', error);
				setSubmitError('カラー保存に失敗しました');
			}
		})();
	};

	const handleApplySavedColor = (color: ColorInput) => {
		const newId = String(Math.max(...colors.map(c => parseInt(c.id) || 0), 0) + 1);
		setColors([...colors, { id: newId, name: color.name, hex: color.hex }]);
	};

	const handleRemoveSavedColor = (id: string) => {
		void (async () => {
			try {
				const response = await clientFetch(`/api/admin/item-color-presets/${id}`, {
					method: 'DELETE',
				});

				if (!response.ok) {
					throw new Error('Failed to delete color preset');
				}

				setSavedColors((previous) => previous.filter((color) => color.id !== id));
			} catch (error) {
				console.error('Failed to delete color preset:', error);
				setSubmitError('保存済みカラーの削除に失敗しました');
			}
		})();
	};

	const handleSizeToggle = (size: string) => {
		const newSizes = new Set(selectedSizes);
		if (newSizes.has(size)) {
			newSizes.delete(size);
		} else {
			newSizes.add(size);
		}
		setSelectedSizes(newSizes);
	};

	const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		setSubmitError(null);
		setSubmitSuccess(null);

		const trimmedName = itemName.trim();
		const trimmedDescription = description.trim();
		const trimmedDetails = productDetails.trim();
		const parsedPrice = Number(price);
		const normalizedColors = colors
			.map((color) => ({ name: color.name.trim(), hex: color.hex }))
			.filter((color) => color.name.length > 0);
		const normalizedSizes = Array.from(selectedSizes);

		if (!trimmedName) {
			setSubmitError('商品名を入力してください');
			return;
		}

		if (!trimmedDescription) {
			setSubmitError('商品情報を入力してください');
			return;
		}

		if (!Number.isInteger(parsedPrice) || parsedPrice < 0) {
			setSubmitError('価格は0以上の整数で入力してください');
			return;
		}

		if (imageFiles.length === 0) {
			setSubmitError('画像を1枚以上追加してください');
			return;
		}

		if (normalizedColors.length === 0) {
			setSubmitError('カラー名を1つ以上入力してください');
			return;
		}

		if (normalizedSizes.length === 0) {
			setSubmitError('サイズを1つ以上選択してください');
			return;
		}

		if (!trimmedDetails) {
			setSubmitError('PRODUCT DETAILSを入力してください');
			return;
		}

		setIsSubmitting(true);

		try {
			const formData = new FormData();
			formData.append('name', trimmedName);
			formData.append('description', trimmedDescription);
			formData.append('price', String(parsedPrice));
			formData.append('category', category);
			formData.append('productDetails', trimmedDetails);
			formData.append('status', status);
			formData.append('sizes', JSON.stringify(normalizedSizes));
			formData.append('colors', JSON.stringify(normalizedColors));

			for (const file of imageFiles) {
				formData.append('images', file);
			}

			const response = await clientFetch('/api/admin/items', {
				method: 'POST',
				body: formData,
			});

			const responseJson = await response.json().catch(() => null);
			if (!response.ok) {
				setSubmitError(responseJson?.error ?? '商品の保存に失敗しました');
				return;
			}

			setSubmitSuccess('商品を保存しました');
			router.push('/admin?tab=ITEM');
		} catch (error) {
			console.error('Failed to submit item:', error);
			setSubmitError('通信エラーが発生しました。時間をおいて再度お試しください');
		} finally {
			setIsSubmitting(false);
		}
	};

	useEffect(() => {
		void fetchSavedColors();
	}, []);

	return (
		<main className="pt-32 pb-20">
			<div className="max-w-4xl mx-auto px-6 lg:px-12">
				<form className="space-y-8" onSubmit={handleSubmit}>
					<div>
						<label className="block text-sm tracking-widest mb-4">商品画像</label>
						<div className="grid grid-cols-2 gap-4 mb-6">
							{previewUrls.map((url, index) => (
								<div key={index} className="relative aspect-[3/4] bg-[#f5f5f5] overflow-hidden border border-black/20">
									<Image
										src={url}
										alt={`プレビュー ${index + 1}`}
										fill
										className="w-full h-full object-cover object-center"
										unoptimized
									/>
									<Button
										type="button"
										onClick={() => removeImage(index)}
										size="sm"
										className="absolute top-2 right-2 h-8 w-8 p-0"
									>
										×
									</Button>
								</div>
							))}
						</div>
						<div
							role="button"
							tabIndex={0}
							onClick={() => fileInputRef.current?.click()}
							onKeyDown={(e) => {
								if (e.key === 'Enter' || e.key === ' ') {
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
								isDragging ? 'border-black bg-black/5' : 'bg-white'
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
								<p className="text-sm tracking-widest">画像をドラッグ&ドロップ</p>
								<p className="text-xs text-black/70">またはクリックしてファイルを追加（JPEG / PNG / WebP / GIF、5MB以下）</p>
							</div>
						</div>
					</div>

					<div>
						<label className="block text-sm tracking-widest mb-2">カテゴリー</label>
						<SingleSelect
							value={category}
							onChange={(e) => setCategory(e.target.value as (typeof CATEGORIES)[number])}
							options={CATEGORIES.map((option) => ({ value: option, label: option }))}
						/>
					</div>

					<div>
						<label className="block text-sm tracking-widest mb-2">商品名</label>
						<TextField required type="text" value={itemName} onChange={(e) => setItemName(e.target.value)} />
					</div>

					<div>
						<label className="block text-sm tracking-widest mb-2">価格（円）</label>
						<TextField required type="number" value={price} onChange={(e) => setPrice(e.target.value)} />
					</div>

					<div>
						<label className="block text-sm tracking-widest mb-2">商品情報</label>
						<TextAreaField rows={4} value={description} onChange={(e) => setDescription(e.target.value)} required />
					</div>

					<div>
						<label className="block text-sm tracking-widest mb-4">カラー</label>
						<div className="space-y-4 mb-4">
							{colors.map((color) => (
								<div key={color.id} className="flex gap-3 items-end">
									<TextField
										className="flex-1"
										placeholder="カラー名"
										type="text"
										value={color.name}
										onChange={(e) => handleColorChange(color.id, 'name', e.target.value)}
									/>
									<ColorPicker
										value={color.hex}
										onChange={(e) => handleColorChange(color.id, 'hex', e.target.value)}
										aria-label="カラーを選択"
									/>
									<Button
										type="button"
										onClick={() => handleSaveColor(color)}
										variant="secondary"
										size="sm"
									>
										保存
									</Button>
									{colors.length > 1 && (
										<Button
											type="button"
											onClick={() => handleRemoveColor(color.id)}
											variant="danger"
											size="sm"
										>
											削除
										</Button>
									)}
								</div>
							))}
						</div>
						<Button
							type="button"
							onClick={handleAddColor}
							variant="secondary"
							size="sm"
						>
							カラーを追加
						</Button>
						{savedColors.length > 0 && (
							<div className="mt-6">
								<p className="text-xs tracking-widest mb-3">保存済みカラー</p>
								<div className="flex flex-wrap gap-3">
									{savedColors.map((color) => (
										<div key={color.id} className="relative w-10 h-10">
											<Button
												type="button"
												onClick={() => handleApplySavedColor(color)}
												variant="ghost"
												size="sm"
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
												size="sm"
												className="absolute -top-1 -right-1 h-5 w-5 rounded-full p-0 text-[10px]"
												aria-label="保存済みカラーを削除"
											>
												×
											</Button>
										</div>
									))}
								</div>
							</div>
						)}
					</div>

					<div>
						<label className="block text-sm tracking-widest mb-4">サイズ（複数選択可能）</label>
						<div className="flex gap-3 flex-wrap">
							{SIZES.map((size) => (
								<button
									key={size}
									type="button"
									onClick={() => handleSizeToggle(size)}
									className={`px-6 py-2 text-xs tracking-widest transition-all duration-300 cursor-pointer whitespace-nowrap border ${
										selectedSizes.has(size)
											? 'border-black bg-black text-white'
											: 'border-black text-black hover:bg-black hover:text-white'
									}`}
								>
									{size}
								</button>
							))}
						</div>
					</div>

					<div>
						<label className="block text-sm tracking-widest mb-2">PRODUCT DETAILS（素材・洗濯の情報）</label>
						<TextAreaField rows={6} value={productDetails} onChange={(e) => setProductDetails(e.target.value)} required />
					</div>

					<div>
						<label className="block text-sm tracking-widest mb-2">ステータス</label>
						<RadioButtonGroup
							name="status"
							value={status}
							onChange={(value) => setStatus(value as 'private' | 'published')}
							options={[
								{ value: 'private', label: '非公開' },
								{ value: 'published', label: '公開' },
							]}
						/>
					</div>

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
							onClick={() => router.push('/admin?tab=ITEM')}
							disabled={isSubmitting}
							variant="secondary"
						>
							キャンセル
						</Button>
						<Button
							type="submit"
							disabled={isSubmitting}
						>
							{isSubmitting ? '保存中...' : '保存'}
						</Button>
					</div>
				</form>
			</div>
		</main>
	);
}
