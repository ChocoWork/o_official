import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient, resolveRequestUser } from '@/lib/supabase/server';
import { formatPhoneNumberInput } from '@/features/account/utils/profile-format.util';

const addressSchema = z.object({
	postalCode: z.string().trim().max(16).optional().default(''),
	prefecture: z.string().trim().max(100).optional().default(''),
	city: z.string().trim().max(200).optional().default(''),
	address: z.string().trim().max(500).optional().default(''),
	building: z.string().trim().max(500).optional().default(''),
});

const profilePayloadSchema = z.object({
	fullName: z.string().trim().max(100).optional().default(''),
	kanaName: z.string().trim().max(100).optional().default(''),
	phone: z.string().trim().max(50).optional().default(''),
	address: addressSchema.optional().default({
		postalCode: '',
		prefecture: '',
		city: '',
		address: '',
		building: '',
	}),
});

type StoredAddress = {
	postalCode?: string | null;
	prefecture?: string | null;
	city?: string | null;
	address?: string | null;
	building?: string | null;
	isDefault?: boolean | null;
};

type ProfileRow = {
	display_name: string | null;
	kana_name: string | null;
	phone: string | null;
	address: StoredAddress | null;
	addresses: StoredAddress[] | null;
	optional_name: string | null;
	optional_phone: string | null;
};

type LegacyProfileRow = Omit<ProfileRow, 'optional_name' | 'optional_phone'>;

type SupabaseRouteError = {
	code?: string;
	message?: string;
	details?: string;
	hint?: string;
};

type CsrfDenyResponse = {
	status: number;
	_body: unknown;
	headers?: Record<string, string>;
};

type CsrfRotateResult = {
	rotatedCsrfToken: string;
};

function isCsrfDenyResponse(value: unknown): value is CsrfDenyResponse {
	return typeof value === 'object' && value !== null && 'status' in value && '_body' in value;
}

function hasRotatedCsrfToken(value: unknown): value is CsrfRotateResult {
	return typeof value === 'object' && value !== null && 'rotatedCsrfToken' in value;
}

function isMissingOptionalProfileColumnError(error: SupabaseRouteError | null) {
	if (!error) {
		return false;
	}

	if (error.code === '42703' || error.code === 'PGRST204') {
		return true;
	}

	const text = [error.message, error.details, error.hint].filter(Boolean).join(' ');
	return /optional_name|optional_phone|updated_at|addresses/i.test(text);
}

function normalizeAddress(address: ProfileRow['address']) {
	return {
		postalCode: typeof address?.postalCode === 'string' ? address.postalCode : '',
		prefecture: typeof address?.prefecture === 'string' ? address.prefecture : '',
		city: typeof address?.city === 'string' ? address.city : '',
		address: typeof address?.address === 'string' ? address.address : '',
		building: typeof address?.building === 'string' ? address.building : '',
	};
}

// 返却する単一 address は addresses 配列のデフォルトから導出（無ければ legacy address カラム）
function resolveProfileAddress(row: Pick<ProfileRow, 'address' | 'addresses'> | null) {
	const list = row?.addresses;
	if (Array.isArray(list) && list.length > 0) {
		const def = list.find((item) => item?.isDefault) ?? list[0];
		return normalizeAddress(def ?? null);
	}
	return normalizeAddress(row?.address ?? null);
}

async function fetchProfileRow(supabase: Awaited<ReturnType<typeof createClient>>, userId: string) {
	const primaryResult = await supabase
		.from('profiles')
		.select('display_name, kana_name, phone, address, addresses, optional_name, optional_phone')
		.eq('user_id', userId)
		.maybeSingle<ProfileRow>();

	if (!isMissingOptionalProfileColumnError(primaryResult.error as SupabaseRouteError | null)) {
		return primaryResult;
	}

	// optional_* / addresses 列が無い旧スキーマへのフォールバック
	const fallbackResult = await supabase
		.from('profiles')
		.select('display_name, kana_name, phone, address')
		.eq('user_id', userId)
		.maybeSingle<Omit<LegacyProfileRow, 'addresses'>>();

	if (fallbackResult.error) {
		return fallbackResult;
	}

	return {
		data: fallbackResult.data
			? {
					...fallbackResult.data,
					addresses: null,
					optional_name: null,
					optional_phone: null,
			  }
			: null,
		error: null,
	};
}

// 住所は /api/profile/addresses が単一の真実の源。プロフィール保存では address/addresses を触らない。
function buildProfileUpsertPayload(userId: string, fullName: string, kanaName: string, phone: string) {
	return {
		user_id: userId,
		display_name: fullName || null,
		kana_name: kanaName || null,
		phone: phone || null,
		optional_name: fullName || null,
		optional_phone: phone || null,
		updated_at: new Date().toISOString(),
	};
}

function buildLegacyProfileUpsertPayload(userId: string, fullName: string, kanaName: string, phone: string) {
	return {
		user_id: userId,
		display_name: fullName || null,
		kana_name: kanaName || null,
		phone: phone || null,
	};
}

async function upsertProfileRow(supabase: Awaited<ReturnType<typeof createClient>>, userId: string, fullName: string, kanaName: string, phone: string) {
	const primaryResult = await supabase.from('profiles').upsert(buildProfileUpsertPayload(userId, fullName, kanaName, phone), {
		onConflict: 'user_id',
	});

	if (!isMissingOptionalProfileColumnError(primaryResult.error as SupabaseRouteError | null)) {
		return primaryResult;
	}

	return supabase.from('profiles').upsert(buildLegacyProfileUpsertPayload(userId, fullName, kanaName, phone), {
		onConflict: 'user_id',
	});
}

