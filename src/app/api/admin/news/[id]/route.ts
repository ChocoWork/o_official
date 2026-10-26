/**
 * 管理の記事1件の読み（GET）・更新（PUT）・公開の切り替え（PATCH）・削除（DELETE）の窓口（src/app/api/admin/news/[id]/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-NEWS-162
 * @design DD-NEWS-065
 * @remarks 表の読み書きは利用者の JWT の client で RLS に通し、窓口の認可が崩れても DB が断るようにする（SEC-NEWS-015、DATA-NEWS-002）。一覧のボタン1つで公開を切り替えられるよう、状態だけを変える PATCH を全体の更新の PUT と分ける（API-NEWS-006、STATE-NEWS-001）。直すたびに画像を付け直させないよう、PUT の画像は任意にする（API-NEWS-005）。変える操作は誰が何をしたかを追えるよう、成功も失敗も監査に残す。変更・削除が 0 行の時（無い記事、または RLS が隠した記事）は成功と偽らず 404 にして失敗を残す（SEC-NEWS-016）。
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { logAudit } from '@/lib/audit';
import { signNewsImageFields } from '@/lib/storage/news-images';

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

// DB の id は bigint。形の悪い id を渡すと 22P02 で 500 になるので、桁（18 桁以下）まで確かめてから渡す（SEC-NEWS-016）。
const newsIdPattern = /^\d{1,18}$/;

function getRequestUserAgent(request: Request): string | null {
  return request.headers.get('user-agent') || null;
}

async function logNewsAudit(
  request: Request,
  actorId: string,
  action: string,
  outcome: 'success' | 'failure',
  detail: string,
  metadata: Record<string, unknown>,
  resourceId: string | null = null
) {
  return logAudit({
    action,
    actor_id: actorId,
    resource: 'news_article',
    resource_id: resourceId,
    outcome,
    detail,
    user_agent: getRequestUserAgent(request),
    metadata,
  });
}

/**
 * 無い記事（形の悪い id・変更が 0 行）への変更を 404 で断り、失敗を監査に残す。
 * 形の悪い id は入力の生の値なので、監査には文字を残さず長さだけを残す。
 */
