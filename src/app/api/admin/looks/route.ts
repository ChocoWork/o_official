/**
 * 管理の LOOK 一覧の取り出しと作成の窓口（src/app/api/admin/looks/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-LOOK-141
 * @design DD-LOOK-063
 * @remarks 非公開を含む一覧は読む権限、作成は管理の権限と、操作ごとに権限を分けて窓口で確かめる（SEC-LOOK-019）。
 * 一覧の応答には、呼んだ人が操作ボタンを使えるかを meta.canManage で添え、画面が権限の無い人にボタンを出さないようにする。
 * 作成は表と非公開の置き場の両方を変えるので、送り元と操作者の2段の回数と画像の量に上限をかけ（SEC-LOOK-011）、
 * 形の悪い要求は DB と置き場に触れる前に入口で断る。
 * 画像は申告の種類と中身の印が合う物だけを、量の枠を使う前に受け、保存名は検出した種類から自分で作る（SEC-LOOK-013）。
 * 途中で失敗したら上げた画像を置き場から消し、関連の保存に失敗したら作った LOOK の行も消して、残骸を残さない（SEC-LOOK-014）。
 * 失敗の監査は認可が通って操作者が分かった後だけ残す。誤りの文は応答にも記録にも出さない（SEC-LOOK-021）。
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import {
  consumeAdminLookUploadQuota,
  enforceAdminLookMutationRateLimit,
  validateLookImageBatch,
} from '@/features/look/services/admin-rate-limit';
import { logAdminLookAudit } from '@/features/look/services/admin-audit';
import {
  LOOK_IMAGE_BUCKET,
  buildLookImagePath,
  prepareLookImage,
  removeLookImages,
  type PreparedLookImage,
} from '@/features/look/services/admin-images';
import { describeErrorForLog } from '@/lib/logging/safe-error';
import { signLookImageUrls } from '@/lib/storage/look-images';

const lookStatusSchema = z.enum(['private', 'published']);

const createLookSchema = z.object({
  seasonYear: z.coerce.number().int().min(2000).max(2100),
  seasonType: z.enum(['SS', 'AW']),
  theme: z.string().trim().min(1).max(200),
  themeDescription: z.string().trim().max(4000),
  status: lookStatusSchema,
  linkedItemIds: z.array(z.coerce.number().int().positive()).min(1),
});

const allowedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const maxImageBytes = 5 * 1024 * 1024;

function parseJsonField<T>(value: FormDataEntryValue | null, schema: z.ZodType<T>): T {
  if (typeof value !== 'string') {
    throw new z.ZodError([
      {
        code: 'custom',
        message: 'Invalid form field',
        path: [],
      },
    ]);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(value);
  } catch {
    throw new z.ZodError([
      {
        code: 'custom',
        message: 'Malformed JSON payload',
        path: [],
      },
    ]);
  }

  return schema.parse(parsedJson);
}

/** 置き場の削除が失敗した時だけ、監査に残す件数を返す。 */
function cleanupMetadata(result: 'ok' | 'failed', count: number): Record<string, unknown> {
  return result === 'failed' ? { image_cleanup: 'failed', orphaned_count: count } : {};
}

