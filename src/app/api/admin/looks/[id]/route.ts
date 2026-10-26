/**
 * 管理の LOOK 1件の取り出し・全体の更新・公開の状態の切り替え・削除の窓口（src/app/api/admin/looks/[id]/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-LOOK-142
 * @design DD-LOOK-064
 * @remarks 取り出しは読む権限、表を変える3つの操作は管理の権限と、操作ごとに権限を分けて窓口で確かめる（SEC-LOOK-019）。
 * 変更は種類ごとに送り元と操作者の2段の回数を数える（SEC-LOOK-011）。
 * id は URL から来るので、権限の確かめの後・DB に触れる前に正の整数だけを受け、JSON が壊れた要求は 500 にせず 400 で断る（SEC-LOOK-016）。
 * 1件の存在確認は「無い」と「DB の失敗」を分け、誤りの文は応答にも記録にも出さない（SEC-LOOK-021）。
 * 更新は画像を付けた時だけ全部を差し替え、文字だけの直しで画像を上げ直させない。
 * 画像は申告の種類と中身の印が合う物だけを、量の枠を使う前に受け、保存名は自分で作る（SEC-LOOK-013）。
 * 更新は行・関連の入れ替えを admin_update_look の 1 取引にし、途中で失敗しても行も関連も元のまま残す。
 * 画像が無い要求は NULL を渡し、関数が今の画像を保つので、同時の更新が差し替えた画像を古い値で上書きしない（ADR-0163）。
 * 行を変えた後に古い画像を、行が変わらなかった時は新しく上げた画像を置き場から消し、削除は行を消した後に画像を消す。
 * 置き場の削除の失敗は監査に件数を残すだけで、応答は成功のまま返す（SEC-LOOK-014）。
 * 公開の切り替えで他の欄と画像に触れず、送り直しの手間と上書きの事故を避けるため、状態の列だけを変える。
 * 失敗の監査は認可が通って操作者が分かった後だけ残す。
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
  listRemovableLookImagePaths,
  prepareLookImage,
  removeLookImages,
  type PreparedLookImage,
} from '@/features/look/services/admin-images';
import { parseLookId } from '@/lib/look/public';
import { describeErrorForLog } from '@/lib/logging/safe-error';
import { signLookImageUrls } from '@/lib/storage/look-images';

const lookStatusSchema = z.enum(['private', 'published']);

const updateLookSchema = z.object({
  seasonYear: z.coerce.number().int().min(2000).max(2100),
  seasonType: z.enum(['SS', 'AW']),
  theme: z.string().trim().min(1).max(200),
  themeDescription: z.string().trim().max(4000),
  status: lookStatusSchema,
  linkedItemIds: z.array(z.coerce.number().int().positive()).min(1),
});

const patchStatusSchema = z.object({
  status: lookStatusSchema,
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

interface UpdateLookFailure {
  status: 400 | 404 | 500;
  /** 応答の誤りの文 */
  error: string;
  /** 監査の detail */
  detail: string;
  /** 500 の時にログへ出す題 */
  log: string;
}

/**
 * admin_update_look の失敗を応答の契約（今までと同じ文）に写す。
 * 関連の段の失敗は関数が LOOK_ITEMS_WRITE_FAILED に付け直す（外部キー違反 23503 だけは付け直さない）。
 */
function classifyUpdateLookFailure(error: { code?: string; message?: string }): UpdateLookFailure {
  if (error.code === 'P0002') {
    return { status: 404, error: 'Look not found', detail: 'Look not found', log: 'Look not found' };
  }
  if (error.code === '23503') {
    return {
      status: 400,
      error: 'Some linked items do not exist',
      detail: 'Some linked items do not exist',
      log: 'Some linked items do not exist',
    };
  }
  if (error.message === 'LOOK_ITEMS_WRITE_FAILED') {
    return {
      status: 500,
      error: 'Failed to update linked items',
      detail: 'Failed to update look-item links',
      log: 'Failed to update look-item links',
    };
  }
  return { status: 500, error: 'Failed to update look', detail: 'Failed to update look', log: 'Failed to update look' };
}

