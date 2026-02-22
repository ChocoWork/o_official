'use client';

import { useRef, useState } from 'react';
import Image from 'next/image';

const CATEGORIES = ['TOPS', 'BOTTOMS', 'OUTERWEAR', 'ACCESSORIES'] as const;
const SIZES = ['S', 'M', 'L', 'FREE'] as const;

interface ColorInput {
	id: string;
	name: string;
	hex: string;
}

export default function AdminItemCreatePage() {
	const [imageFiles, setImageFiles] = useState<File[]>([]);
	const [previewUrls, setPreviewUrls] = useState<string[]>([]);
	const [isDragging, setIsDragging] = useState(false);
	const [submitError, setSubmitError] = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement | null>(null);

	const [colors, setColors] = useState<ColorInput[]>([
		{ id: '1', name: '', hex: '#000000' }
	]);
	const [savedColors, setSavedColors] = useState<ColorInput[]>([]);
	const [selectedSizes, setSelectedSizes] = useState<Set<string>>(new Set());
	const [productDetails, setProductDetails] = useState<string>('Material : \nMade in : ');

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
			if (typeof reader.result === 'string') {
				setImageFiles([...imageFiles, file]);
				setPreviewUrls([...previewUrls, reader.result]);
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
		const exists = savedColors.some(
			(saved) => saved.hex === color.hex && saved.name === trimmedName
		);

		if (!exists) {
			const newId = String(Date.now());
			setSavedColors([...savedColors, { id: newId, name: trimmedName, hex: color.hex }]);
		}
	};

	const handleApplySavedColor = (color: ColorInput) => {
		const newId = String(Math.max(...colors.map(c => parseInt(c.id) || 0), 0) + 1);
		setColors([...colors, { id: newId, name: color.name, hex: color.hex }]);
	};

	const handleRemoveSavedColor = (id: string) => {
		setSavedColors(savedColors.filter((color) => color.id !== id));
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

	return (
		<main className="pt-32 pb-20">
			<div className="max-w-4xl mx-auto px-6 lg:px-12">
				<form className="space-y-8">
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
									<button
										type="button"
										onClick={() => removeImage(index)}
										className="absolute top-2 right-2 w-8 h-8 bg-black text-white flex items-center justify-center text-xs hover:bg-[#474747] transition-colors"
									>
										×
									</button>
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
						<div className="relative">
							<select className="w-full px-4 py-3 pr-8 border border-black/20 text-sm focus:outline-none focus:border-black appearance-none cursor-pointer">
								{CATEGORIES.map((category) => (
									<option key={category} value={category}>
										{category}
									</option>
								))}
							</select>
							<i className="ri-arrow-down-s-line absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none"></i>
						</div>
					</div>

					<div>
						<label className="block text-sm tracking-widest mb-2">商品名</label>
						<input
							className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black"
							required
							type="text"
						/>
					</div>

					<div>
						<label className="block text-sm tracking-widest mb-2">価格（円）</label>
						<input
							className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black"
							required
							type="number"
						/>
					</div>

					<div>
						<label className="block text-sm tracking-widest mb-2">商品情報</label>
						<textarea
							rows={4}
							className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black resize-none"
							required
						/>
					</div>

					<div>
						<label className="block text-sm tracking-widest mb-4">カラー</label>
						<div className="space-y-4 mb-4">
							{colors.map((color) => (
								<div key={color.id} className="flex gap-3 items-end">
									<input
										className="flex-1 px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black"
										placeholder="カラー名"
										type="text"
										value={color.name}
										onChange={(e) => handleColorChange(color.id, 'name', e.target.value)}
									/>
									<label className="relative w-12 h-12 rounded-full border-2 border-black/20 cursor-pointer overflow-hidden">
										<span
											className="absolute inset-0"
											style={{ backgroundColor: color.hex }}
										/>
										<input
											type="color"
											value={color.hex}
											onChange={(e) => handleColorChange(color.id, 'hex', e.target.value)}
											className="absolute inset-0 opacity-0 cursor-pointer"
											aria-label="カラーを選択"
										/>
									</label>
									<button
										type="button"
										onClick={() => handleSaveColor(color)}
										className="px-3 py-2 border border-black text-black text-xs tracking-widest hover:bg-black hover:text-white transition-all"
									>
										保存
									</button>
									{colors.length > 1 && (
										<button
											type="button"
											onClick={() => handleRemoveColor(color.id)}
											className="px-3 py-2 border border-red-500 text-red-500 text-xs tracking-widest hover:bg-red-500 hover:text-white transition-all"
										>
											削除
										</button>
									)}
								</div>
							))}
						</div>
						<button
							type="button"
							onClick={handleAddColor}
							className="px-6 py-2 border border-black text-black text-xs tracking-widest hover:bg-black hover:text-white transition-all duration-300 cursor-pointer whitespace-nowrap"
						>
							カラーを追加
						</button>
						{savedColors.length > 0 && (
							<div className="mt-6">
								<p className="text-xs tracking-widest mb-3">保存済みカラー</p>
								<div className="flex flex-wrap gap-3">
									{savedColors.map((color) => (
										<div key={color.id} className="relative w-10 h-10">
											<button
												type="button"
												onClick={() => handleApplySavedColor(color)}
												className="relative w-10 h-10 rounded-full border-2 border-black/20 overflow-hidden"
												aria-label={`保存済みカラー ${color.name || color.hex}`}
											>
												<span
													className="absolute inset-0"
													style={{ backgroundColor: color.hex }}
												/>
											</button>
											<button
												type="button"
												onClick={() => handleRemoveSavedColor(color.id)}
												className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-black text-white text-[10px] leading-none flex items-center justify-center"
												aria-label="保存済みカラーを削除"
											>
												×
											</button>
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
						<textarea
							rows={6}
							className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black resize-none"
							value={productDetails}
							onChange={(e) => setProductDetails(e.target.value)}
							required
						/>
					</div>

					<div>
						<label className="block text-sm tracking-widest mb-2">ステータス</label>
						<div className="flex gap-4">
							<label className="flex items-center gap-2 cursor-pointer">
								<input className="cursor-pointer" type="radio" name="status" value="draft" defaultChecked />
								<span className="text-sm">非公開</span>
							</label>
							<label className="flex items-center gap-2 cursor-pointer">
								<input className="cursor-pointer" type="radio" name="status" value="published" />
								<span className="text-sm">公開</span>
							</label>
						</div>
					</div>

					{submitError && (
						<p className="text-sm text-red-600" role="alert">
							{submitError}
						</p>
					)}

					<div className="flex gap-4">
						<button
							type="button"
							className="px-8 py-3 border border-black text-black text-sm tracking-widest hover:bg-black hover:text-white transition-all duration-300 cursor-pointer whitespace-nowrap"
						>
							キャンセル
						</button>
						<button
							type="submit"
							className="px-8 py-3 bg-black text-white text-sm tracking-widest hover:bg-[#474747] transition-all duration-300 cursor-pointer whitespace-nowrap disabled:opacity-50"
						>
							保存
						</button>
					</div>
				</form>
			</div>
		</main>
	);
}
