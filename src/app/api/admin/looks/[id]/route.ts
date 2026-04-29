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

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const authz = await authorizeAdminPermission('admin.looks.read', request);
    if (!authz.ok) {
      return authz.response;
    }

    const supabase = await createServiceRoleClient();

    const { data: lookData, error: lookError } = await supabase
      .from('looks')
      .select('*')
      .eq('id', id)
      .single();

    if (lookError || !lookData) {
      return NextResponse.json({ error: 'Look not found' }, { status: 404 });
    }

    const { data: lookItems, error: lookItemsError } = await supabase
      .from('look_items')
      .select('item_id')
      .eq('look_id', id);

    if (lookItemsError) {
      console.error('Failed to fetch look items:', lookItemsError);
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
    console.error('GET /api/admin/looks/:id error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
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
      kind: 'update',
    });

    if (rateLimited) {
      return rateLimited;
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
    }

    const supabase = await createServiceRoleClient();

    const { data: existingLook, error: existingLookError } = await supabase
      .from('looks')
      .select('id,status,image_urls')
      .eq('id', id)
      .single();

    if (existingLookError || !existingLook) {
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

      console.error('Failed to validate linked items:', fetchItemsError);
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

    let imageUrls = Array.isArray(existingLook.image_urls) ? existingLook.image_urls : [];

    if (imageFiles.length > 0) {
      imageUrls = [];

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
            action: 'admin.look.update',
            outcome: 'failure',
            detail: 'Failed to upload look image',
            resourceId: id,
            metadata: {
              storage_path: filePath,
              image_type: image.type,
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
    }

    const { error: updateLookError } = await supabase
      .from('looks')
      .update({
        season_year: parsedPayload.data.seasonYear,
        season_type: parsedPayload.data.seasonType,
        theme: parsedPayload.data.theme,
        theme_description: parsedPayload.data.themeDescription,
        image_urls: imageUrls,
        status: parsedPayload.data.status,
      })
      .eq('id', id);

    if (updateLookError) {
      await logAdminLookAudit({
        request,
        actorId: authz.userId,
        actorEmail: authz.actorEmail,
        action: 'admin.look.update',
        outcome: 'failure',
        detail: 'Failed to update look',
        resourceId: id,
        metadata: {
          status: parsedPayload.data.status,
          linked_item_ids: parsedPayload.data.linkedItemIds,
        },
      });

      console.error('Failed to update look:', updateLookError);
      return NextResponse.json({ error: 'Failed to update look' }, { status: 500 });
    }

    const { error: deleteLookItemsError } = await supabase.from('look_items').delete().eq('look_id', id);

    if (deleteLookItemsError) {
      await logAdminLookAudit({
        request,
        actorId: authz.userId,
        actorEmail: authz.actorEmail,
        action: 'admin.look.update',
        outcome: 'failure',
        detail: 'Failed to replace look-item links',
        resourceId: id,
        metadata: {
          linked_item_ids: parsedPayload.data.linkedItemIds,
        },
      });

      console.error('Failed to replace look-item links:', deleteLookItemsError);
      return NextResponse.json({ error: 'Failed to update linked items' }, { status: 500 });
    }

    const lookItemsPayload = parsedPayload.data.linkedItemIds.map((itemId) => ({
      look_id: Number(id),
      item_id: itemId,
    }));

    const { error: insertLookItemsError } = await supabase.from('look_items').insert(lookItemsPayload);

    if (insertLookItemsError) {
      await logAdminLookAudit({
        request,
        actorId: authz.userId,
        actorEmail: authz.actorEmail,
        action: 'admin.look.update',
        outcome: 'failure',
        detail: 'Failed to update look-item links',
        resourceId: id,
        metadata: {
          linked_item_ids: parsedPayload.data.linkedItemIds,
        },
      });

      console.error('Failed to update look-item links:', insertLookItemsError);
      return NextResponse.json({ error: 'Failed to update linked items' }, { status: 500 });
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
        image_count: imageUrls.length,
        season_year: parsedPayload.data.seasonYear,
        season_type: parsedPayload.data.seasonType,
      },
    });

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
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

    console.error('PUT /api/admin/looks/:id error:', error);
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

    const body = await request.json();
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
      .single();

    if (existingLookError || !existingLook) {
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

      console.error('Failed to update look status:', error);
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

    console.error('PATCH /api/admin/looks/:id error:', error);
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

    const supabase = await createServiceRoleClient();

    const { data: existingLook, error: existingLookError } = await supabase
      .from('looks')
      .select('id,status')
      .eq('id', id)
      .single();

    if (existingLookError || !existingLook) {
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

      console.error('Failed to delete look:', error);
      return NextResponse.json({ error: 'Failed to delete look' }, { status: 500 });
    }

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

    console.error('DELETE /api/admin/looks/:id error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