async function clearProfileRow(supabase: Awaited<ReturnType<typeof createClient>>, userId: string) {
	const primaryResult = await supabase
		.from('profiles')
		.update({
			display_name: null,
			kana_name: null,
			phone: null,
			address: null,
			optional_name: null,
			optional_phone: null,
			updated_at: new Date().toISOString(),
		})
		.eq('user_id', userId);

	if (!isMissingOptionalProfileColumnError(primaryResult.error as SupabaseRouteError | null)) {
		return primaryResult;
	}

	return supabase
		.from('profiles')
		.update({
			display_name: null,
			kana_name: null,
			phone: null,
			address: null,
		})
		.eq('user_id', userId);
}

export async function GET(request: NextRequest) {
	const supabase = await createClient(request);
	const {
		data: { user },
		error: userError,
	} = await resolveRequestUser(supabase, request);

	if (userError || !user) {
		console.error('Profile auth error:', userError);
		return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
	}

	const { data: profile, error } = await fetchProfileRow(supabase, user.id);

	if (error) {
		console.error('Profile fetch error:', error);
		return NextResponse.json({ error: 'Database error' }, { status: 500 });
	}

	return NextResponse.json({
		email: user.email ?? '',
		fullName: profile?.display_name ?? profile?.optional_name ?? '',
		kanaName: profile?.kana_name ?? '',
		phone: formatPhoneNumberInput(profile?.phone ?? profile?.optional_phone ?? ''),
		address: resolveProfileAddress(profile ?? null),
	});
}

export async function POST(request: NextRequest) {
	const supabase = await createClient(request);
	const {
		data: { user },
		error: userError,
	} = await resolveRequestUser(supabase, request);

	if (userError || !user) {
		console.error('Profile auth error:', userError);
		return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
	}

	const { requireCsrfOrDeny } = await import('@/lib/csrfMiddleware');
	const csrfResult = await requireCsrfOrDeny();
	if (isCsrfDenyResponse(csrfResult)) {
		const denyResponse = NextResponse.json(csrfResult._body, { status: csrfResult.status });
		if (csrfResult.headers) {
			for (const [key, value] of Object.entries(csrfResult.headers)) {
				denyResponse.headers.set(key, value);
			}
		}
		return denyResponse;
	}

	const rawBody = await request.json().catch(() => null);
	const parsedBody = profilePayloadSchema.safeParse(rawBody);

	if (!parsedBody.success) {
		return NextResponse.json(
			{
				error: 'Invalid profile payload',
				details: parsedBody.error.flatten(),
			},
			{ status: 400 },
		);
	}

	const fullName = parsedBody.data.fullName.trim();
	const kanaName = parsedBody.data.kanaName.trim();
	const phone = formatPhoneNumberInput(parsedBody.data.phone.trim());
	// 住所は /api/profile/addresses が管理。プロフィール保存では更新しない。

	const { error } = await upsertProfileRow(supabase, user.id, fullName, kanaName, phone);

	if (error) {
		console.error('Profile upsert error:', error);
		return NextResponse.json({ error: 'Database error' }, { status: 500 });
	}

	// レスポンスの address は現在の保存値（addresses のデフォルト）を返す
	const { data: refreshed } = await fetchProfileRow(supabase, user.id);

	const response = NextResponse.json({
		success: true,
		email: user.email ?? '',
		fullName,
		kanaName,
		phone,
		address: resolveProfileAddress(refreshed ?? null),
	});

	if (hasRotatedCsrfToken(csrfResult)) {
		const { csrfCookieName, cookieOptionsForCsrf } = await import('@/lib/cookie');
		response.cookies.set({ name: csrfCookieName, value: csrfResult.rotatedCsrfToken, ...cookieOptionsForCsrf(0) });
	}

	return response;
}

export async function DELETE(request: NextRequest) {
	const supabase = await createClient(request);
	const {
		data: { user },
		error: userError,
	} = await resolveRequestUser(supabase, request);

	if (userError || !user) {
		console.error('Profile auth error:', userError);
		return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
	}

	const { requireCsrfOrDeny } = await import('@/lib/csrfMiddleware');
	const csrfResult = await requireCsrfOrDeny();
	if (isCsrfDenyResponse(csrfResult)) {
		const denyResponse = NextResponse.json(csrfResult._body, { status: csrfResult.status });
		if (csrfResult.headers) {
			for (const [key, value] of Object.entries(csrfResult.headers)) {
				denyResponse.headers.set(key, value);
			}
		}
		return denyResponse;
	}

	const { error } = await clearProfileRow(supabase, user.id);

	if (error) {
		console.error('Profile delete error:', error);
		return NextResponse.json({ error: 'Database error' }, { status: 500 });
	}

	const response = NextResponse.json({ success: true });
	if (hasRotatedCsrfToken(csrfResult)) {
		const { csrfCookieName, cookieOptionsForCsrf } = await import('@/lib/cookie');
		response.cookies.set({ name: csrfCookieName, value: csrfResult.rotatedCsrfToken, ...cookieOptionsForCsrf(0) });
	}

	return response;
}