async function respondArticleNotFound(
  request: Request,
  actorId: string,
  action: string,
  id: string,
) {
  const validId = newsIdPattern.test(id);
  await logNewsAudit(
    request,
    actorId,
    action,
    'failure',
    'News article not found',
    validId ? { articleId: id } : { articleIdLength: id.length },
    validId ? id : null,
  );

  return NextResponse.json({ error: 'Article not found' }, { status: 404 });
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const authz = await authorizeAdminPermission('admin.news.read', request);
    if (!authz.ok) {
      return authz.response;
    }

    const [supabase, serviceSupabase] = await Promise.all([
      createClient(request),
      createServiceRoleClient(),
    ]);

    const { data, error } = await supabase
      .from('news_articles')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !data) {
      console.error('Failed to fetch news article:', error);
      return NextResponse.json({ error: 'Article not found' }, { status: 404 });
    }

    return NextResponse.json({ data: await signNewsImageFields(serviceSupabase, data) }, { status: 200 });
  } catch (error) {
    console.error('GET /api/admin/news/:id error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const authz = await authorizeAdminPermission('admin.news.manage', request);
    if (!authz.ok) {
      return authz.response;
    }

    if (!newsIdPattern.test(id)) {
      return respondArticleNotFound(request, authz.userId, 'admin.news.update.not_found', id);
    }

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

    const dbSupabase = await createClient(request);
    const uploadSupabase = await createServiceRoleClient();

    let imagePath: string | undefined = undefined;

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

      const { error: uploadError } = await uploadSupabase.storage
        .from('news-images')
        .upload(filePath, imageBuffer, {
          contentType: image.type,
          cacheControl: '3600',
          upsert: false,
        });

      if (uploadError) {
        await logNewsAudit(request, authz.userId, 'admin.news.update.upload_failed', 'failure', 'Image upload failed', {
          storagePath: filePath,
          articleId: id,
          imageType: image.type,
        }, id);

        console.error('Failed to upload image:', uploadError);
        return NextResponse.json({ error: 'Failed to upload image' }, { status: 500 });
      }

      imagePath = filePath;
    }

    const updatePayload: Record<string, unknown> = {
      title: parsed.data.title,
      category: parsed.data.category,
      published_date: parsed.data.date,
      content: parsed.data.content,
      detailed_content: parsed.data.detailedContent,
      status: parsed.data.status,
    };

    if (imagePath) {
      updatePayload.image_url = imagePath;
    }

    const { data: updatedRows, error } = await dbSupabase
      .from('news_articles')
      .update(updatePayload)
      .eq('id', id)
      .select('id');

    if (error) {
      await logNewsAudit(request, authz.userId, 'admin.news.update.failed', 'failure', 'News article update failed', {
        articleId: id,
        status: parsed.data.status,
        category: parsed.data.category,
      }, id);

      console.error('Failed to update news article:', error);
      return NextResponse.json({ error: 'Failed to update news article' }, { status: 500 });
    }

    // 0 行は「無い」と「RLS が隠した」の両方。成功と偽らず 404 にする（SEC-NEWS-016）。
    if (!updatedRows || updatedRows.length === 0) {
      return respondArticleNotFound(request, authz.userId, 'admin.news.update.not_found', id);
    }

    await logNewsAudit(request, authz.userId, 'admin.news.update', 'success', 'News article updated', {
      articleId: id,
      status: parsed.data.status,
      category: parsed.data.category,
    }, id);

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('PUT /api/admin/news/:id error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

const patchStatusSchema = z.object({
  status: z.enum(['private', 'published']),
});

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const authz = await authorizeAdminPermission('admin.news.manage', request);
    if (!authz.ok) {
      return authz.response;
    }

    if (!newsIdPattern.test(id)) {
      return respondArticleNotFound(request, authz.userId, 'admin.news.status_update.not_found', id);
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

    const supabase = await createClient(request);

    const { data: updatedRows, error } = await supabase
      .from('news_articles')
      .update({ status: parsed.data.status })
      .eq('id', id)
      .select('id');

    if (error) {
      await logNewsAudit(request, authz.userId, 'admin.news.status_update.failed', 'failure', 'News article status update failed', {
        articleId: id,
        status: parsed.data.status,
      }, id);

      console.error('Failed to update news article status:', error);
      return NextResponse.json({ error: 'Failed to update status' }, { status: 500 });
    }

    if (!updatedRows || updatedRows.length === 0) {
      return respondArticleNotFound(request, authz.userId, 'admin.news.status_update.not_found', id);
    }

    await logNewsAudit(request, authz.userId, 'admin.news.status_update', 'success', 'News article status updated', {
      articleId: id,
      status: parsed.data.status,
    }, id);

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('PATCH /api/admin/news/:id error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const authz = await authorizeAdminPermission('admin.news.manage', request);
    if (!authz.ok) {
      return authz.response;
    }

    if (!newsIdPattern.test(id)) {
      return respondArticleNotFound(request, authz.userId, 'admin.news.delete.not_found', id);
    }

    const supabase = await createClient(request);

    const { data: deletedRows, error } = await supabase
      .from('news_articles')
      .delete()
      .eq('id', id)
      .select('id');

    if (error) {
      await logNewsAudit(request, authz.userId, 'admin.news.delete.failed', 'failure', 'News article delete failed', {
        articleId: id,
      }, id);

      console.error('Failed to delete news article:', error);
      return NextResponse.json({ error: 'Failed to delete article' }, { status: 500 });
    }

    if (!deletedRows || deletedRows.length === 0) {
      return respondArticleNotFound(request, authz.userId, 'admin.news.delete.not_found', id);
    }

    await logNewsAudit(request, authz.userId, 'admin.news.delete', 'success', 'News article deleted', {
      articleId: id,
    }, id);

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('DELETE /api/admin/news/:id error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