function invalidIdResponse() {
  return NextResponse.json({ error: 'Invalid look id' }, { status: 400 });
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const authz = await authorizeAdminPermission('admin.looks.read', request);
    if (!authz.ok) {
      return authz.response;
    }

    if (parseLookId(id) === null) {
      return invalidIdResponse();
    }

    const supabase = await createServiceRoleClient();

    const { data: lookData, error: lookError } = await supabase
      .from('looks')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (lookError) {
      console.error('Failed to fetch look:', describeErrorForLog(lookError));
      return NextResponse.json({ error: 'Failed to fetch look' }, { status: 500 });
    }

    if (!lookData) {
      return NextResponse.json({ error: 'Look not found' }, { status: 404 });
    }

    const { data: lookItems, error: lookItemsError } = await supabase
      .from('look_items')
      .select('item_id')
      .eq('look_id', id);

    if (lookItemsError) {
      console.error('Failed to fetch look items:', describeErrorForLog(lookItemsError));
      return NextResponse.json({ error: 'Failed to fetch look items' }, { status: 500 });
    }

    const linkedItemIds = (lookItems ?? []).map((entry) => entry.item_id);

    // Generate short-lived signed URLs so admin can preview images from the private bucket
    const signedImageUrls = await signLookImageUrls(
      supabase,
      Array.isArray(lookData.image_urls) ? lookData.image_urls : [],
    );

    return NextResponse.json(
      {
        data: {
          ...lookData,
          image_urls: signedImageUrls,
          linkedItemIds,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('GET /api/admin/looks/:id error:', describeErrorForLog(error));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let actorId: string | null = null;
  let actorEmail: string | null = null;
  // 新しく上げた画像のうち、まだ行が指していない物。例外の時にここから消す。
  let unreferencedPaths: string[] = [];
  let supabaseForCleanup: Awaited<ReturnType<typeof createServiceRoleClient>> | null = null;

  try {
    const { id } = await params;
    const authz = await authorizeAdminPermission('admin.looks.manage', request);
    if (!authz.ok) {
      return authz.response;
    }

    actorId = authz.userId;
    actorEmail = authz.actorEmail;

    const rateLimited = await enforceAdminLookMutationRateLimit({
      request,
      actorId: authz.userId,
      kind: 'update',
    });

    if (rateLimited) {
      return rateLimited;
    }

    if (parseLookId(id) === null) {
      await logAdminLookAudit({
        request,
        actorId: authz.userId,
        actorEmail: authz.actorEmail,
        action: 'admin.look.update',
        outcome: 'failure',
        detail: 'Invalid look id',
        metadata: { id_length: id.length },
      });

      return invalidIdResponse();
    }

    const formData = await request.formData();

    const parsedPayload = updateLookSchema.safeParse({
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
        action: 'admin.look.update',
        outcome: 'failure',
        detail: 'Invalid update payload',
        resourceId: id,
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

    const imageBatchError = validateLookImageBatch(imageFiles);
    if (imageBatchError) {
      await logAdminLookAudit({
        request,
        actorId: authz.userId,
        actorEmail: authz.actorEmail,
        action: 'admin.look.update',
        outcome: 'failure',
        detail: imageBatchError,
        resourceId: id,
        metadata: {
          image_count: imageFiles.length,
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
          action: 'admin.look.update',
          outcome: 'failure',
          detail: 'Unsupported image type',
          resourceId: id,
          metadata: {
            image_type: image.type,
          },
        });

        return NextResponse.json({ error: 'Unsupported image type' }, { status: 400 });
      }

      if (image.size > maxImageBytes) {
        await logAdminLookAudit({
          request,
          actorId: authz.userId,
          actorEmail: authz.actorEmail,
          action: 'admin.look.update',
          outcome: 'failure',
          detail: 'Image size limit exceeded',
          resourceId: id,
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
          action: 'admin.look.update',
          outcome: 'failure',
          detail: 'Unsupported image type',
          resourceId: id,
          metadata: {
            image_type: image.type,
          },
        });

        return NextResponse.json({ error: 'Unsupported image type' }, { status: 400 });
      }

      preparedImages.push(prepared);
    }

    const supabase = await createServiceRoleClient();
    supabaseForCleanup = supabase;

    const { data: existingLook, error: existingLookError } = await supabase
      .from('looks')
      .select('id,status')
      .eq('id', id)
      .maybeSingle();

    if (existingLookError) {
      await logAdminLookAudit({
        request,
        actorId: authz.userId,
        actorEmail: authz.actorEmail,
        action: 'admin.look.update',
        outcome: 'failure',
        detail: 'Failed to fetch look',
        resourceId: id,
      });

      console.error('Failed to fetch look:', describeErrorForLog(existingLookError));
      return NextResponse.json({ error: 'Failed to fetch look' }, { status: 500 });
    }

    if (!existingLook) {
      await logAdminLookAudit({
        request,
        actorId: authz.userId,
        actorEmail: authz.actorEmail,
        action: 'admin.look.update',
        outcome: 'failure',
        detail: 'Look not found',
        resourceId: id,
      });

      return NextResponse.json({ error: 'Look not found' }, { status: 404 });
    }

    const { data: existingItems, error: fetchItemsError } = await supabase
      .from('items')
      .select('id')
      .in('id', parsedPayload.data.linkedItemIds);

    if (fetchItemsError) {
      await logAdminLookAudit({
        request,
        actorId: authz.userId,
        actorEmail: authz.actorEmail,
        action: 'admin.look.update',
        outcome: 'failure',
        detail: 'Failed to validate linked items',
        resourceId: id,
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
        action: 'admin.look.update',
        outcome: 'failure',
        detail: 'Some linked items do not exist',
        resourceId: id,
        metadata: {
          linked_item_ids: parsedPayload.data.linkedItemIds,
          status: parsedPayload.data.status,
        },
      });

      return NextResponse.json({ error: 'Some linked items do not exist' }, { status: 400 });
    }

    const uploadQuotaResponse = await consumeAdminLookUploadQuota({
      actorId: authz.userId,
      kind: 'update',
      totalBytes: imageFiles.reduce((sum, image) => sum + image.size, 0),
    });

    if (uploadQuotaResponse) {
      return uploadQuotaResponse;
    }

    const newImagePaths: string[] = [];

    if (preparedImages.length > 0) {
      for (const prepared of preparedImages) {
        const filePath = buildLookImagePath(prepared.extension);

        const { error: uploadError } = await supabase.storage.from(LOOK_IMAGE_BUCKET).upload(filePath, prepared.buffer, {
          contentType: prepared.contentType,
          cacheControl: '3600',
          upsert: false,
        });

        if (uploadError) {
          const cleanup = await removeLookImages(supabase, newImagePaths);
          unreferencedPaths = [];

          await logAdminLookAudit({
            request,
            actorId: authz.userId,
            actorEmail: authz.actorEmail,
            action: 'admin.look.update',
            outcome: 'failure',
            detail: 'Failed to upload look image',
            resourceId: id,
            metadata: {
              image_type: prepared.contentType,
              ...cleanupMetadata(cleanup, newImagePaths.length),
            },
          });

          console.error('Failed to upload look image:', describeErrorForLog(uploadError));
          return NextResponse.json({ error: 'Failed to upload image' }, { status: 500 });
        }

        // Store the file path (not a public URL) so signed URLs can be
        // generated at serve time after the bucket was made private.
        newImagePaths.push(filePath);
        unreferencedPaths = [...newImagePaths];
      }
    }

    // 行・関連の更新は 1 取引の rpc で行う。新しい画像が無い時は NULL を渡し、今の画像を関数が保つ（ADR-0163）。
    const { data: previousImageUrls, error: updateLookError } = await supabase.rpc('admin_update_look', {
      _look_id: Number(id),
      _season_year: parsedPayload.data.seasonYear,
      _season_type: parsedPayload.data.seasonType,
      _theme: parsedPayload.data.theme,
      _theme_description: parsedPayload.data.themeDescription,
      _image_urls: newImagePaths.length > 0 ? newImagePaths : null,
      _status: parsedPayload.data.status,
      _item_ids: parsedPayload.data.linkedItemIds,
    });

    if (updateLookError) {
      // 行・関連は 1 取引で戻っているので、この要求で上げた新しい画像だけが残骸になる。古い画像は消さない。
      const cleanup = await removeLookImages(supabase, newImagePaths);
      unreferencedPaths = [];

      const failure = classifyUpdateLookFailure(updateLookError);
      await logAdminLookAudit({
        request,
        actorId: authz.userId,
        actorEmail: authz.actorEmail,
        action: 'admin.look.update',
        outcome: 'failure',
        detail: failure.detail,
        resourceId: id,
        metadata: {
          status: parsedPayload.data.status,
          linked_item_ids: parsedPayload.data.linkedItemIds,
          ...cleanupMetadata(cleanup, newImagePaths.length),
        },
      });

      if (failure.status === 500) {
        console.error(`${failure.log}:`, describeErrorForLog(updateLookError));
      }
      return NextResponse.json({ error: failure.error }, { status: failure.status });
    }

    // 行が新しい画像を指したので、新しい画像はもう消さない。差し替えた古い画像を消す。
    unreferencedPaths = [];
    const previousPaths: unknown = previousImageUrls;
    const previousList: string[] = Array.isArray(previousPaths) ? previousPaths : [];
    let oldCleanup: Record<string, unknown> = {};
    if (newImagePaths.length > 0) {
      const removablePaths = listRemovableLookImagePaths(previousList, newImagePaths);
      oldCleanup = cleanupMetadata(await removeLookImages(supabase, removablePaths), removablePaths.length);
    }

    await logAdminLookAudit({
      request,
      actorId: authz.userId,
      actorEmail: authz.actorEmail,
      action: 'admin.look.update',
      outcome: 'success',
      detail: 'Look updated',
      resourceId: id,
      metadata: {
        previous_status: existingLook.status ?? null,
        next_status: parsedPayload.data.status,
        linked_item_ids: parsedPayload.data.linkedItemIds,
        image_count: newImagePaths.length > 0 ? newImagePaths.length : previousList.length,
        season_year: parsedPayload.data.seasonYear,
        season_type: parsedPayload.data.seasonType,
        ...oldCleanup,
      },
    });

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    if (supabaseForCleanup && unreferencedPaths.length > 0) {
      await removeLookImages(supabaseForCleanup, unreferencedPaths);
    }

    if (actorId) {
      await logAdminLookAudit({
        request,
        actorId,
        actorEmail,
        action: 'admin.look.update',
        outcome: 'failure',
        detail: error instanceof z.ZodError ? 'Invalid update payload' : 'Unexpected update error',
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

    console.error('PUT /api/admin/looks/:id error:', describeErrorForLog(error));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let actorId: string | null = null;
  let actorEmail: string | null = null;

  try {
    const { id } = await params;
    const authz = await authorizeAdminPermission('admin.looks.manage', request);
    if (!authz.ok) {
      return authz.response;
    }

    actorId = authz.userId;
    actorEmail = authz.actorEmail;

    const rateLimited = await enforceAdminLookMutationRateLimit({
      request,
      actorId: authz.userId,
      kind: 'status',
    });

    if (rateLimited) {
      return rateLimited;
    }

    if (parseLookId(id) === null) {
      await logAdminLookAudit({
        request,
        actorId: authz.userId,
        actorEmail: authz.actorEmail,
        action: 'admin.look.status_update',
        outcome: 'failure',
        detail: 'Invalid look id',
        metadata: { id_length: id.length },
      });

      return invalidIdResponse();
    }

    const body = await request.json().catch(() => null);

    if (body === null) {
      await logAdminLookAudit({
        request,
        actorId: authz.userId,
        actorEmail: authz.actorEmail,
        action: 'admin.look.status_update',
        outcome: 'failure',
        detail: 'Invalid JSON',
        resourceId: id,
      });

      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    const parsed = patchStatusSchema.safeParse(body);

    if (!parsed.success) {
      await logAdminLookAudit({
        request,
        actorId: authz.userId,
        actorEmail: authz.actorEmail,
        action: 'admin.look.status_update',
        outcome: 'failure',
        detail: 'Invalid status payload',
        resourceId: id,
        metadata: {
          invalid_fields: Object.keys(parsed.error.flatten().fieldErrors),
        },
      });

      return NextResponse.json(
        {
          error: 'Invalid request',
          details: parsed.error.flatten(),
        },
        { status: 400 }
      );
    }

    const supabase = await createServiceRoleClient();

    const { data: existingLook, error: existingLookError } = await supabase
      .from('looks')
      .select('id,status')
      .eq('id', id)
      .maybeSingle();

    if (existingLookError) {
      await logAdminLookAudit({
        request,
        actorId: authz.userId,
        actorEmail: authz.actorEmail,
        action: 'admin.look.status_update',
        outcome: 'failure',
        detail: 'Failed to fetch look',
        resourceId: id,
      });

      console.error('Failed to fetch look:', describeErrorForLog(existingLookError));
      return NextResponse.json({ error: 'Failed to fetch look' }, { status: 500 });
    }

    if (!existingLook) {
      await logAdminLookAudit({
        request,
        actorId: authz.userId,
        actorEmail: authz.actorEmail,
        action: 'admin.look.status_update',
        outcome: 'failure',
        detail: 'Look not found',
        resourceId: id,
      });

      return NextResponse.json({ error: 'Look not found' }, { status: 404 });
    }

    const { error } = await supabase
      .from('looks')
      .update({ status: parsed.data.status })
      .eq('id', id);

    if (error) {
      await logAdminLookAudit({
        request,
        actorId: authz.userId,
        actorEmail: authz.actorEmail,
        action: 'admin.look.status_update',
        outcome: 'failure',
        detail: 'Failed to update look status',
        resourceId: id,
        metadata: {
          previous_status: existingLook.status,
          next_status: parsed.data.status,
        },
      });

      console.error('Failed to update look status:', describeErrorForLog(error));
      return NextResponse.json({ error: 'Failed to update status' }, { status: 500 });
    }

    await logAdminLookAudit({
      request,
      actorId: authz.userId,
      actorEmail: authz.actorEmail,
      action: 'admin.look.status_update',
      outcome: 'success',
      detail: 'Look status updated',
      resourceId: id,
      metadata: {
        previous_status: existingLook.status,
        next_status: parsed.data.status,
      },
    });

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    if (actorId) {
      await logAdminLookAudit({
        request,
        actorId,
        actorEmail,
        action: 'admin.look.status_update',
        outcome: 'failure',
        detail: error instanceof z.ZodError ? 'Invalid status payload' : 'Unexpected status update error',
        metadata: error instanceof z.ZodError
          ? { invalid_fields: Object.keys(error.flatten().fieldErrors) }
          : undefined,
      });
    }

    console.error('PATCH /api/admin/looks/:id error:', describeErrorForLog(error));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let actorId: string | null = null;
  let actorEmail: string | null = null;

  try {
    const { id } = await params;
    const authz = await authorizeAdminPermission('admin.looks.manage', request);
    if (!authz.ok) {
      return authz.response;
    }

    actorId = authz.userId;
    actorEmail = authz.actorEmail;

    const rateLimited = await enforceAdminLookMutationRateLimit({
      request,
      actorId: authz.userId,
      kind: 'delete',
    });

    if (rateLimited) {
      return rateLimited;
    }

    if (parseLookId(id) === null) {
      await logAdminLookAudit({
        request,
        actorId: authz.userId,
        actorEmail: authz.actorEmail,
        action: 'admin.look.delete',
        outcome: 'failure',
        detail: 'Invalid look id',
        metadata: { id_length: id.length },
      });

      return invalidIdResponse();
    }

    const supabase = await createServiceRoleClient();

    // 消す画像の道筋は、行を消す前に読んでおく。
    const { data: existingLook, error: existingLookError } = await supabase
      .from('looks')
      .select('id,status,image_urls')
      .eq('id', id)
      .maybeSingle();

    if (existingLookError) {
      await logAdminLookAudit({
        request,
        actorId: authz.userId,
        actorEmail: authz.actorEmail,
        action: 'admin.look.delete',
        outcome: 'failure',
        detail: 'Failed to fetch look',
        resourceId: id,
      });

      console.error('Failed to fetch look:', describeErrorForLog(existingLookError));
      return NextResponse.json({ error: 'Failed to fetch look' }, { status: 500 });
    }

    if (!existingLook) {
      await logAdminLookAudit({
        request,
        actorId: authz.userId,
        actorEmail: authz.actorEmail,
        action: 'admin.look.delete',
        outcome: 'failure',
        detail: 'Look not found',
        resourceId: id,
      });

      return NextResponse.json({ error: 'Look not found' }, { status: 404 });
    }

    const { error } = await supabase.from('looks').delete().eq('id', id);

    if (error) {
      await logAdminLookAudit({
        request,
        actorId: authz.userId,
        actorEmail: authz.actorEmail,
        action: 'admin.look.delete',
        outcome: 'failure',
        detail: 'Failed to delete look',
        resourceId: id,
        metadata: {
          deleted_status: existingLook.status,
        },
      });

      console.error('Failed to delete look:', describeErrorForLog(error));
      return NextResponse.json({ error: 'Failed to delete look' }, { status: 500 });
    }

    const removablePaths = listRemovableLookImagePaths(existingLook.image_urls);
    const cleanup = await removeLookImages(supabase, removablePaths);

    await logAdminLookAudit({
      request,
      actorId: authz.userId,
      actorEmail: authz.actorEmail,
      action: 'admin.look.delete',
      outcome: 'success',
      detail: 'Look deleted',
      resourceId: id,
      metadata: {
        deleted_status: existingLook.status,
        ...cleanupMetadata(cleanup, removablePaths.length),
      },
    });

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    if (actorId) {
      await logAdminLookAudit({
        request,
        actorId,
        actorEmail,
        action: 'admin.look.delete',
        outcome: 'failure',
        detail: 'Unexpected delete error',
      });
    }

    console.error('DELETE /api/admin/looks/:id error:', describeErrorForLog(error));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
