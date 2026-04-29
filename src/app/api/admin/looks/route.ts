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

export async function POST(request: Request) {
  let actorId: string | null = null;
  let actorEmail: string | null = null;

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
    }

    const supabase = await createServiceRoleClient();

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

      console.error('Failed to validate linked items:', fetchItemsError);
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

    for (const image of imageFiles) {
      const extension = image.name.includes('.') ? image.name.split('.').pop() : 'jpg';
      const filePath = `looks/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${extension}`;
      const imageBuffer = Buffer.from(await image.arrayBuffer());

      const { error: uploadError } = await supabase.storage.from('look-images').upload(filePath, imageBuffer, {
        contentType: image.type,
        cacheControl: '3600',
        upsert: false,
      });

      if (uploadError) {
        await logAdminLookAudit({
          request,
          actorId: authz.userId,
          actorEmail: authz.actorEmail,
          action: 'admin.look.create',
          outcome: 'failure',
          detail: 'Failed to upload look image',
          metadata: {
            storage_path: filePath,
            image_type: image.type,
            status: parsedPayload.data.status,
            linked_item_ids: parsedPayload.data.linkedItemIds,
          },
        });

        console.error('Failed to upload look image:', uploadError);
        return NextResponse.json(
          {
            error: `Failed to upload image: ${uploadError.message}`,
          },
          { status: 500 }
        );
      }

      // Store the file path (not a public URL) so signed URLs can be
      // generated at serve time after the bucket was made private.
      imageUrls.push(filePath);
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
        },
      });

      console.error('Failed to create look:', insertLookError);
      return NextResponse.json({ error: 'Failed to save look' }, { status: 500 });
    }

    const lookItemsPayload = parsedPayload.data.linkedItemIds.map((itemId) => ({
      look_id: lookData.id,
      item_id: itemId,
    }));

    const { error: insertLookItemsError } = await supabase.from('look_items').insert(lookItemsPayload);

    if (insertLookItemsError) {
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
        },
      });

      await supabase.from('looks').delete().eq('id', lookData.id);
      console.error('Failed to create look-item links:', insertLookItemsError);
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

    console.error('POST /api/admin/looks error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function GET(request: Request) {
  try {
    const authz = await authorizeAdminPermission('admin.looks.read', request);
    if (!authz.ok) {
      return authz.response;
    }

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
      console.error('Failed to fetch looks:', error);
      return NextResponse.json({ error: 'Failed to fetch looks' }, { status: 500 });
    }

    // Generate short-lived signed URLs so admin can preview images from the private bucket
    const signedData = await Promise.all(
      (data ?? []).map(async (look) => ({
        ...look,
        image_urls: await signLookImageUrls(supabase, look.image_urls ?? []),
      }))
    );

    return NextResponse.json({ data: signedData }, { status: 200 });
  } catch (error) {
    console.error('GET /api/admin/looks error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
