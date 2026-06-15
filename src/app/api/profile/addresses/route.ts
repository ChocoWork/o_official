import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient, resolveRequestUser } from '@/lib/supabase/server';

const addressItemSchema = z.object({
	id: z.string().trim().max(64).optional(),
	postalCode: z.string().trim().max(16).optional().default(''),
	prefecture: z.string().trim().max(100).optional().default(''),
	city: z.string().trim().max(200).optional().default(''),
	address: z.string().trim().max(500).optional().default(''),
	building: z.string().trim().max(500).optional().default(''),
	isDefault: z.boolean().optional().default(false),
});

const addressesPayloadSchema = z.object({
	addresses: z.array(addressItemSchema).max(20),
});

type AddressItem = {
	id: string;
	postalCode: string;
	prefecture: string;
	city: string;
	address: string;
	building: string;
	isDefault: boolean;
};

type StoredAddress = Partial<Omit<AddressItem, 'isDefault'>> & { isDefault?: boolean | null };

type ProfileAddressesRow = {
	address: StoredAddress | null;
	addresses: StoredAddress[] | null;
};

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

function isMissingAddressesColumnError(error: SupabaseRouteError | null) {
	if (!error) {
		return false;
	}

	if (error.code === '42703' || error.code === 'PGRST204') {
		return true;
	}

	const text = [error.message, error.details, error.hint].filter(Boolean).join(' ');
	return /addresses/i.test(text);
}

function str(value: unknown) {
	return typeof value === 'string' ? value : '';
}

function toAddressFields(address: StoredAddress | null) {
	return {
		postalCode: str(address?.postalCode),
		prefecture: str(address?.prefecture),
		city: str(address?.city),
		address: str(address?.address),
		building: str(address?.building),
	};
}

function hasAddressValue(address: ReturnType<typeof toAddressFields>) {
	return Object.values(address).some((value) => value.trim().length > 0);
}

// Normalize a list so exactly one entry is the default (first wins; first entry
// becomes default if none is marked) and every entry has an id.
function normalizeAddressList(items: StoredAddress[]): AddressItem[] {
	const cleaned = items
		.map((item) => ({
			id: item.id && item.id.trim() ? item.id.trim() : crypto.randomUUID(),
			...toAddressFields(item),
			isDefault: Boolean(item.isDefault),
		}))
		.filter((item) => hasAddressValue(item));

	if (cleaned.length === 0) {
		return [];
	}

	let defaultAssigned = false;
	return cleaned.map((item) => {
		const isDefault = item.isDefault && !defaultAssigned;
		if (isDefault) {
			defaultAssigned = true;
		}
		return { ...item, isDefault };
	}).map((item, index) => ({
		...item,
		isDefault: defaultAssigned ? item.isDefault : index === 0,
	}));
}

// Derive the addresses list for GET, falling back to the legacy single address.
function deriveAddressList(row: ProfileAddressesRow | null): AddressItem[] {
	if (Array.isArray(row?.addresses) && row.addresses.length > 0) {
		return normalizeAddressList(row.addresses);
	}

	const legacy = toAddressFields(row?.address ?? null);
	if (hasAddressValue(legacy)) {
		return [{ id: crypto.randomUUID(), ...legacy, isDefault: true }];
	}

	return [];
}

async function upsertProfileAddresses(
	supabase: Awaited<ReturnType<typeof createClient>>,
	userId: string,
	addresses: AddressItem[],
	mirroredAddress: ReturnType<typeof toAddressFields> | null,
) {
	const primaryResult = await supabase
		.from('profiles')
		.upsert({ user_id: userId, addresses: addresses.length > 0 ? addresses : null, address: mirroredAddress }, { onConflict: 'user_id' });

	if (!isMissingAddressesColumnError(primaryResult.error as SupabaseRouteError | null)) {
		return primaryResult;
	}

	// Legacy schema without the `addresses` column: persist the default only.
	return supabase.from('profiles').upsert({ user_id: userId, address: mirroredAddress }, { onConflict: 'user_id' });
}

async function fetchProfileAddressesRow(supabase: Awaited<ReturnType<typeof createClient>>, userId: string) {
	const primaryResult = await supabase.from('profiles').select('address, addresses').eq('user_id', userId).maybeSingle<ProfileAddressesRow>();

	if (!isMissingAddressesColumnError(primaryResult.error as SupabaseRouteError | null)) {
		return primaryResult;
	}

	const fallbackResult = await supabase.from('profiles').select('address').eq('user_id', userId).maybeSingle<{ address: StoredAddress | null }>();

	if (fallbackResult.error) {
		return fallbackResult;
	}

	return {
		data: fallbackResult.data ? { address: fallbackResult.data.address, addresses: null } : null,
		error: null,
	};
}

export async function GET(request: NextRequest) {
	const supabase = await createClient(request);
	const {
		data: { user },
		error: userError,
	} = await resolveRequestUser(supabase, request);

	if (userError || !user) {
		console.error('Profile addresses auth error:', userError);
		return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
	}

	const { data: row, error } = await fetchProfileAddressesRow(supabase, user.id);

	if (error) {
		console.error('Profile addresses fetch error:', error);
		return NextResponse.json({ error: 'Database error' }, { status: 500 });
	}

	return NextResponse.json({ addresses: deriveAddressList(row) });
}

export async function PUT(request: NextRequest) {
	const supabase = await createClient(request);
	const {
		data: { user },
		error: userError,
	} = await resolveRequestUser(supabase, request);

	if (userError || !user) {
		console.error('Profile addresses auth error:', userError);
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
	const parsedBody = addressesPayloadSchema.safeParse(rawBody);

	if (!parsedBody.success) {
		return NextResponse.json({ error: 'Invalid addresses payload', details: parsedBody.error.flatten() }, { status: 400 });
	}

	const addresses = normalizeAddressList(parsedBody.data.addresses);
	const defaultAddress = addresses.find((item) => item.isDefault) ?? null;
	const mirroredAddress = defaultAddress
		? {
				postalCode: defaultAddress.postalCode,
				prefecture: defaultAddress.prefecture,
				city: defaultAddress.city,
				address: defaultAddress.address,
				building: defaultAddress.building,
		  }
		: null;

	const { error } = await upsertProfileAddresses(supabase, user.id, addresses, mirroredAddress);

	if (error) {
		console.error('Profile addresses update error:', error);
		return NextResponse.json({ error: 'Database error' }, { status: 500 });
	}

	const response = NextResponse.json({ success: true, addresses });

	if (hasRotatedCsrfToken(csrfResult)) {
		const { csrfCookieName, cookieOptionsForCsrf } = await import('@/lib/cookie');
		response.cookies.set({ name: csrfCookieName, value: csrfResult.rotatedCsrfToken, ...cookieOptionsForCsrf(0) });
	}

	return response;
}
