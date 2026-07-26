import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { logAudit } from '@/lib/audit';
import { createServiceRoleClient } from '@/lib/supabase/server';

// 証憑（電子取引データ）のアップロードと閲覧。
// バケットは非公開なので、閲覧は短命の署名付きURLで行う。
const RECEIPT_BUCKET = 'finance-receipts';
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const SIGNED_URL_TTL_SECONDS = 300;

// 電子取引データとして想定される形式のみ許可する。
const ALLOWED_MIME_TYPES = [
	'application/pdf',
	'image/jpeg',
	'image/png',
	'image/webp',
	'image/heic',
];

const receiptPathSchema = z.string().trim().min(1).max(500);

/** 閲覧用の署名付きURLを発行する。 */
export async function GET(request: Request) {
	try {
		const authz = await authorizeAdminPermission('admin.finance.read', request);
		if (!authz.ok) return authz.response;

		const url = new URL(request.url);
		const parsedPath = receiptPathSchema.safeParse(url.searchParams.get('path'));
		if (!parsedPath.success) {
			return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
		}

		const supabase = await createServiceRoleClient();
		// 登録済みの証憑だけを対象にする（任意パスの署名を防ぐ）。
		const { data: receipt, error: lookupError } = await supabase
			.from('admin_finance_receipts')
			.select('id, storage_path, file_name')
			.eq('storage_path', parsedPath.data)
			.maybeSingle();

		if (lookupError) throw lookupError;
		if (!receipt) {
			return NextResponse.json({ error: '証憑が見つかりません。' }, { status: 404 });
		}

		const { data, error } = await supabase.storage
			.from(RECEIPT_BUCKET)
			.createSignedUrl(receipt.storage_path, SIGNED_URL_TTL_SECONDS);

		if (error || !data?.signedUrl) throw error ?? new Error('Failed to sign URL');

		return NextResponse.json({
			data: { url: data.signedUrl, fileName: receipt.file_name, expiresIn: SIGNED_URL_TTL_SECONDS },
		});
	} catch (error) {
		console.error('GET /api/admin/kpi/cost-profit/receipt error:', error);
		return NextResponse.json({ error: '証憑の取得に失敗しました。' }, { status: 500 });
	}
}

/** 証憑ファイルのアップロード。multipart/form-data で受け取る。 */
export async function POST(request: Request) {
	let authz: Awaited<ReturnType<typeof authorizeAdminPermission>> | null = null;

	try {
		authz = await authorizeAdminPermission('admin.finance.manage', request);
		if (!authz.ok) return authz.response;

		const { requireCsrfOrDeny } = await import('@/lib/csrfMiddleware');
		const csrfResult = await requireCsrfOrDeny();
		if (csrfResult instanceof Response) return csrfResult;

		const formData = await request.formData().catch(() => null);
		const file = formData?.get('file');
		const entryIdRaw = formData?.get('entryId');

		if (!(file instanceof File)) {
			return NextResponse.json({ error: 'ファイルを選択してください。' }, { status: 400 });
		}
		const parsedEntryId = z.coerce.number().int().positive().safeParse(entryIdRaw);
		if (!parsedEntryId.success) {
			return NextResponse.json({ error: 'Invalid entryId' }, { status: 400 });
		}
		if (file.size <= 0 || file.size > MAX_FILE_SIZE) {
			return NextResponse.json(
				{ error: 'ファイルサイズは20MB以下にしてください。' },
				{ status: 400 },
			);
		}
		if (!ALLOWED_MIME_TYPES.includes(file.type)) {
			return NextResponse.json(
				{ error: 'PDFまたは画像（JPEG/PNG/WebP/HEIC）を添付してください。' },
				{ status: 400 },
			);
		}

		const supabase = await createServiceRoleClient();
		// 添付先の取引が存在し、削除されていないことを確認する。
		const { data: entry, error: entryError } = await supabase
			.from('admin_finance_expenses')
			.select('id, fiscal_year, expense_date')
			.eq('id', parsedEntryId.data)
			.is('deleted_at', null)
			.maybeSingle();

		if (entryError) throw entryError;
		if (!entry) {
			return NextResponse.json({ error: '取引が見つかりません。' }, { status: 404 });
		}

		// 年度/取引ID/タイムスタンプ でパスを作る。ファイル名の衝突と推測を避ける。
		const extension = file.name.split('.').pop()?.toLowerCase().slice(0, 10) ?? 'bin';
		const storagePath = `${entry.fiscal_year}/${entry.id}/${Date.now()}-${crypto.randomUUID()}.${extension}`;

		const { error: uploadError } = await supabase.storage
			.from(RECEIPT_BUCKET)
			.upload(storagePath, file, { contentType: file.type, upsert: false });

		if (uploadError) throw uploadError;

		const { data: inserted, error: insertError } = await supabase
			.from('admin_finance_receipts')
			.insert({
				entry_id: entry.id,
				storage_path: storagePath,
				file_name: file.name.slice(0, 255),
				mime_type: file.type,
				file_size: file.size,
				uploaded_by: authz.userId,
			})
			.select('id')
			.single();

		if (insertError) {
			// メタデータの登録に失敗したらファイルを残さない。
			await supabase.storage.from(RECEIPT_BUCKET).remove([storagePath]);
			throw insertError;
		}

		await logAudit({
			action: 'admin.finance.receipt.attach',
			actor_id: authz.userId,
			actor_email: authz.actorEmail,
			resource: 'finance',
			resource_id: String(inserted.id),
			outcome: 'success',
			detail: `Attached receipt to entry ${entry.id}`,
			ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
			user_agent: request.headers.get('user-agent') ?? null,
			metadata: { entry_id: entry.id, storage_path: storagePath, file_size: file.size },
		});

		const response = NextResponse.json({
			data: { id: inserted.id, storagePath, fileName: file.name, mimeType: file.type, fileSize: file.size },
		});

		if (
			csrfResult
			&& typeof csrfResult === 'object'
			&& 'rotatedCsrfToken' in csrfResult
			&& typeof csrfResult.rotatedCsrfToken === 'string'
		) {
			const { csrfCookieName, csrfCookieMaxAgeSeconds, cookieOptionsForCsrf } = await import('@/lib/cookie');
			response.cookies.set({
				name: csrfCookieName,
				value: csrfResult.rotatedCsrfToken,
				...cookieOptionsForCsrf(csrfCookieMaxAgeSeconds),
			});
		}

		return response;
	} catch (error) {
		console.error('POST /api/admin/kpi/cost-profit/receipt error:', error);
		if (authz?.ok) {
			await logAudit({
				action: 'admin.finance.receipt.attach',
				actor_id: authz.userId,
				actor_email: authz.actorEmail,
				resource: 'finance',
				outcome: 'failure',
				detail: error instanceof Error ? error.message : 'Receipt upload failed',
			});
		}
		return NextResponse.json({ error: '証憑のアップロードに失敗しました。' }, { status: 500 });
	}
}
