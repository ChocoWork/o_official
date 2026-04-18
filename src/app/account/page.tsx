'use client';

import Link from 'next/link';
import React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useLogin } from '@/contexts/LoginContext';
import { Button } from '@/components/ui/Button';
import { TabSegmentControl } from '@/components/ui/TabSegmentControl';
import { TextField } from '@/components/ui/TextField';
import { clientFetch } from '@/lib/client-fetch';
import { formatPhoneNumberInput } from '@/features/account/utils/profile-format.util';
import { formatPostalCodeInput, normalizePostalCode } from '@/features/checkout/utils/postal-code.util';

type AccountTab = 'profile' | 'shipping' | 'orders';

type ProfileAddress = {
	postalCode: string;
	prefecture: string;
	city: string;
	address: string;
	building: string;
};

type ProfileForm = {
	email: string;
	fullName: string;
	kanaName: string;
	phone: string;
	address: ProfileAddress;
};

type OrderSummary = {
	id: string;
	orderNumber: string;
	orderDate: string;
	status: string;
	totalAmount: string;
	itemCount: number;
	items: Array<{
		id: string;
		name: string;
		imageUrl?: string | null;
		color?: string | null;
		size?: string | null;
		quantity: number;
		amount: string;
	}>;
	detailHref: string;
};

const EMPTY_ADDRESS: ProfileAddress = {
	postalCode: '',
	prefecture: '',
	city: '',
	address: '',
	building: '',
};

const EMPTY_PROFILE: ProfileForm = {
	email: '',
	fullName: '',
	kanaName: '',
	phone: '',
	address: EMPTY_ADDRESS,
};

function normalizeAccountTab(tabParam: string | null): AccountTab {
	if (tabParam === 'shipping' || tabParam === 'address') {
		return 'shipping';
	}

	if (tabParam === 'orders') {
		return tabParam;
	}

	return 'profile';
}

function hasAddressValue(address: ProfileAddress) {
	return Object.values(address).some((value) => value.trim().length > 0);
}

