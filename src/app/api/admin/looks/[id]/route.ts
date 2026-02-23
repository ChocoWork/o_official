import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';

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

export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const authz = await authorizeAdminPermission('admin.looks.read', request);
    if (!authz.ok) {
      return authz.response;
    }

    const supabase = await createServiceRoleClient();

    const { data: lookData, error: lookError } = await supabase
      .from('looks')
      .select('*')
      .eq('id', params.id)
      .single();

    if (lookError || !lookData) {
      return NextResponse.json({ error: 'Look not found' }, { status: 404 });
    }

    const { data: lookItems, error: lookItemsError } = await supabase
      .from('look_items')
      .select('item_id')
      .eq('look_id', params.id);

    if (lookItemsError) {
      console.error('Failed to fetch look items:', lookItemsError);
      return NextResponse.json({ error: 'Failed to fetch look items' }, { status: 500 });
    }

    const linkedItemIds = (lookItems ?? []).map((entry) => entry.item_id);

    return NextResponse.json(
      {
        data: {
          ...lookData,
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

export async function PUT(request: Request, { params }: { params: { id: string } }) {
  try {
    const authz = await authorizeAdminPermission('admin.looks.manage', request);
    if (!authz.ok) {
      return authz.response;
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
      return NextResponse.json(
        {
          error: 'Invalid request',
          details: parsedPayload.error.flatten(),
        },
        { status: 400 }
      );
    }

    const imageFiles = formData.getAll('images').filter((file): file is File => file instanceof File);

    for (const image of imageFiles) {
      if (!allowedImageTypes.has(image.type)) {
        return NextResponse.json({ error: 'Unsupported image type' }, { status: 400 });
      }

      if (image.size > maxImageBytes) {
        return NextResponse.json({ error: 'Image size must be 5MB or less' }, { status: 400 });
      }
    }

    const supabase = await createServiceRoleClient();

    const { data: existingLook, error: existingLookError } = await supabase
      .from('looks')
      .select('id,image_urls')
      .eq('id', params.id)
      .single();

    if (existingLookError || !existingLook) {
      return NextResponse.json({ error: 'Look not found' }, { status: 404 });
    }

    const { data: existingItems, error: fetchItemsError } = await supabase
      .from('items')
      .select('id')
      .in('id', parsedPayload.data.linkedItemIds);

    if (fetchItemsError) {
      console.error('Failed to validate linked items:', fetchItemsError);
      return NextResponse.json({ error: 'Failed to validate linked items' }, { status: 500 });
    }

    if (!existingItems || existingItems.length !== parsedPayload.data.linkedItemIds.length) {
      return NextResponse.json({ error: 'Some linked items do not exist' }, { status: 400 });
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
          console.error('Failed to upload look image:', uploadError);
          return NextResponse.json(
            {
              error: `Failed to upload image: ${uploadError.message}`,
            },
            { status: 500 }
          );
        }

        const {
          data: { publicUrl },
        } = supabase.storage.from('look-images').getPublicUrl(filePath);

        imageUrls.push(publicUrl);
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
      .eq('id', params.id);

    if (updateLookError) {
      console.error('Failed to update look:', updateLookError);
      return NextResponse.json({ error: 'Failed to update look' }, { status: 500 });
    }

    const { error: deleteLookItemsError } = await supabase.from('look_items').delete().eq('look_id', params.id);

    if (deleteLookItemsError) {
      console.error('Failed to replace look-item links:', deleteLookItemsError);
      return NextResponse.json({ error: 'Failed to update linked items' }, { status: 500 });
    }

    const lookItemsPayload = parsedPayload.data.linkedItemIds.map((itemId) => ({
      look_id: Number(params.id),
      item_id: itemId,
    }));

    const { error: insertLookItemsError } = await supabase.from('look_items').insert(lookItemsPayload);

    if (insertLookItemsError) {
      console.error('Failed to update look-item links:', insertLookItemsError);
      return NextResponse.json({ error: 'Failed to update linked items' }, { status: 500 });
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
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

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  try {
    const authz = await authorizeAdminPermission('admin.looks.manage', request);
    if (!authz.ok) {
      return authz.response;
    }

    const body = await request.json();
    const parsed = patchStatusSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'Invalid request',
          details: parsed.error.flatten(),
        },
        { status: 400 }
      );
    }

    const supabase = await createServiceRoleClient();

    const { error } = await supabase
      .from('looks')
      .update({ status: parsed.data.status })
      .eq('id', params.id);

    if (error) {
      console.error('Failed to update look status:', error);
      return NextResponse.json({ error: 'Failed to update status' }, { status: 500 });
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('PATCH /api/admin/looks/:id error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  try {
    const authz = await authorizeAdminPermission('admin.looks.manage', request);
    if (!authz.ok) {
      return authz.response;
    }

    const supabase = await createServiceRoleClient();

    const { error } = await supabase.from('looks').delete().eq('id', params.id);

    if (error) {
      console.error('Failed to delete look:', error);
      return NextResponse.json({ error: 'Failed to delete look' }, { status: 500 });
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('DELETE /api/admin/looks/:id error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
