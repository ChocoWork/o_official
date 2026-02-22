import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createServiceRoleClient } from '@/lib/supabase/server';

const createNewsSchema = z.object({
  title: z.string().trim().min(1).max(200),
  category: z.enum(['COLLECTION', 'EVENT', 'COLLABORATION', 'SUSTAINABILITY', 'STORE']),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  content: z.string().trim().min(1).max(2000),
  detailedContent: z.string().trim().min(1).max(10000),
  status: z.enum(['private', 'published']),
});

const allowedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const maxImageBytes = 5 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const image = formData.get('image');

    const parsed = createNewsSchema.safeParse({
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

    if (!(image instanceof File)) {
      return NextResponse.json({ error: 'Image file is required' }, { status: 400 });
    }

    if (!allowedImageTypes.has(image.type)) {
      return NextResponse.json({ error: 'Unsupported image type' }, { status: 400 });
    }

    if (image.size > maxImageBytes) {
      return NextResponse.json({ error: 'Image size must be 5MB or less' }, { status: 400 });
    }

    const supabase = await createServiceRoleClient();

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

    const { data, error } = await supabase
      .from('news_articles')
      .insert([
        {
          title: parsed.data.title,
          category: parsed.data.category,
          published_date: parsed.data.date,
          image_url: publicUrl,
          content: parsed.data.content,
          detailed_content: parsed.data.detailedContent,
          status: parsed.data.status,
        },
      ])
      .select('id')
      .single();

    if (error) {
      console.error('Failed to create news article:', error);
      return NextResponse.json({ error: 'Failed to save news article' }, { status: 500 });
    }

    return NextResponse.json({ success: true, id: data.id }, { status: 201 });
  } catch (error) {
    console.error('POST /api/admin/news error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function GET() {
  try {
    const supabase = await createServiceRoleClient();

    const { data, error } = await supabase
      .from('news_articles')
      .select('*')
      .order('published_date', { ascending: false });

    if (error) {
      console.error('Failed to fetch news articles:', error);
      return NextResponse.json({ error: 'Failed to fetch news articles' }, { status: 500 });
    }

    return NextResponse.json({ data }, { status: 200 });
  } catch (error) {
    console.error('GET /api/admin/news error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
