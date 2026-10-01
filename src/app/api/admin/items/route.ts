import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { signItemImageFields } from '@/lib/storage/item-images';
import {
  describeDeleteBlockers,
  fetchItemDeleteBlockers,
  isItemDeletable,
  type ItemDeleteBlockers,
} from '@/lib/items/item-checkout-guards';

const itemCategorySchema = z.enum(['TOPS', 'BOTTOMS', 'OUTERWEAR', 'ACCESSORIES']);
const itemStatusSchema = z.enum(['private', 'published']);
const colorSchema = z.object({
  name: z.string().trim().min(1).max(40),
  hex: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});

const createItemSchema = z.object({
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
  try {
    const authz = await authorizeAdminPermission('admin.items.manage', request);
    if (!authz.ok) {
      return authz.response;
    }

    const formData = await request.formData();
    const rawStatus = formData.get('status');
    const normalizedStatus = rawStatus === 'draft' ? 'private' : rawStatus;

    const parsedPayload = createItemSchema.safeParse({
      name: formData.get('name'),
      description: formData.get('description'),
      price: formData.get('price'),
      category: formData.get('category'),
      material: formData.get('material') ?? '',
      origin: formData.get('origin') ?? '',
      care: formData.get('care') ?? '',
      product_note: formData.get('product_note') ?? '',
      status: normalizedStatus,
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

    if (imageFiles.length === 0) {
      return NextResponse.json({ error: 'At least one image is required' }, { status: 400 });
    }

    for (const image of imageFiles) {
      if (!allowedImageTypes.has(image.type)) {
        return NextResponse.json({ error: 'Unsupported image type' }, { status: 400 });
      }

      if (image.size > maxImageBytes) {
        return NextResponse.json({ error: 'Image size must be 5MB or less' }, { status: 400 });
      }
    }

    const supabase = await createServiceRoleClient();
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

    const { data, error } = await supabase
      .from('items')
      .insert([
        {
          name: parsedPayload.data.name,
          description: parsedPayload.data.description,
          price: parsedPayload.data.price,
          category: parsedPayload.data.category,
          image_url: imageUrls[0],
          image_urls: imageUrls,
          colors: parsedPayload.data.colors,
          sizes: parsedPayload.data.sizes,
          material: parsedPayload.data.material || null,
          origin: parsedPayload.data.origin || null,
          care: parsedPayload.data.care || null,
          product_note: parsedPayload.data.product_note || null,
          status: parsedPayload.data.status,
        },
      ])
      .select('id')
      .single();

    if (error) {
      console.error('Failed to create item:', error);
      return NextResponse.json({ error: 'Failed to save item' }, { status: 500 });
    }

    return NextResponse.json({ success: true, id: data.id }, { status: 201 });
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

    console.error('POST /api/admin/items error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function GET(request: Request) {
  try {
    const authz = await authorizeAdminPermission('admin.items.read', request);
    if (!authz.ok) {
      return authz.response;
    }

    const supabase = await createServiceRoleClient();

    const { data, error } = await supabase
      .from('items')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Failed to fetch items:', error);
      return NextResponse.json({ error: 'Failed to fetch items' }, { status: 500 });
    }

    // signItemImageFields の型の制約は image_url・image_urls だけの弱い型なので、要素の型にも含める（TS2559 を避ける）
    const items = (data ?? []) as Array<{ id: number | string; image_url?: string | null; image_urls?: string[] | null }>;

    // 削除できない商品は、削除ボタンを押した時点で案内する（R-44）。読めなければ判定を付けない（削除時に API が確かめる）
    let blockers: Map<number, ItemDeleteBlockers> | null = null;
    try {
      blockers = await fetchItemDeleteBlockers(supabase, items.map((item) => Number(item.id)));
    } catch (blockersError) {
      console.error('Failed to fetch item delete blockers:', blockersError);
    }

    const signedItems = await Promise.all(items.map(async (item) => {
      const signed = await signItemImageFields(supabase, item);
      if (!blockers) {
        return signed;
      }
      const itemBlockers = blockers.get(Number(item.id));
      return {
        ...signed,
        canDelete: isItemDeletable(itemBlockers),
        deleteBlockedReasons: itemBlockers ? describeDeleteBlockers(itemBlockers) : [],
      };
    }));

    return NextResponse.json({ data: signedItems }, { status: 200 });
  } catch (error) {
    console.error('GET /api/admin/items error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
