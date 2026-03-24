"use client";

import React from 'react';
import Image from 'next/image';
import { useSearchParams } from 'next/navigation';
import { useLogin } from '@/components/LoginContext';
import { Button } from '@/components/ui/Button';
import { TabSegmentControl } from '@/components/ui/TabSegmentControl';
import { TextField } from '@/components/ui/TextField';

type AccountTab = 'profile' | 'orders' | 'address';

type SavedContact = {
	fullName: string;
	phone: string;
};

export default function Page() {
	const { isLoggedIn, isAuthResolved } = useLogin();
	const searchParams = useSearchParams();
	const tabParam = searchParams.get('tab') as AccountTab | null;
	const [activeTab, setActiveTab] = React.useState<AccountTab>(tabParam && ['profile', 'orders', 'address'].includes(tabParam) ? tabParam : 'profile');
	const [savedContact, setSavedContact] = React.useState<SavedContact | null>(null);
	const [isEditingProfile, setIsEditingProfile] = React.useState(false);
	const [profileForm, setProfileForm] = React.useState<SavedContact>({
		fullName: '',
		phone: '',
	});
	const [isLoadingProfile, setIsLoadingProfile] = React.useState(true);
	const [addressForm, setAddressForm] = React.useState({
		postalCode: '',
		prefecture: '',
		city: '',
		address: '',
		building: '',
	});

	React.useEffect(() => {
		if (tabParam && ['profile', 'orders', 'address'].includes(tabParam)) {
			setActiveTab(tabParam);
		}
	}, [tabParam]);

	React.useEffect(() => {
		if (!isLoggedIn || !isAuthResolved) {
			setIsLoadingProfile(false);
			return;
		}

		const fetchProfile = async () => {
			try {
				const res = await fetch('/api/profile');
				if (!res.ok) {
					setIsLoadingProfile(false);
					return;
				}
				const data = await res.json();
				const normalized: SavedContact = {
					fullName: typeof data.fullName === 'string' ? data.fullName : '',
					phone: typeof data.phone === 'string' ? data.phone : '',
				};

				if (normalized.fullName || normalized.phone) {
					setSavedContact(normalized);
					setProfileForm(normalized);
				}
			} catch (err) {
				console.error('Failed to fetch profile:', err);
			} finally {
				setIsLoadingProfile(false);
			}
		};

		fetchProfile();
	}, [isLoggedIn, isAuthResolved]);

	const handleProfileFormChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const { name, value } = e.target;
		setProfileForm((prev) => ({ ...prev, [name]: value }));
	};

	const handleProfileSave = async (e: React.FormEvent) => {
		e.preventDefault();
		const normalized: SavedContact = {
			fullName: profileForm.fullName.trim(),
			phone: profileForm.phone.trim(),
		};

		if (!normalized.fullName && !normalized.phone) {
			await handleProfileDelete();
			return;
		}

		try {
			const res = await fetch('/api/profile', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(normalized),
			});

			if (!res.ok) {
				console.error('Failed to save profile');
				return;
			}

			setSavedContact(normalized);
			setProfileForm(normalized);
			setIsEditingProfile(false);
		} catch (err) {
			console.error('Profile save error:', err);
		}
	};

	const handleProfileDelete = async () => {
		try {
			const res = await fetch('/api/profile', { method: 'DELETE' });
			if (!res.ok) {
				console.error('Failed to delete profile');
				return;
			}
			setSavedContact(null);
			setProfileForm({ fullName: '', phone: '' });
			setIsEditingProfile(false);
		} catch (err) {
			console.error('Profile delete error:', err);
		}
	};

	const handleAddressChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const { name, value } = e.target;
		setAddressForm(prev => ({ ...prev, [name]: value }));

		// 郵便番号自動補完
		if (name === 'postalCode') {
			const cleanedZip = value.replace(/[^0-9]/g, '');
			if (cleanedZip.length === 7) {
				fetch(`https://zipcloud.ibsnet.co.jp/api/search?zipcode=${cleanedZip}`)
					.then(res => res.json())
					.then(data => {
						if (data.status === 200 && data.results) {
							const result = data.results[0];
							setAddressForm(prev => ({
								...prev,
								prefecture: result.address1 || prev.prefecture,
								city: result.address2 || prev.city,
								address: result.address3 || prev.address,
							}));
						}
					})
					.catch(err => console.error('郵便番号検索エラー:', err));
			}
		}
	};

	if (!isAuthResolved) {
		return (
			<main className="pt-32 pb-20 px-6 lg:px-12">
				<div className="max-w-3xl mx-auto text-center">
					<p className="text-lg text-[#474747] mb-8 font-brand">読み込み中...</p>
				</div>
			</main>
		);
	}

	if (isLoggedIn) {
		return (
			<main className="pt-32 pb-20 px-6 lg:px-12">
				<div className="max-w-7xl mx-auto">
					<div className="grid grid-cols-1 lg:grid-cols-4 gap-12">
						<div className="lg:col-span-1">
							<TabSegmentControl
								items={[
									{ key: 'profile', label: 'プロフィール' },
									{ key: 'orders', label: '購入履歴' },
									{ key: 'address', label: '配送先住所' },
								]}
								activeKey={activeTab}
								onChange={(tab) => setActiveTab(tab as AccountTab)}
								orientation="vertical"
								size="md"
								className='space-y-2'
							/>
						</div>
						<div className="lg:col-span-3">
							{activeTab === 'profile' && (
								<div>
									<div className="space-y-6">
										<div>
											<label
												className="block text-xs text-[#474747] mb-2 tracking-wider"
												style={{ fontFamily: 'acumin-pro, sans-serif' }}
											>
												メールアドレス
											</label>
											<TextField
												className="w-full px-4 py-3 border border-black/20 text-sm bg-[#f5f5f5] text-[#474747]"
												type="email"
												value="demo@gmail.com"
												readOnly
												style={{ fontFamily: 'acumin-pro, sans-serif' }}
												size="md"
											/>
										</div>

										{isLoadingProfile && (
											<p className="text-xs text-[#474747]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>読み込み中...</p>
										)}

										{savedContact && !isEditingProfile && (
											<div className="border border-black/10 p-6 space-y-4">
												<div>
													<p className="text-xs text-[#474747] mb-1 tracking-wider" style={{ fontFamily: 'acumin-pro, sans-serif' }}>氏名</p>
													<p className="text-sm text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>{savedContact.fullName}</p>
												</div>
												<div>
													<p className="text-xs text-[#474747] mb-1 tracking-wider" style={{ fontFamily: 'acumin-pro, sans-serif' }}>電話番号</p>
													<p className="text-sm text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>{savedContact.phone || '-'}</p>
												</div>
												<div className="flex gap-3">
													<Button
														type="button"
														size="sm"
														className="px-8 font-acumin"
														onClick={() => setIsEditingProfile(true)}
													>
														変更する
													</Button>
													<Button
														type="button"
														variant="secondary"
														size="sm"
														className="px-8 font-acumin"
														onClick={handleProfileDelete}
													>
														削除する
													</Button>
												</div>
											</div>
										)}

										{(!savedContact || isEditingProfile) && !isLoadingProfile && (
											<form className="space-y-6" onSubmit={handleProfileSave}>
												<div>
													<label className="block text-xs text-[#474747] mb-2 tracking-wider" style={{ fontFamily: 'acumin-pro, sans-serif' }}>氏名</label>
													<TextField className="font-acumin" type="text" name="fullName" autoComplete="name" value={profileForm.fullName} onChange={handleProfileFormChange} style={{ fontFamily: 'acumin-pro, sans-serif' }}  size="md"/>
												</div>
												<div>
													<label className="block text-xs text-[#474747] mb-2 tracking-wider" style={{ fontFamily: 'acumin-pro, sans-serif' }}>電話番号</label>
													<TextField className="font-acumin" type="tel" name="phone" autoComplete="tel" value={profileForm.phone} onChange={handleProfileFormChange} style={{ fontFamily: 'acumin-pro, sans-serif' }}  size="md"/>
												</div>
												<div className="flex gap-3">
													<Button
														type="submit"
														size="lg"
														className="font-acumin"
													>
														{savedContact ? '変更を保存' : '保存する'}
													</Button>
													{savedContact && (
														<Button
															type="button"
															variant="secondary"
															size="lg"
															className="font-acumin"
															onClick={() => {
																setProfileForm(savedContact);
																setIsEditingProfile(false);
															}}
														>
															キャンセル
														</Button>
													)}
												</div>
											</form>
										)}
									</div>
								</div>
							)}

							{activeTab === 'orders' && (
								<div>
									<div className="space-y-8">
										<div className="border border-black/10 p-8">
											<div className="flex justify-between items-start mb-6 pb-6 border-b border-black/10">
												<div>
													<p className="text-sm text-[#474747] mb-1" style={{ fontFamily: 'acumin-pro, sans-serif' }}>注文番号</p>
													<p className="text-lg text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>ORD-ABC123</p>
												</div>
												<div className="text-right">
													<p className="text-sm text-[#474747] mb-1" style={{ fontFamily: 'acumin-pro, sans-serif' }}>注文日</p>
													<p className="text-sm text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>2024年1月15日</p>
												</div>
											</div>
											<div className="space-y-4 mb-6">
												<div className="flex gap-4">
													<div className="w-20 h-24 bg-[#f5f5f5] flex-shrink-0 overflow-hidden">
														<Image alt="シルクブラウス" className="w-full h-full object-cover object-top" src="https://readdy.ai/api/search-image?query=elegant%20black%20silk%20blouse%20on%20white%20background%20minimalist%20fashion%20photography%20high%20quality%20luxury%20fabric%20texture%20soft%20lighting%20professional%20product%20shot%20clean%20simple%20backdrop&width=200&height=250&seq=order1&orientation=portrait" width={200} height={250} />
													</div>
													<div className="flex-1">
														<p className="text-sm text-black mb-1" style={{ fontFamily: 'acumin-pro, sans-serif' }}>シルクブラウス</p>
														<p className="text-xs text-[#474747] mb-2" style={{ fontFamily: 'acumin-pro, sans-serif' }}>数量: 1</p>
														<p className="text-sm text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>¥28,000</p>
													</div>
												</div>
												<div className="flex gap-4">
													<div className="w-20 h-24 bg-[#f5f5f5] flex-shrink-0 overflow-hidden">
														<Image alt="ウールコート" className="w-full h-full object-cover object-top" src="https://readdy.ai/api/search-image?query=navy%20blue%20wool%20coat%20on%20white%20background%20classic%20elegant%20outerwear%20fashion%20photography%20luxury%20winter%20clothing%20professional%20product%20image%20clean%20minimal%20setting&width=200&height=250&seq=order2&orientation=portrait" width={200} height={250} />
													</div>
													<div className="flex-1">
														<p className="text-sm text-black mb-1" style={{ fontFamily: 'acumin-pro, sans-serif' }}>ウールコート</p>
														<p className="text-xs text-[#474747] mb-2" style={{ fontFamily: 'acumin-pro, sans-serif' }}>数量: 2</p>
														<p className="text-sm text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>¥68,000</p>
													</div>
												</div>
												<div className="flex gap-4">
													<div className="w-20 h-24 bg-[#f5f5f5] flex-shrink-0 overflow-hidden">
														<Image alt="レザーバッグ" className="w-full h-full object-cover object-top" src="https://readdy.ai/api/search-image?query=gold%20leather%20handbag%20on%20white%20background%20luxury%20fashion%20accessory%20elegant%20design%20professional%20product%20photography%20high%20quality%20craftsmanship%20clean%20minimal%20backdrop&width=200&height=250&seq=order3&orientation=portrait" width={200} height={250} />
													</div>
													<div className="flex-1">
														<p className="text-sm text-black mb-1" style={{ fontFamily: 'acumin-pro, sans-serif' }}>レザーバッグ</p>
														<p className="text-xs text-[#474747] mb-2" style={{ fontFamily: 'acumin-pro, sans-serif' }}>数量: 1</p>
														<p className="text-sm text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>¥45,000</p>
													</div>
												</div>
											</div>
											<div className="flex justify-between items-center pt-6 border-t border-black/10">
												<div>
													<span className="inline-block px-4 py-2 text-xs tracking-wider bg-[#fef3c7] text-[#d97706]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>配送中</span>
												</div>
												<div className="text-right">
													<p className="text-sm text-[#474747] mb-1" style={{ fontFamily: 'acumin-pro, sans-serif' }}>合計</p>
													<p className="text-xl text-black" style={{ fontFamily: 'Didot, serif' }}>¥141,000</p>
												</div>
											</div>
										</div>

										<div className="border border-black/10 p-8">
											<div className="flex justify-between items-start mb-6 pb-6 border-b border-black/10">
												<div>
													<p className="text-sm text-[#474747] mb-1" style={{ fontFamily: 'acumin-pro, sans-serif' }}>注文番号</p>
													<p className="text-lg text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>ORD-DEF456</p>
												</div>
												<div className="text-right">
													<p className="text-sm text-[#474747] mb-1" style={{ fontFamily: 'acumin-pro, sans-serif' }}>注文日</p>
													<p className="text-sm text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>2023年12月28日</p>
												</div>
											</div>
											<div className="space-y-4 mb-6">
												<div className="flex gap-4">
													<div className="w-20 h-24 bg-[#f5f5f5] flex-shrink-0 overflow-hidden">
														<Image alt="カシミアセーター" className="w-full h-full object-cover object-top" src="https://readdy.ai/api/search-image?query=beige%20cashmere%20sweater%20on%20white%20background%20luxury%20knitwear%20soft%20texture%20elegant%20fashion%20photography%20professional%20product%20shot%20clean%20minimal%20setting%20high%20quality&width=200&height=250&seq=order4&orientation=portrait" width={200} height={250} />
													</div>
													<div className="flex-1">
														<p className="text-sm text-black mb-1" style={{ fontFamily: 'acumin-pro, sans-serif' }}>カシミアセーター</p>
														<p className="text-xs text-[#474747] mb-2" style={{ fontFamily: 'acumin-pro, sans-serif' }}>数量: 1</p>
														<p className="text-sm text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>¥38,000</p>
													</div>
												</div>
												<div className="flex gap-4">
													<div className="w-20 h-24 bg-[#f5f5f5] flex-shrink-0 overflow-hidden">
														<Image alt="ウールパンツ" className="w-full h-full object-cover object-top" src="https://readdy.ai/api/search-image?query=grey%20wool%20trousers%20on%20white%20background%20tailored%20pants%20elegant%20fashion%20photography%20luxury%20clothing%20professional%20product%20shot%20clean%20simple%20backdrop&width=200&height=250&seq=order5&orientation=portrait" width={200} height={250} />
													</div>
													<div className="flex-1">
														<p className="text-sm text-black mb-1" style={{ fontFamily: 'acumin-pro, sans-serif' }}>ウールパンツ</p>
														<p className="text-xs text-[#474747] mb-2" style={{ fontFamily: 'acumin-pro, sans-serif' }}>数量: 1</p>
														<p className="text-sm text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>¥32,000</p>
													</div>
												</div>
												<div className="flex gap-4">
													<div className="w-20 h-24 bg-[#f5f5f5] flex-shrink-0 overflow-hidden">
														<Image alt="シルクスカーフ" className="w-full h-full object-cover object-top" src="https://readdy.ai/api/search-image?query=pink%20silk%20scarf%20on%20white%20background%20luxury%20fashion%20accessory%20elegant%20pattern%20professional%20product%20photography%20high%20quality%20craftsmanship%20clean%20minimal%20setting&width=200&height=250&seq=order6&orientation=portrait" width={200} height={250} />
													</div>
													<div className="flex-1">
														<p className="text-sm text-black mb-1" style={{ fontFamily: 'acumin-pro, sans-serif' }}>シルクスカーフ</p>
														<p className="text-xs text-[#474747] mb-2" style={{ fontFamily: 'acumin-pro, sans-serif' }}>数量: 1</p>
														<p className="text-sm text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>¥18,000</p>
													</div>
												</div>
											</div>
											<div className="flex justify-between items-center pt-6 border-t border-black/10">
												<div>
													<span className="inline-block px-4 py-2 text-xs tracking-wider bg-[#f0fdf4] text-[#16a34a]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>配送完了</span>
												</div>
												<div className="text-right">
													<p className="text-sm text-[#474747] mb-1" style={{ fontFamily: 'acumin-pro, sans-serif' }}>合計</p>
													<p className="text-xl text-black" style={{ fontFamily: 'Didot, serif' }}>¥98,000</p>
												</div>
											</div>
										</div>

										<div className="border border-black/10 p-8">
											<div className="flex justify-between items-start mb-6 pb-6 border-b border-black/10">
												<div>
													<p className="text-sm text-[#474747] mb-1" style={{ fontFamily: 'acumin-pro, sans-serif' }}>注文番号</p>
													<p className="text-lg text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>ORD-GHI789</p>
												</div>
												<div className="text-right">
													<p className="text-sm text-[#474747] mb-1" style={{ fontFamily: 'acumin-pro, sans-serif' }}>注文日</p>
													<p className="text-sm text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>2023年12月10日</p>
												</div>
											</div>
											<div className="space-y-4 mb-6">
												<div className="flex gap-4">
													<div className="w-20 h-24 bg-[#f5f5f5] flex-shrink-0 overflow-hidden">
														<Image alt="レザージャケット" className="w-full h-full object-cover object-top" src="https://readdy.ai/api/search-image?query=black%20leather%20jacket%20on%20white%20background%20luxury%20outerwear%20classic%20biker%20style%20elegant%20fashion%20photography%20professional%20product%20image%20clean%20minimal%20backdrop&width=200&height=250&seq=order7&orientation=portrait" width={200} height={250} />
													</div>
													<div className="flex-1">
														<p className="text-sm text-black mb-1" style={{ fontFamily: 'acumin-pro, sans-serif' }}>レザージャケット</p>
														<p className="text-xs text-[#474747] mb-2" style={{ fontFamily: 'acumin-pro, sans-serif' }}>数量: 1</p>
														<p className="text-sm text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>¥98,000</p>
													</div>
												</div>
											</div>
											<div className="flex justify-between items-center pt-6 border-t border-black/10">
												<div>
													<span className="inline-block px-4 py-2 text-xs tracking-wider bg-[#f0fdf4] text-[#16a34a]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>配送完了</span>
												</div>
												<div className="text-right">
													<p className="text-sm text-[#474747] mb-1" style={{ fontFamily: 'acumin-pro, sans-serif' }}>合計</p>
													<p className="text-xl text-black" style={{ fontFamily: 'Didot, serif' }}>¥98,000</p>
												</div>
											</div>
										</div>
									</div>
								</div>
							)}

							{activeTab === 'address' && (
								<div>
									<form className="space-y-6">
										<div>
											<label className="block text-xs text-[#474747] mb-2 tracking-wider" style={{ fontFamily: 'acumin-pro, sans-serif' }}>郵便番号</label>
											<TextField 
												className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black transition-colors" 
												type="text" 
												name="postalCode"
												placeholder="123-4567"
												autoComplete="postal-code"
												value={addressForm.postalCode}
												onChange={handleAddressChange}
												style={{ fontFamily: 'acumin-pro, sans-serif' }} 
											 size="md"/>
										</div>
										<div>
											<label className="block text-xs text-[#474747] mb-2 tracking-wider" style={{ fontFamily: 'acumin-pro, sans-serif' }}>都道府県</label>
											<TextField 
												className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black transition-colors" 
												type="text" 
												name="prefecture"
												autoComplete="address-level1"
												value={addressForm.prefecture}
												onChange={handleAddressChange}
												style={{ fontFamily: 'acumin-pro, sans-serif' }} 
											 size="md"/>
										</div>
										<div>
											<label className="block text-xs text-[#474747] mb-2 tracking-wider" style={{ fontFamily: 'acumin-pro, sans-serif' }}>市区町村</label>
											<TextField 
												className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black transition-colors" 
												type="text" 
												name="city"
												autoComplete="address-level2"
												value={addressForm.city}
												onChange={handleAddressChange}
												style={{ fontFamily: 'acumin-pro, sans-serif' }} 
											 size="md"/>
										</div>
										<div>
											<label className="block text-xs text-[#474747] mb-2 tracking-wider" style={{ fontFamily: 'acumin-pro, sans-serif' }}>番地</label>
											<TextField 
												className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black transition-colors" 
												type="text" 
												name="address"
												autoComplete="street-address"
												value={addressForm.address}
												onChange={handleAddressChange}
												style={{ fontFamily: 'acumin-pro, sans-serif' }} 
											 size="md"/>
										</div>
										<div>
											<label className="block text-xs text-[#474747] mb-2 tracking-wider" style={{ fontFamily: 'acumin-pro, sans-serif' }}>建物名・部屋番号</label>
											<TextField 
												className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black transition-colors" 
												type="text" 
												name="building"
												value={addressForm.building}
												onChange={handleAddressChange}
												style={{ fontFamily: 'acumin-pro, sans-serif' }} 
											 size="md"/>
										</div>
										<Button
											type="submit"
											size="lg"
											className="font-acumin"
										>
											更新する
										</Button>
									</form>
								</div>
							)}
						</div>
					</div>
				</div>
			</main>
		);
	}

	return (
		<main className="pt-32 pb-20 px-6 lg:px-12">
			<div className="max-w-3xl mx-auto text-center">
				<div className="w-20 h-20 flex items-center justify-center mx-auto mb-8">
					<i className="ri-user-line text-6xl text-[#474747]"></i>
				</div>
				<h1 className="text-4xl text-black tracking-tight mb-4 font-display">
					会員情報
				</h1>
				<p className="text-lg text-[#474747] mb-8 font-brand">
					会員情報を確認するにはログインが必要です
				</p>
				<Button href="/login" variant="primary" size="lg" className="font-brand">
					ログイン
				</Button>
			</div>
		</main>
	);
}
