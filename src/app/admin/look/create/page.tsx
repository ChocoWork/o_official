'use client';

import Image from 'next/image';
import { useRef, useState } from 'react';

const SAMPLE_ITEMS = [
	{ name: 'Leather Tote Bag', price: '¥38,000' },
	{ name: 'Oversized Coat', price: '¥58,000' },
	{ name: 'Linen Blend Shirt', price: '¥24,800' },
	{ name: 'Cotton Knit Sweater', price: '¥22,000' },
	{ name: 'Wide Leg Trousers', price: '¥28,600' },
	{ name: 'Silk Blend Dress', price: '¥42,000' },
] as const;

export default function AdminLookCreatePage() {
	const now = new Date();
	const currentYear = now.getFullYear();
	const defaultSeason: 'SS' | 'AW' = now.getMonth() < 6 ? 'SS' : 'AW';
	const yearOptions = Array.from({ length: 4 }, (_, index) => currentYear - 1 + index);

	const [seasonYear, setSeasonYear] = useState<number>(currentYear);
	const [seasonType, setSeasonType] = useState<'SS' | 'AW'>(defaultSeason);
	const [imageFiles, setImageFiles] = useState<File[]>([]);
	const [previewUrls, setPreviewUrls] = useState<string[]>([]);
	const [isDragging, setIsDragging] = useState(false);
	const [submitError, setSubmitError] = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement | null>(null);

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

	return (
		<main className="pt-32 pb-20">
			<div className="max-w-4xl mx-auto px-6 lg:px-12">
				<form className="space-y-8">
					<div>
						<label className="block text-sm tracking-widest mb-2">シーズン</label>
						<div className="flex flex-wrap gap-3">
							<div className="relative min-w-[140px]">
								<select
									className="w-full px-4 py-3 pr-8 border border-black/20 text-sm focus:outline-none focus:border-black appearance-none cursor-pointer"
									value={seasonYear}
									onChange={(e) => setSeasonYear(Number(e.target.value))}
								>
									{yearOptions.map((year) => (
										<option key={year} value={year}>
											{year}
										</option>
									))}
								</select>
								<i className="ri-arrow-down-s-line absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none"></i>
							</div>
							<div className="relative min-w-[110px]">
								<select
									className="w-full px-4 py-3 pr-8 border border-black/20 text-sm focus:outline-none focus:border-black appearance-none cursor-pointer"
									value={seasonType}
									onChange={(e) => setSeasonType(e.target.value as 'SS' | 'AW')}
								>
									<option value="SS">SS</option>
									<option value="AW">AW</option>
								</select>
								<i className="ri-arrow-down-s-line absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none"></i>
							</div>
							<input type="hidden" name="season" value={`${seasonYear} ${seasonType}`} />
						</div>
					</div>

					<div>
						<label className="block text-sm tracking-widest mb-2">シーズンタイトル</label>
						<input
							className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black"
							placeholder="例: Effortless Elegance"
							required
							type="text"
						/>
					</div>

					<div>
						<label className="block text-sm tracking-widest mb-2">画像</label>
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
						<label className="block text-sm tracking-widest mb-4">紐づける商品を選択</label>
						<div className="grid grid-cols-2 md:grid-cols-3 gap-4">
							{SAMPLE_ITEMS.map((item) => (
								<div
									key={item.name}
									className="border cursor-pointer transition-all duration-300 border-black/20 hover:border-black"
								>
									<div className="aspect-[3/4] bg-[#f5f5f5] overflow-hidden relative">
										<Image
											src="/images/items/search-image.png"
											alt={item.name}
											fill
											sizes="(max-width: 768px) 50vw, 33vw"
											className="object-cover object-top"
										/>
									</div>
									<div className="p-3">
										<p className="text-xs text-black mb-1">{item.name}</p>
										<p className="text-xs text-[#474747]">{item.price}</p>
									</div>
								</div>
							))}
						</div>
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
