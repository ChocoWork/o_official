import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

// GET: Retrieve optional profile (name + phone)
export async function GET() {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();

	if (!user) {
		return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
	}

	const { data: profile, error } = await supabase
		.from('profiles')
		.select('optional_name, optional_phone')
		.eq('user_id', user.id)
		.single();

	if (error && error.code !== 'PGRST116') {
		// PGRST116 = row not found
		console.error('Profile fetch error:', error);
		return NextResponse.json({ error: 'Database error' }, { status: 500 });
	}

	return NextResponse.json({
		fullName: profile?.optional_name ?? '',
		phone: profile?.optional_phone ?? '',
	});
}

// POST: Upsert optional profile
export async function POST(req: NextRequest) {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();

	if (!user) {
		return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
	}

	const body = await req.json();
	const fullName = typeof body.fullName === 'string' ? body.fullName.trim() : '';
	const phone = typeof body.phone === 'string' ? body.phone.trim() : '';

	// Upsert profile
	const { error } = await supabase
		.from('profiles')
		.upsert(
			{
				user_id: user.id,
				optional_name: fullName || null,
				optional_phone: phone || null,
				updated_at: new Date().toISOString(),
			},
			{ onConflict: 'user_id' }
		);

	if (error) {
		console.error('Profile upsert error:', error);
		return NextResponse.json({ error: 'Database error' }, { status: 500 });
	}

	return NextResponse.json({ success: true, fullName, phone });
}

// DELETE: Clear optional profile fields
export async function DELETE() {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();

	if (!user) {
		return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
	}

	const { error } = await supabase
		.from('profiles')
		.update({
			optional_name: null,
			optional_phone: null,
			updated_at: new Date().toISOString(),
		})
		.eq('user_id', user.id);

	if (error) {
		console.error('Profile delete error:', error);
		return NextResponse.json({ error: 'Database error' }, { status: 500 });
	}

	return NextResponse.json({ success: true });
}
