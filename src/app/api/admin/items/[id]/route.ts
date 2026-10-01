import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { signItemImageFields } from '@/lib/storage/item-images';
import { getStripeServerClient } from '@/lib/stripe/server';
import {
  describeDeleteBlockers,
  expireOpenCheckoutsForItem,
  fetchItemDeleteBlockers,
  isItemDeletable,
} from '@/lib/items/item-checkout-guards';
import { buildItemDeleteGuidance } from '@/lib/items/item-delete-guidance';

const itemCategorySchema = z.enum(['TOPS', 'BOTTOMS', 'OUTERWEAR', 'ACCESSORIES']);
const itemStatusSchema = z.enum(['private', 'published']);
const colorSchema = z.object({
  name: z.string().trim().min(1).max(40),
  hex: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});

const updateItemSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().min(1).max(4000),
  price: z.coerce.number().int().min(0),
  category: itemCategorySchema,
  material: z.string().trim().max(200).optional().default(''),
  origin: z.string().trim().max(200).optional().default(''),
  care: z.string().trim().max(500).optional().default(''),
  product_note: z.string().trim().max(500).optional().default(''),
  status: itemStatusSchema,
  sizes: z.array(z.string().trim().min(1).max(20)).min(1),
  colors: z.array(colorSchema).min(1),
});

const patchStatusSchema = z.object({
  status: itemStatusSchema,
});

const itemIdSchema = z.coerce.number().int().positive();

/** ① 非公開にしたら、その商品を含む開いている決済を失効させる。失敗しても商品の変更は止めない */
async function expireCheckoutsIfUnpublished(
  supabase: Awaited<ReturnType<typeof createServiceRoleClient>>,
  id: string,
  status: 'private' | 'published',
): Promise<void> {
  const itemId = itemIdSchema.safeParse(id);
  if (status !== 'private' || !itemId.success) {
    return;
  }

  const result = await expireOpenCheckoutsForItem({ client: supabase, stripe: getStripeServerClient(), itemId: itemId.data });
  if (result.failed > 0) {
    console.error('[admin.items] some checkout sessions could not be expired', id, result);
  }
}

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
    const authz = await authorizeAdminPermission('admin.items.read', request);
    if (!authz.ok) {
      return authz.response;
    }

    const supabase = await createServiceRoleClient();

    const { data, error } = await supabase
      .from('items')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !data) {
      return NextResponse.json({ error: 'Item not found' }, { status: 404 });
    }

    const signedItem = await signItemImageFields(supabase, data);

    return NextResponse.json({ data: signedItem }, { status: 200 });
  } catch (error) {
    console.error('GET /api/admin/items/:id error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const authz = await authorizeAdminPermission('admin.items.manage', request);
    if (!authz.ok) {
      return authz.response;
    }

    const formData = await request.formData();

    const parsedPayload = updateItemSchema.safeParse({
      name: formData.get('name'),
      description: formData.get('description'),
      price: formData.get('price'),
      category: formData.get('category'),
      material: formData.get('material') ?? '',
      origin: formData.get('origin') ?? '',
      care: formData.get('care') ?? '',
      product_note: formData.get('product_note') ?? '',
      status: formData.get('status'),
      sizes: parseJsonField(formData.get('sizes'), z.array(z.string())),
      colors: parseJsonField(formData.get('colors'), z.array(colorSchema)),
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

    const updatePayload: Record<string, unknown> = {
      name: parsedPayload.data.name,
      description: parsedPayload.data.description,
      price: parsedPayload.data.price,
      category: parsedPayload.data.category,
      colors: parsedPayload.data.colors,
      sizes: parsedPayload.data.sizes,
      material: parsedPayload.data.material || null,
      origin: parsedPayload.data.origin || null,
      care: parsedPayload.data.care || null,
      product_note: parsedPayload.data.product_note || null,
      status: parsedPayload.data.status,
    };

    if (imageFiles.length > 0) {
      const imageUrls: string[] = [];

      for (const image of imageFiles) {
        const extension = image.name.includes('.') ? image.name.split('.').pop() : 'jpg';
        const filePath = `items/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${extension}`;
        const imageBuffer = Buffer.from(await image.arrayBuffer());

        const { error: uploadError } = await supabase.storage.from('item-images').upload(filePath, imageBuffer, {
          contentType: image.type,
          cacheControl: '3600',
          upsert: false,
        });

        if (uploadError) {
          console.error('Failed to upload item image:', uploadError);
          return NextResponse.json({ error: 'Failed to upload image' }, { status: 500 });
        }

        const {
          data: { publicUrl },
        } = supabase.storage.from('item-images').getPublicUrl(filePath);

        imageUrls.push(publicUrl);
      }

      updatePayload.image_url = imageUrls[0];
      updatePayload.image_urls = imageUrls;
    }

    const { error } = await supabase
      .from('items')
      .update(updatePayload)
      .eq('id', id);

    if (error) {
      console.error('Failed to update item:', error);
      return NextResponse.json({ error: 'Failed to update item' }, { status: 500 });
    }

    await expireCheckoutsIfUnpublished(supabase, id, parsedPayload.data.status);

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

    console.error('PUT /api/admin/items/:id error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const authz = await authorizeAdminPermission('admin.items.manage', request);
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
      .from('items')
      .update({ status: parsed.data.status })
      .eq('id', id);

    if (error) {
      console.error('Failed to update item status:', error);
      return NextResponse.json({ error: 'Failed to update status' }, { status: 500 });
    }

    await expireCheckoutsIfUnpublished(supabase, id, parsed.data.status);

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('PATCH /api/admin/items/:id error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const authz = await authorizeAdminPermission('admin.items.manage', request);
    if (!authz.ok) {
      return authz.response;
    }

    const itemId = itemIdSchema.safeParse(id);
    if (!itemId.success) {
      return NextResponse.json({ error: 'Invalid item id' }, { status: 400 });
    }

    const supabase = await createServiceRoleClient();

    // 注文・在庫の記録・決済中のある商品は消さず、非公開へ誘導する（R-44）
    const blockers = (await fetchItemDeleteBlockers(supabase, [itemId.data])).get(itemId.data);
    if (!isItemDeletable(blockers)) {
      const reasons = blockers ? describeDeleteBlockers(blockers) : [];
      return NextResponse.json({ error: buildItemDeleteGuidance(reasons), reasons }, { status: 409 });
    }

    const { error } = await supabase
      .from('items')
      .delete()
      .eq('id', itemId.data);

    if (error) {
      // 確かめた後に注文・在庫の記録が増えた（外部キーで断られた）
      if (error.code === '23503') {
        return NextResponse.json({ error: buildItemDeleteGuidance([]), reasons: [] }, { status: 409 });
      }
      console.error('Failed to delete item:', error);
      return NextResponse.json({ error: 'Failed to delete item' }, { status: 500 });
    }

    await expireOpenCheckoutsForItem({ client: supabase, stripe: getStripeServerClient(), itemId: itemId.data });

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('DELETE /api/admin/items/:id error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