export async function POST(request: Request) {
  let actorId: string | null = null;
  let actorEmail: string | null = null;
  // 上げた画像のうち、まだどの行も指していない物。例外の時にここから消す。
  let unreferencedPaths: string[] = [];
  let supabaseForCleanup: Awaited<ReturnType<typeof createServiceRoleClient>> | null = null;

  try {
    const authz = await authorizeAdminPermission('admin.looks.manage', request);
    if (!authz.ok) {
      return authz.response;
    }

    actorId = authz.userId;
    actorEmail = authz.actorEmail;

    const rateLimited = await enforceAdminLookMutationRateLimit({
      request,
      actorId: authz.userId,
      kind: 'create',
    });

    if (rateLimited) {
      return rateLimited;
    }

    const formData = await request.formData();

    const parsedPayload = createLookSchema.safeParse({
      seasonYear: formData.get('seasonYear'),
      seasonType: formData.get('seasonType'),
      theme: formData.get('theme'),
      themeDescription: formData.get('themeDescription') ?? '',
      status: formData.get('status'),
      linkedItemIds: parseJsonField(formData.get('linkedItemIds'), z.array(z.number())),
    });

    if (!parsedPayload.success) {
      await logAdminLookAudit({
        request,
        actorId: authz.userId,
        actorEmail: authz.actorEmail,
        action: 'admin.look.create',
        outcome: 'failure',
        detail: 'Invalid create payload',
        metadata: {
          invalid_fields: Object.keys(parsedPayload.error.flatten().fieldErrors),
        },
      });

      return NextResponse.json(
        {
          error: 'Invalid request',
          details: parsedPayload.error.flatten(),
        },
        { status: 400 }
      );
    }

    const imageFiles = formData.getAll('images').filter((file): file is File => file instanceof File);

    if (imageFiles.length === 0) {
      await logAdminLookAudit({
        request,
        actorId: authz.userId,
        actorEmail: authz.actorEmail,
        action: 'admin.look.create',
        outcome: 'failure',
        detail: 'No image files provided',
        metadata: {
          linked_item_ids: parsedPayload.data.linkedItemIds,
          status: parsedPayload.data.status,
        },
      });

      return NextResponse.json({ error: 'At least one image is required' }, { status: 400 });
    }

    const imageBatchError = validateLookImageBatch(imageFiles);
    if (imageBatchError) {
      await logAdminLookAudit({
        request,
        actorId: authz.userId,
        actorEmail: authz.actorEmail,
        action: 'admin.look.create',
        outcome: 'failure',
        detail: imageBatchError,
        metadata: {
          image_count: imageFiles.length,
          linked_item_ids: parsedPayload.data.linkedItemIds,
          status: parsedPayload.data.status,
        },
      });

      return NextResponse.json({ error: imageBatchError }, { status: 400 });
    }

    const preparedImages: PreparedLookImage[] = [];

    for (const image of imageFiles) {
      if (!allowedImageTypes.has(image.type)) {
        await logAdminLookAudit({
          request,
          actorId: authz.userId,
          actorEmail: authz.actorEmail,
          action: 'admin.look.create',
          outcome: 'failure',
          detail: 'Unsupported image type',
          metadata: {
            image_type: image.type,
            image_count: imageFiles.length,
          },
        });

        return NextResponse.json({ error: 'Unsupported image type' }, { status: 400 });
      }

      if (image.size > maxImageBytes) {
        await logAdminLookAudit({
          request,
          actorId: authz.userId,
          actorEmail: authz.actorEmail,
          action: 'admin.look.create',
          outcome: 'failure',
          detail: 'Image size limit exceeded',
          metadata: {
            image_size: image.size,
            image_type: image.type,
          },
        });

        return NextResponse.json({ error: 'Image size must be 5MB or less' }, { status: 400 });
      }

      // 申告の種類と中身の印が合う物だけを受ける。置き場に書く前・量の枠を使う前に済ませる。
      const prepared = await prepareLookImage(image);
      if (!prepared) {
        await logAdminLookAudit({
          request,
          actorId: authz.userId,
          actorEmail: authz.actorEmail,
          action: 'admin.look.create',
          outcome: 'failure',
          detail: 'Unsupported image type',
          metadata: {
            image_type: image.type,
            image_count: imageFiles.length,
          },
        });

        return NextResponse.json({ error: 'Unsupported image type' }, { status: 400 });
      }

      preparedImages.push(prepared);
    }

    const supabase = await createServiceRoleClient();
    supabaseForCleanup = supabase;

    const { data: existingItems, error: fetchItemsError } = await supabase
      .from('items')
      .select('id')
      .in('id', parsedPayload.data.linkedItemIds);

    if (fetchItemsError) {
      await logAdminLookAudit({
        request,
        actorId: authz.userId,
        actorEmail: authz.actorEmail,
        action: 'admin.look.create',
        outcome: 'failure',
        detail: 'Failed to validate linked items',
        metadata: {
          linked_item_ids: parsedPayload.data.linkedItemIds,
          status: parsedPayload.data.status,
        },
      });

      console.error('Failed to validate linked items:', describeErrorForLog(fetchItemsError));
      return NextResponse.json({ error: 'Failed to validate linked items' }, { status: 500 });
    }

    if (!existingItems || existingItems.length !== parsedPayload.data.linkedItemIds.length) {
      await logAdminLookAudit({
        request,
        actorId: authz.userId,
        actorEmail: authz.actorEmail,
        action: 'admin.look.create',
        outcome: 'failure',
        detail: 'Some linked items do not exist',
        metadata: {
          linked_item_ids: parsedPayload.data.linkedItemIds,
          status: parsedPayload.data.status,
        },
      });

      return NextResponse.json({ error: 'Some linked items do not exist' }, { status: 400 });
    }

    const uploadQuotaResponse = await consumeAdminLookUploadQuota({
      actorId: authz.userId,
      kind: 'create',
      totalBytes: imageFiles.reduce((sum, image) => sum + image.size, 0),
    });

    if (uploadQuotaResponse) {
      return uploadQuotaResponse;
    }

    const imageUrls: string[] = [];

    for (const prepared of preparedImages) {
      const filePath = buildLookImagePath(prepared.extension);

      const { error: uploadError } = await supabase.storage.from(LOOK_IMAGE_BUCKET).upload(filePath, prepared.buffer, {
        contentType: prepared.contentType,
        cacheControl: '3600',
        upsert: false,
      });

      if (uploadError) {
        const cleanup = await removeLookImages(supabase, imageUrls);
        unreferencedPaths = [];

        await logAdminLookAudit({
          request,
          actorId: authz.userId,
          actorEmail: authz.actorEmail,
          action: 'admin.look.create',
          outcome: 'failure',
          detail: 'Failed to upload look image',
          metadata: {
            image_type: prepared.contentType,
            status: parsedPayload.data.status,
            linked_item_ids: parsedPayload.data.linkedItemIds,
            ...cleanupMetadata(cleanup, imageUrls.length),
          },
        });

        console.error('Failed to upload look image:', describeErrorForLog(uploadError));
        return NextResponse.json({ error: 'Failed to upload image' }, { status: 500 });
      }

      // Store the file path (not a public URL) so signed URLs can be
      // generated at serve time after the bucket was made private.
      imageUrls.push(filePath);
      unreferencedPaths = [...imageUrls];
    }

    const { data: lookData, error: insertLookError } = await supabase
      .from('looks')
      .insert([
        {
          season_year: parsedPayload.data.seasonYear,
          season_type: parsedPayload.data.seasonType,
          theme: parsedPayload.data.theme,
          theme_description: parsedPayload.data.themeDescription,
          image_urls: imageUrls,
          status: parsedPayload.data.status,
        },
      ])
      .select('id')
      .single();

    if (insertLookError || !lookData) {
      const cleanup = await removeLookImages(supabase, imageUrls);
      unreferencedPaths = [];

      await logAdminLookAudit({
        request,
        actorId: authz.userId,
        actorEmail: authz.actorEmail,
        action: 'admin.look.create',
        outcome: 'failure',
        detail: 'Failed to insert look',
        metadata: {
          status: parsedPayload.data.status,
          linked_item_ids: parsedPayload.data.linkedItemIds,
          image_count: imageFiles.length,
          ...cleanupMetadata(cleanup, imageUrls.length),
        },
      });

      console.error('Failed to create look:', describeErrorForLog(insertLookError));
      return NextResponse.json({ error: 'Failed to save look' }, { status: 500 });
    }

    // 行が画像の道筋を指したので、この先の例外では画像を消さない（行が消えた画像を指さないように）。
    unreferencedPaths = [];

    const lookItemsPayload = parsedPayload.data.linkedItemIds.map((itemId) => ({
      look_id: lookData.id,
      item_id: itemId,
    }));

    const { error: insertLookItemsError } = await supabase.from('look_items').insert(lookItemsPayload);

    if (insertLookItemsError) {
      // 行を消すので、行が指していた画像も残骸になる。行を消せた時だけ、置き場から消す
      // （行が残ったまま画像だけ消えると、公開の頁に壊れた画像の LOOK が出る）。
      const { error: deleteLookError } = await supabase.from('looks').delete().eq('id', lookData.id);
      const rowDeleted = !deleteLookError;
      const cleanup = rowDeleted ? await removeLookImages(supabase, imageUrls) : 'ok';
      if (deleteLookError) {
        console.error('Failed to delete look after link failure:', describeErrorForLog(deleteLookError));
      }

      await logAdminLookAudit({
        request,
        actorId: authz.userId,
        actorEmail: authz.actorEmail,
        action: 'admin.look.create',
        outcome: 'failure',
        detail: 'Failed to create look-item links',
        resourceId: lookData.id,
        metadata: {
          status: parsedPayload.data.status,
          linked_item_ids: parsedPayload.data.linkedItemIds,
          ...(rowDeleted ? {} : { row_cleanup: 'failed' }),
          ...cleanupMetadata(cleanup, imageUrls.length),
        },
      });

      console.error('Failed to create look-item links:', describeErrorForLog(insertLookItemsError));
      return NextResponse.json({ error: 'Failed to save linked items' }, { status: 500 });
    }

    await logAdminLookAudit({
      request,
      actorId: authz.userId,
      actorEmail: authz.actorEmail,
      action: 'admin.look.create',
      outcome: 'success',
      detail: 'Look created',
      resourceId: lookData.id,
      metadata: {
        status: parsedPayload.data.status,
        linked_item_ids: parsedPayload.data.linkedItemIds,
        image_count: imageFiles.length,
        season_year: parsedPayload.data.seasonYear,
        season_type: parsedPayload.data.seasonType,
      },
    });

    return NextResponse.json({ success: true, id: lookData.id }, { status: 201 });
  } catch (error) {
    if (supabaseForCleanup && unreferencedPaths.length > 0) {
      await removeLookImages(supabaseForCleanup, unreferencedPaths);
    }

    if (actorId) {
      await logAdminLookAudit({
        request,
        actorId,
        actorEmail,
        action: 'admin.look.create',
        outcome: 'failure',
        detail: error instanceof z.ZodError ? 'Invalid create payload' : 'Unexpected create error',
        metadata: error instanceof z.ZodError
          ? { invalid_fields: Object.keys(error.flatten().fieldErrors) }
          : undefined,
      });
    }

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          error: 'Invalid request',
          details: error.flatten(),
        },
        { status: 400 }
      );
    }

    console.error('POST /api/admin/looks error:', describeErrorForLog(error));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function GET(request: Request) {
  try {
    const authz = await authorizeAdminPermission('admin.looks.read', request);
    if (!authz.ok) {
      return authz.response;
    }

    // 画面が権限の無い人に操作ボタンを出さないよう、管理の権限があるかを添える。
    // 権限が無いための断り（403）だけ false にし、認証の失敗・一時的な障害はそのまま返す。
    const manage = await authorizeAdminPermission('admin.looks.manage', request);
    if (!manage.ok && manage.response.status !== 403) {
      return manage.response;
    }
    const canManage = manage.ok;

    const supabase = await createServiceRoleClient();

    const { data, error } = await supabase
      .from('looks')
      .select(
        `
          id,
          season_year,
          season_type,
          theme,
          theme_description,
          image_urls,
          status,
          created_at,
          look_items(item_id)
        `
      )
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Failed to fetch looks:', describeErrorForLog(error));
      return NextResponse.json({ error: 'Failed to fetch looks' }, { status: 500 });
    }

    // Generate short-lived signed URLs so admin can preview images from the private bucket
    const signedData = await Promise.all(
      (data ?? []).map(async (look) => ({
        ...look,
        image_urls: await signLookImageUrls(supabase, look.image_urls ?? []),
      }))
    );

    return NextResponse.json({ data: signedData, meta: { canManage } }, { status: 200 });
  } catch (error) {
    console.error('GET /api/admin/looks error:', describeErrorForLog(error));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