export default function AccountPage() {
	const { isLoggedIn, isAuthResolved, logout } = useLogin();
	const router = useRouter();
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const activeTabFromQuery = normalizeAccountTab(searchParams.get('tab'));

	const [activeTab, setActiveTab] = React.useState<AccountTab>(activeTabFromQuery);
	const [savedProfile, setSavedProfile] = React.useState<ProfileForm>(EMPTY_PROFILE);
	const [profileForm, setProfileForm] = React.useState<ProfileForm>(EMPTY_PROFILE);
	const [orders, setOrders] = React.useState<OrderSummary[]>([]);
	const [isEditingProfile, setIsEditingProfile] = React.useState(false);
	const [isEditingShipping, setIsEditingShipping] = React.useState(false);
	const [isLoadingProfile, setIsLoadingProfile] = React.useState(true);
	const [isLoadingOrders, setIsLoadingOrders] = React.useState(false);
	const [isSavingProfile, setIsSavingProfile] = React.useState(false);
	const [profileMessage, setProfileMessage] = React.useState<string | null>(null);
	const [profileError, setProfileError] = React.useState<string | null>(null);
	const [ordersError, setOrdersError] = React.useState<string | null>(null);
	const [logoutError, setLogoutError] = React.useState<string | null>(null);
	const [isLoggingOut, setIsLoggingOut] = React.useState(false);
	const latestPostalLookupRef = React.useRef('');
	const rawTabFromQuery = searchParams.get('tab');

	const syncTabToUrl = React.useCallback(
		(nextTab: AccountTab) => {
			const nextParams = new URLSearchParams(searchParams.toString());
			nextParams.set('tab', nextTab);
			router.replace(`${pathname}?${nextParams.toString()}`, { scroll: false });
		},
		[pathname, router, searchParams],
	);

	const fetchProfile = React.useCallback(async () => {
		setIsLoadingProfile(true);
		setProfileError(null);

		try {
			const response = await clientFetch('/api/profile', { cache: 'no-store' });
			if (!response.ok) {
				throw new Error('プロフィールの取得に失敗しました');
			}

			const data = (await response.json()) as Partial<ProfileForm> & { address?: Partial<ProfileAddress> };
			const normalizedProfile: ProfileForm = {
				email: typeof data.email === 'string' ? data.email : '',
				fullName: typeof data.fullName === 'string' ? data.fullName : '',
				kanaName: typeof data.kanaName === 'string' ? data.kanaName : '',
				phone: formatPhoneNumberInput(typeof data.phone === 'string' ? data.phone : ''),
				address: {
					postalCode: formatPostalCodeInput(typeof data.address?.postalCode === 'string' ? data.address.postalCode : ''),
					prefecture: typeof data.address?.prefecture === 'string' ? data.address.prefecture : '',
					city: typeof data.address?.city === 'string' ? data.address.city : '',
					address: typeof data.address?.address === 'string' ? data.address.address : '',
					building: typeof data.address?.building === 'string' ? data.address.building : '',
				},
			};

			setSavedProfile(normalizedProfile);
			setProfileForm(normalizedProfile);
		} catch (error) {
			console.error('Failed to fetch profile:', error);
			setProfileError('プロフィールを読み込めませんでした');
		} finally {
			setIsLoadingProfile(false);
		}
	}, []);

	const fetchOrders = React.useCallback(async () => {
		setIsLoadingOrders(true);
		setOrdersError(null);

		try {
			const response = await clientFetch('/api/orders', { cache: 'no-store' });
			if (!response.ok) {
				throw new Error('注文履歴の取得に失敗しました');
			}

			const data = (await response.json()) as { data?: OrderSummary[] };
			setOrders(Array.isArray(data.data) ? data.data : []);
		} catch (error) {
			console.error('Failed to fetch orders:', error);
			setOrdersError('注文履歴を読み込めませんでした');
		} finally {
			setIsLoadingOrders(false);
		}
	}, []);

	React.useEffect(() => {
		setActiveTab(activeTabFromQuery);

		if (rawTabFromQuery && rawTabFromQuery !== activeTabFromQuery) {
			syncTabToUrl(activeTabFromQuery);
		}
	}, [activeTabFromQuery, rawTabFromQuery, syncTabToUrl]);

	React.useEffect(() => {
		if (!isAuthResolved || !isLoggedIn) {
			setIsLoadingProfile(false);
			return;
		}

		void fetchProfile();
	}, [fetchProfile, isAuthResolved, isLoggedIn]);

	React.useEffect(() => {
		if (!isAuthResolved || !isLoggedIn || activeTab !== 'orders') {
			return;
		}

		void fetchOrders();
	}, [activeTab, fetchOrders, isAuthResolved, isLoggedIn]);

	const handleTabChange = (tab: string) => {
		const nextTab = normalizeAccountTab(tab);
		setActiveTab(nextTab);
		syncTabToUrl(nextTab);
		setProfileMessage(null);
		setProfileError(null);
		setIsEditingProfile(false);
		setIsEditingShipping(false);
	};

	const handleProfileFieldChange = (event: React.ChangeEvent<HTMLInputElement>) => {
		const { name, value } = event.target;
		const nextValue = name === 'phone' ? formatPhoneNumberInput(value) : value;
		setProfileForm((prev) => ({
			...prev,
			[name]: nextValue,
		}));
	};

	const handleAddressFieldChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
		const { name, value } = event.target;
		const nextValue = name === 'postalCode' ? formatPostalCodeInput(value) : value;
		const nextAddress = {
			...profileForm.address,
			[name]: nextValue,
		};

		setProfileForm((prev) => ({
			...prev,
			address: nextAddress,
		}));

		if (name !== 'postalCode') {
			return;
		}

		const cleanedPostalCode = normalizePostalCode(value);
		latestPostalLookupRef.current = cleanedPostalCode;

		if (cleanedPostalCode.length !== 7) {
			return;
		}

		try {
			const response = await fetch(`/api/checkout/postal-code?postalCode=${cleanedPostalCode}`);
			const data = (await response.json()) as { address?: Partial<ProfileAddress> };

			if (!response.ok || latestPostalLookupRef.current !== cleanedPostalCode || !data.address) {
				return;
			}

			setProfileForm((prev) => ({
				...prev,
				address: {
					...prev.address,
					postalCode: formatPostalCodeInput(cleanedPostalCode),
					prefecture: data.address?.prefecture || prev.address.prefecture,
					city: data.address?.city || prev.address.city,
					address: data.address?.address || prev.address.address,
					building: prev.address.building,
				},
			}));
		} catch (error) {
			console.error('Postal code lookup error:', error);
		}
	};

	const persistProfile = async (nextProfile: ProfileForm = profileForm) => {
		const payload = {
			fullName: nextProfile.fullName.trim(),
			kanaName: nextProfile.kanaName.trim(),
			phone: formatPhoneNumberInput(nextProfile.phone.trim()),
			address: {
				postalCode: normalizePostalCode(nextProfile.address.postalCode),
				prefecture: nextProfile.address.prefecture.trim(),
				city: nextProfile.address.city.trim(),
				address: nextProfile.address.address.trim(),
				building: nextProfile.address.building.trim(),
			},
		};

		const response = await clientFetch('/api/profile', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		});

		if (!response.ok) {
			throw new Error('プロフィールの保存に失敗しました');
		}

		const data = (await response.json()) as ProfileForm;
		const normalizedProfile: ProfileForm = {
			email: typeof data.email === 'string' ? data.email : nextProfile.email,
			fullName: typeof data.fullName === 'string' ? data.fullName : '',
			kanaName: typeof data.kanaName === 'string' ? data.kanaName : '',
			phone: formatPhoneNumberInput(typeof data.phone === 'string' ? data.phone : ''),
			address: {
				postalCode: formatPostalCodeInput(typeof data.address?.postalCode === 'string' ? data.address.postalCode : ''),
				prefecture: typeof data.address?.prefecture === 'string' ? data.address.prefecture : '',
				city: typeof data.address?.city === 'string' ? data.address.city : '',
				address: typeof data.address?.address === 'string' ? data.address.address : '',
				building: typeof data.address?.building === 'string' ? data.address.building : '',
			},
		};

		setSavedProfile(normalizedProfile);
		setProfileForm(normalizedProfile);
	};

	const handleShippingSave = async (event: React.FormEvent) => {
		event.preventDefault();
		setIsSavingProfile(true);
		setProfileMessage(null);
		setProfileError(null);

		try {
			await persistProfile(profileForm);
			setIsEditingShipping(false);
			setProfileMessage('配送情報を保存しました');
		} catch (error) {
			console.error('Shipping save error:', error);
			setProfileError('配送情報を保存できませんでした');
		} finally {
			setIsSavingProfile(false);
		}
	};

	const handleProfileSave = async (event: React.FormEvent) => {
		event.preventDefault();
		setIsSavingProfile(true);
		setProfileMessage(null);
		setProfileError(null);

		try {
			await persistProfile(profileForm);
			setIsEditingProfile(false);
			setProfileMessage('プロフィールを保存しました');
		} catch (error) {
			console.error('Profile save error:', error);
			setProfileError('プロフィールを保存できませんでした');
		} finally {
			setIsSavingProfile(false);
		}
	};

	const handleProfileDelete = async () => {
		setProfileMessage(null);
		setProfileError(null);

		try {
			setProfileForm((prev) => ({
				...prev,
				fullName: '',
				kanaName: '',
				phone: '',
			}));

			const nextProfile = {
				...profileForm,
				fullName: '',
				kanaName: '',
				phone: '',
			};
			setProfileForm(nextProfile);
			await persistProfile(nextProfile);
			setIsEditingProfile(false);
			setProfileMessage('プロフィールを削除しました');
		} catch (error) {
			console.error('Profile delete error:', error);
			setProfileError('プロフィールを削除できませんでした');
		}
	};

	const handleShippingDelete = async () => {
		setProfileMessage(null);
		setProfileError(null);

		try {
			const nextProfile = {
				...profileForm,
				address: {
					...EMPTY_ADDRESS,
				},
			};
			setProfileForm(nextProfile);
			await persistProfile(nextProfile);
			setIsEditingShipping(false);
			setProfileMessage('配送情報を削除しました');
		} catch (error) {
			console.error('Shipping delete error:', error);
			setProfileError('配送情報を削除できませんでした');
		}
	};

	const handleLogout = async () => {
		setIsLoggingOut(true);
		setLogoutError(null);

		const result = await logout();
		if (!result.success) {
			setLogoutError(result.error || 'ログアウトに失敗しました');
		}

		setIsLoggingOut(false);
	};

	const hasSavedProfile =
		savedProfile.email.trim().length > 0 ||
		savedProfile.fullName.trim().length > 0 ||
		savedProfile.kanaName.trim().length > 0 ||
		savedProfile.phone.trim().length > 0;

	const hasSavedShipping = hasAddressValue(savedProfile.address);

	if (!isAuthResolved) {
		return (
			<div className="pb-10 sm:pb-14 px-6 lg:px-12">
				<div className="max-w-3xl mx-auto text-center">
					<p className="text-lg text-[#474747] mb-8 font-brand">読み込み中...</p>
				</div>
			</div>
		);
	}

	if (!isLoggedIn) {
		return (
			<div className="pb-10 sm:pb-14 px-6 lg:px-12">
				<div className="max-w-3xl mx-auto text-center">
					<div className="w-20 h-20 flex items-center justify-center mx-auto mb-8">
						<i className="ri-user-line text-6xl text-[#474747]"></i>
					</div>
					<h1 className="text-4xl text-black tracking-tight mb-4 font-display">会員情報</h1>
					<p className="text-lg text-[#474747] mb-8 font-brand">会員情報を確認するにはログインが必要です</p>
					<Button href="/login" variant="primary" size="lg" className="font-brand">
						ログイン
					</Button>
				</div>
			</div>
		);
	}

	return (
		<div className="pb-10 sm:pb-14 px-6 lg:px-12">
			<div className="max-w-7xl mx-auto">
				<div className="grid grid-cols-1 lg:grid-cols-4 gap-12">
					<div className="lg:col-span-1">
						<TabSegmentControl
							items={[
								{ key: 'profile', label: 'プロフィール' },
								{ key: 'shipping', label: '配送情報' },
								{ key: 'orders', label: '購入履歴' },
							]}
							activeKey={activeTab}
							onChange={handleTabChange}
							orientation="vertical"
							size="md"
							className="space-y-2"
						/>
						<div className="mt-6 pt-6 border-t border-black/10">
							<Button
								type="button"
								variant="secondary"
								size="md"
								className="w-full font-acumin"
								onClick={handleLogout}
								disabled={isLoggingOut}
							>
								{isLoggingOut ? 'ログアウト中...' : 'ログアウト'}
							</Button>
							{logoutError ? <p className="mt-3 text-xs text-red-600 font-acumin">{logoutError}</p> : null}
						</div>
					</div>

					<div className="lg:col-span-3 min-w-0">
						{activeTab === 'profile' ? (
							<div className="space-y-6">
								{isLoadingProfile ? <p className="text-sm text-[#474747] font-brand">読み込み中...</p> : null}
								{profileMessage ? <p className="text-sm text-green-700 font-brand">{profileMessage}</p> : null}
								{profileError ? <p className="text-sm text-red-600 font-brand">{profileError}</p> : null}

								{!isLoadingProfile && hasSavedProfile && !isEditingProfile ? (
									<div className="border border-black/10 p-6 space-y-4">
										<div>
											<p className="text-xs text-[#474747] mb-1 tracking-wider font-brand">メールアドレス</p>
											<p className="text-sm text-black font-brand break-all">{savedProfile.email || '-'}</p>
										</div>
										<div>
											<p className="text-xs text-[#474747] mb-1 tracking-wider font-brand">氏名</p>
											<p className="text-sm text-black font-brand">{savedProfile.fullName || '-'}</p>
										</div>
										<div>
											<p className="text-xs text-[#474747] mb-1 tracking-wider font-brand">フリガナ</p>
											<p className="text-sm text-black font-brand">{savedProfile.kanaName || '-'}</p>
										</div>
										<div>
											<p className="text-xs text-[#474747] mb-1 tracking-wider font-brand">電話番号</p>
											<p className="text-sm text-black font-brand">{savedProfile.phone || '-'}</p>
										</div>
										<div className="flex flex-wrap gap-3">
											<Button type="button" size="sm" className="px-8 font-acumin" onClick={() => setIsEditingProfile(true)}>
												変更する
											</Button>
											<Button type="button" variant="secondary" size="sm" className="px-8 font-acumin" onClick={handleProfileDelete}>
												削除する
											</Button>
										</div>
									</div>
								) : null}

								{!isLoadingProfile && (!hasSavedProfile || isEditingProfile) ? (
									<form className="space-y-6 border border-black/10 p-6" onSubmit={handleProfileSave}>
										<TextField label="メールアドレス" className="bg-[#f5f5f5]" type="email" name="email" value={profileForm.email} readOnly size="md" />
										<TextField label="氏名" type="text" name="fullName" autoComplete="name" value={profileForm.fullName} onChange={handleProfileFieldChange} size="md" />
										<TextField label="フリガナ" type="text" name="kanaName" value={profileForm.kanaName} onChange={handleProfileFieldChange} size="md" />
										<TextField label="電話番号" type="tel" name="phone" autoComplete="tel" inputMode="numeric" value={profileForm.phone} onChange={handleProfileFieldChange} size="md" />
										<div className="flex flex-wrap gap-3">
											<Button type="submit" size="lg" className="font-acumin" disabled={isSavingProfile}>
												{isSavingProfile ? '保存中...' : hasSavedProfile ? '変更を保存' : '保存する'}
											</Button>
											{hasSavedProfile ? (
												<Button
													type="button"
													variant="secondary"
													size="lg"
													className="font-acumin"
													onClick={() => {
														setProfileForm(savedProfile);
														setIsEditingProfile(false);
														setProfileError(null);
													}}
												>
													キャンセル
												</Button>
											) : null}
										</div>
									</form>
								) : null}
							</div>
						) : null}

						{activeTab === 'shipping' ? (
							<div className="space-y-6">
								{isLoadingProfile ? <p className="text-sm text-[#474747] font-brand">読み込み中...</p> : null}
								{profileMessage ? <p className="text-sm text-green-700 font-brand">{profileMessage}</p> : null}
								{profileError ? <p className="text-sm text-red-600 font-brand">{profileError}</p> : null}

								{!isLoadingProfile && hasSavedShipping && !isEditingShipping ? (
									<div className="border border-black/10 p-6 space-y-4">
										<div>
											<p className="text-xs text-[#474747] mb-1 tracking-wider font-brand">郵便番号</p>
											<p className="text-sm text-black font-brand">{savedProfile.address.postalCode || '-'}</p>
										</div>
										<div>
											<p className="text-xs text-[#474747] mb-1 tracking-wider font-brand">都道府県</p>
											<p className="text-sm text-black font-brand">{savedProfile.address.prefecture || '-'}</p>
										</div>
										<div>
											<p className="text-xs text-[#474747] mb-1 tracking-wider font-brand">市区町村</p>
											<p className="text-sm text-black font-brand">{savedProfile.address.city || '-'}</p>
										</div>
										<div>
											<p className="text-xs text-[#474747] mb-1 tracking-wider font-brand">番地</p>
											<p className="text-sm text-black font-brand">{savedProfile.address.address || '-'}</p>
										</div>
										<div>
											<p className="text-xs text-[#474747] mb-1 tracking-wider font-brand">建物名・部屋番号</p>
											<p className="text-sm text-black font-brand">{savedProfile.address.building || '-'}</p>
										</div>
										<div className="flex flex-wrap gap-3">
											<Button type="button" size="sm" className="px-8 font-acumin" onClick={() => setIsEditingShipping(true)}>
												変更する
											</Button>
											<Button type="button" variant="secondary" size="sm" className="px-8 font-acumin" onClick={handleShippingDelete}>
												削除する
											</Button>
										</div>
									</div>
								) : null}

								{!isLoadingProfile && (!hasSavedShipping || isEditingShipping) ? (
									<form className="space-y-6 border border-black/10 p-6" onSubmit={handleShippingSave}>
										<TextField label="郵便番号" type="text" name="postalCode" autoComplete="postal-code" inputMode="numeric" value={profileForm.address.postalCode} onChange={handleAddressFieldChange} size="md" />
										<TextField label="都道府県" type="text" name="prefecture" autoComplete="address-level1" value={profileForm.address.prefecture} onChange={handleAddressFieldChange} size="md" />
										<TextField label="市区町村" type="text" name="city" autoComplete="address-level2" value={profileForm.address.city} onChange={handleAddressFieldChange} size="md" />
										<TextField label="番地" type="text" name="address" autoComplete="street-address" value={profileForm.address.address} onChange={handleAddressFieldChange} size="md" />
										<TextField label="建物名・部屋番号" type="text" name="building" value={profileForm.address.building} onChange={handleAddressFieldChange} size="md" />
										<div className="flex flex-wrap gap-3">
											<Button type="submit" size="lg" className="font-acumin" disabled={isSavingProfile}>
												{isSavingProfile ? '保存中...' : hasSavedShipping ? '変更を保存' : '保存する'}
											</Button>
											{hasSavedShipping ? (
												<Button
													type="button"
													variant="secondary"
													size="lg"
													className="font-acumin"
													onClick={() => {
														setProfileForm(savedProfile);
														setIsEditingShipping(false);
														setProfileError(null);
													}}
												>
													キャンセル
												</Button>
											) : null}
										</div>
									</form>
								) : null}
							</div>
						) : null}

						{activeTab === 'orders' ? (
							<div className="space-y-6">
								{isLoadingOrders ? <p className="text-sm text-[#474747] font-brand">注文履歴を読み込み中...</p> : null}
								{ordersError ? <p className="text-sm text-red-600 font-brand">{ordersError}</p> : null}
								{!isLoadingOrders && !ordersError && orders.length === 0 ? (
									<div className="border border-black/10 p-8">
										<p className="text-base text-black font-brand mb-2">注文履歴はまだありません</p>
										<p className="text-sm text-[#474747] font-brand">ご注文いただいた商品はこの画面に表示されます。</p>
									</div>
								) : null}

								{orders.map((order) => (
									<article key={order.id} className="border border-black/10 p-8 space-y-6">
										<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between pb-6 border-b border-black/10">
											<div>
												<p className="text-sm text-[#474747] mb-1 font-brand">注文番号</p>
												<p className="text-lg text-black font-brand">{order.orderNumber}</p>
											</div>
											<div className="sm:text-right">
												<p className="text-sm text-[#474747] mb-1 font-brand">注文日</p>
												<p className="text-sm text-black font-brand">{order.orderDate}</p>
											</div>
										</div>

										<div className="space-y-4">
											{order.items.map((item) => (
												<div key={item.id} className="flex flex-col gap-1 border-b border-black/5 pb-4 last:border-b-0 last:pb-0">
													<p className="text-sm text-black font-brand">{item.name}</p>
													<p className="text-xs text-[#474747] font-brand">
														数量: {item.quantity}
														{item.color ? ` / カラー: ${item.color}` : ''}
														{item.size ? ` / サイズ: ${item.size}` : ''}
													</p>
													<p className="text-sm text-black font-brand">{item.amount}</p>
												</div>
											))}
										</div>

										<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between pt-6 border-t border-black/10">
											<div>
												<span className="inline-flex items-center px-4 py-2 text-xs tracking-wider bg-[#f5f5f5] text-black font-brand">{order.status}</span>
												<p className="mt-3 text-xs text-[#474747] font-brand">商品点数: {order.itemCount}点</p>
											</div>
											<div className="sm:text-right flex flex-col gap-3 sm:items-end">
												<div>
													<p className="text-sm text-[#474747] mb-1 font-brand">合計</p>
													<p className="text-xl text-black font-display">{order.totalAmount}</p>
												</div>
												<Link href={order.detailHref} className="text-sm text-black underline underline-offset-4 font-brand">
													注文詳細を見る
												</Link>
											</div>
										</div>
									</article>
								))}
							</div>
						) : null}
					</div>
				</div>
			</div>
		</div>
	);
}