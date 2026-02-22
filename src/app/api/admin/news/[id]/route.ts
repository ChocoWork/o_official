import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createServiceRoleClient } from '@/lib/supabase/server';

const updateNewsSchema = z.object({
  title: z.string().trim().min(1).max(200),
  category: z.enum(['COLLECTION', 'EVENT', 'COLLABORATION', 'SUSTAINABILITY', 'STORE']),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  content: z.string().trim().min(1).max(2000),
  detailedContent: z.string().trim().min(1).max(10000),
  status: z.enum(['private', 'published']),
});

const allowedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const maxImageBytes = 5 * 1024 * 1024;

export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const supabase = await createServiceRoleClient();

    const { data, error } = await supabase
      .from('news_articles')
      .select('*')
      .eq('id', params.id)
      .single();

    if (error || !data) {
      console.error('Failed to fetch news article:', error);
      return NextResponse.json({ error: 'Article not found' }, { status: 404 });
    }

    return NextResponse.json({ data }, { status: 200 });
  } catch (error) {
    console.error('GET /api/admin/news/:id error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(request: Request, { params }: { params: { id: string } }) {
  try {
    const formData = await request.formData();
    const image = formData.get('image');

    const parsed = updateNewsSchema.safeParse({
      title: formData.get('title'),
      category: formData.get('category'),
      date: formData.get('date'),
      content: formData.get('content'),
      detailedContent: formData.get('detailedContent'),
      status: formData.get('status'),
    });

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

    let imageUrl: string | undefined = undefined;

    // 画像が新規アップロードされている場合
    if (image instanceof File) {
      if (!allowedImageTypes.has(image.type)) {
        return NextResponse.json({ error: 'Unsupported image type' }, { status: 400 });
      }

      if (image.size > maxImageBytes) {
        return NextResponse.json({ error: 'Image size must be 5MB or less' }, { status: 400 });
      }

      const extension = image.name.includes('.') ? image.name.split('.').pop() : 'jpg';
      const filePath = `news/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${extension}`;
      const imageBuffer = Buffer.from(await image.arrayBuffer());

      const { error: uploadError } = await supabase.storage
        .from('news-images')
        .upload(filePath, imageBuffer, {
          contentType: image.type,
          cacheControl: '3600',
          upsert: false,
        });

      if (uploadError) {
        console.error('Failed to upload image:', uploadError);
        return NextResponse.json({ error: 'Failed to upload image' }, { status: 500 });
      }

      const {
        data: { publicUrl },
      } = supabase.storage.from('news-images').getPublicUrl(filePath);

      imageUrl = publicUrl;
    }

    const updatePayload: Record<string, unknown> = {
      title: parsed.data.title,
      category: parsed.data.category,
      published_date: parsed.data.date,
      content: parsed.data.content,
      detailed_content: parsed.data.detailedContent,
      status: parsed.data.status,
    };

    if (imageUrl) {
      updatePayload.image_url = imageUrl;
    }

    const { error } = await supabase
      .from('news_articles')
      .update(updatePayload)
      .eq('id', params.id);

    if (error) {
      console.error('Failed to update news article:', error);
      return NextResponse.json({ error: 'Failed to update news article' }, { status: 500 });
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('PUT /api/admin/news/:id error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

const patchStatusSchema = z.object({
  status: z.enum(['private', 'published']),
});

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  try {
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
      .from('news_articles')
      .update({ status: parsed.data.status })
      .eq('id', params.id);

    if (error) {
      console.error('Failed to update news article status:', error);
      return NextResponse.json({ error: 'Failed to update status' }, { status: 500 });
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('PATCH /api/admin/news/:id error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  try {
    const supabase = await createServiceRoleClient();

    const { error } = await supabase
      .from('news_articles')
      .delete()
      .eq('id', params.id);

    if (error) {
      console.error('Failed to delete news article:', error);
      return NextResponse.json({ error: 'Failed to delete article' }, { status: 500 });
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('DELETE /api/admin/news/:id error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
