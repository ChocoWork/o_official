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

type ProfileRow = {
	display_name: string | null;
	kana_name: string | null;
	phone: string | null;
	address: {
		postalCode?: string | null;
		prefecture?: string | null;
		city?: string | null;
		address?: string | null;
		building?: string | null;
	} | null;
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

function isMissingOptionalProfileColumnError(error: SupabaseRouteError | null) {
	if (!error) {
		return false;
	}

	if (error.code === '42703' || error.code === 'PGRST204') {
		return true;
	}

	const text = [error.message, error.details, error.hint].filter(Boolean).join(' ');
	return /optional_name|optional_phone|updated_at/i.test(text);
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

function hasAddressValue(address: ReturnType<typeof normalizeAddress>) {
	return Object.values(address).some((value) => value.trim().length > 0);
}

async function fetchProfileRow(supabase: Awaited<ReturnType<typeof createClient>>, userId: string) {
	const primaryResult = await supabase
		.from('profiles')
		.select('display_name, kana_name, phone, address, optional_name, optional_phone')
		.eq('user_id', userId)
		.maybeSingle<ProfileRow>();

	if (!isMissingOptionalProfileColumnError(primaryResult.error as SupabaseRouteError | null)) {
		return primaryResult;
	}

	const fallbackResult = await supabase
		.from('profiles')
		.select('display_name, kana_name, phone, address')
		.eq('user_id', userId)
		.maybeSingle<LegacyProfileRow>();

	if (fallbackResult.error) {
		return fallbackResult;
	}

	return {
		data: fallbackResult.data
			? {
					...fallbackResult.data,
					optional_name: null,
					optional_phone: null,
			  }
			: null,
		error: null,
	};
}

function buildProfileUpsertPayload(userId: string, fullName: string, kanaName: string, phone: string, address: ReturnType<typeof normalizeAddress>) {
	return {
		user_id: userId,
		display_name: fullName || null,
		kana_name: kanaName || null,
		phone: phone || null,
		address: hasAddressValue(address) ? address : null,
		optional_name: fullName || null,
		optional_phone: phone || null,
		updated_at: new Date().toISOString(),
	};
}

function buildLegacyProfileUpsertPayload(userId: string, fullName: string, kanaName: string, phone: string, address: ReturnType<typeof normalizeAddress>) {
	return {
		user_id: userId,
		display_name: fullName || null,
		kana_name: kanaName || null,
		phone: phone || null,
		address: hasAddressValue(address) ? address : null,
	};
}

async function upsertProfileRow(supabase: Awaited<ReturnType<typeof createClient>>, userId: string, fullName: string, kanaName: string, phone: string, address: ReturnType<typeof normalizeAddress>) {
	const primaryResult = await supabase.from('profiles').upsert(buildProfileUpsertPayload(userId, fullName, kanaName, phone, address), {
		onConflict: 'user_id',
	});

	if (!isMissingOptionalProfileColumnError(primaryResult.error as SupabaseRouteError | null)) {
		return primaryResult;
	}

	return supabase.from('profiles').upsert(buildLegacyProfileUpsertPayload(userId, fullName, kanaName, phone, address), {
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
		address: normalizeAddress(profile?.address ?? null),
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
	const address = normalizeAddress(parsedBody.data.address);

	const { error } = await upsertProfileRow(supabase, user.id, fullName, kanaName, phone, address);

	if (error) {
		console.error('Profile upsert error:', error);
		return NextResponse.json({ error: 'Database error' }, { status: 500 });
	}

	return NextResponse.json({
		success: true,
		email: user.email ?? '',
		fullName,
		kanaName,
		phone,
		address,
	});
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

	const { error } = await clearProfileRow(supabase, user.id);

	if (error) {
		console.error('Profile delete error:', error);
		return NextResponse.json({ error: 'Database error' }, { status: 500 });
	}

	return NextResponse.json({ success: true });
}
