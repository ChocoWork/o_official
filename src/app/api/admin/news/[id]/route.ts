/**
 * 管理の記事1件の読み（GET）・更新（PUT）・公開の切り替え（PATCH）・削除（DELETE）の窓口（src/app/api/admin/news/[id]/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-NEWS-162
 * @design DD-NEWS-065
 * @remarks 表の読み書きは利用者の JWT の client で RLS に通し、窓口の認可が崩れても DB が断るようにする（SEC-NEWS-015、DATA-NEWS-002）。一覧のボタン1つで公開を切り替えられるよう、状態だけを変える PATCH を全体の更新の PUT と分ける（API-NEWS-006、STATE-NEWS-001）。直すたびに画像を付け直させないよう、PUT の画像は任意にする（API-NEWS-005）。変える操作は誰が何をしたかを追えるよう、成功も失敗も監査に残す。変更・削除が 0 行の時（無い記事、または RLS が隠した記事）は成功と偽らず 404 にして失敗を残す（SEC-NEWS-016）。
 * id は URL から来るので、形の悪い値は DB に渡さず 404 にし、1件の取り出しは「無い」と「DB の失敗」を分けて、誤りの文は応答にも記録にも出さない（SEC-NEWS-012、SEC-NEWS-020）。
 * 画像は申告の種類と中身の印が合う物だけを受け、保存名は自分で作る（SEC-NEWS-017）。
 * PUT は画像を上げる前に古い image_url を読み（無い記事なら何も上げない）、行を変えた後に古い画像を、行が変わらなかった時は新しく上げた画像を置き場から消す。
 * 削除は行を消した後に画像を消す。置き場は service role でないと消せないので、その client は消す時だけ作り、置き場の失敗は監査に残すだけで応答は成功のまま返す（SEC-NEWS-018）。
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { logAudit } from '@/lib/audit';
import { signNewsImageFields } from '@/lib/storage/news-images';
import { describeErrorForLog } from '@/lib/logging/safe-error';
import { isNewsId } from '@/features/news/lib/news-input';
import {
  NEWS_IMAGE_BUCKET,
  buildNewsImagePath,
  prepareNewsImage,
  removeNewsImages,
} from '@/features/news/services/admin-images';

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
  const validId = isNewsId(id);
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

    if (!isNewsId(id)) {
      return NextResponse.json({ error: 'Article not found' }, { status: 404 });
    }

    const [supabase, serviceSupabase] = await Promise.all([
      createClient(request),
      createServiceRoleClient(),
    ]);

    const { data, error } = await supabase
      .from('news_articles')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) {
      console.error('Failed to fetch news article:', describeErrorForLog(error));
      return NextResponse.json({ error: 'Failed to fetch news article' }, { status: 500 });
    }

    if (!data) {
      return NextResponse.json({ error: 'Article not found' }, { status: 404 });
    }

    return NextResponse.json({ data: await signNewsImageFields(serviceSupabase, data) }, { status: 200 });
  } catch (error) {
    console.error('GET /api/admin/news/:id error:', describeErrorForLog(error));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  // 置き場に上げたが、まだ行が指していない画像。行が変わらなかった・例外になった時にだけ消す。
  let unreferencedPath: string | null = null;
  let cleanupClient: Awaited<ReturnType<typeof createServiceRoleClient>> | null = null;

  try {
    const { id } = await params;
    const authz = await authorizeAdminPermission('admin.news.manage', request);
    if (!authz.ok) {
      return authz.response;
    }

    if (!isNewsId(id)) {
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
    let previousImageUrl: string | null = null;

    // 画像が新規アップロードされている場合
    if (image instanceof File) {
      if (!allowedImageTypes.has(image.type)) {
        return NextResponse.json({ error: 'Unsupported image type' }, { status: 400 });
      }

      if (image.size > maxImageBytes) {
        return NextResponse.json({ error: 'Image size must be 5MB or less' }, { status: 400 });
      }

      const prepared = await prepareNewsImage(image);
      if (!prepared) {
        return NextResponse.json({ error: 'Unsupported image type' }, { status: 400 });
      }

      // 古い画像の道筋は行を変える前でないと分からない。無い記事には何も上げない。
      const { data: previousRow, error: previousError } = await dbSupabase
        .from('news_articles')
        .select('image_url')
        .eq('id', id)
        .maybeSingle();

      if (previousError) {
        await logNewsAudit(request, authz.userId, 'admin.news.update.failed', 'failure', 'News article update failed', {
          articleId: id,
          status: parsed.data.status,
          category: parsed.data.category,
        }, id);

        console.error('Failed to read news article before update:', describeErrorForLog(previousError));
        return NextResponse.json({ error: 'Failed to update news article' }, { status: 500 });
      }

      if (!previousRow) {
        return respondArticleNotFound(request, authz.userId, 'admin.news.update.not_found', id);
      }

      previousImageUrl = typeof previousRow.image_url === 'string' ? previousRow.image_url : null;

      const filePath = buildNewsImagePath(prepared.extension);

      const { error: uploadError } = await uploadSupabase.storage
        .from(NEWS_IMAGE_BUCKET)
        .upload(filePath, prepared.buffer, {
          contentType: prepared.contentType,
          cacheControl: '3600',
          upsert: false,
        });

      if (uploadError) {
        await logNewsAudit(request, authz.userId, 'admin.news.update.upload_failed', 'failure', 'Image upload failed', {
          storagePath: filePath,
          articleId: id,
          imageType: prepared.contentType,
        }, id);

        console.error('Failed to upload image:', describeErrorForLog(uploadError));
        return NextResponse.json({ error: 'Failed to upload image' }, { status: 500 });
      }

      imagePath = filePath;
      unreferencedPath = filePath;
      cleanupClient = uploadSupabase;
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
      const imageCleanup = imagePath ? await removeNewsImages(uploadSupabase, [imagePath]) : undefined;
      unreferencedPath = null;

      await logNewsAudit(request, authz.userId, 'admin.news.update.failed', 'failure', 'News article update failed', {
        articleId: id,
        status: parsed.data.status,
        category: parsed.data.category,
        ...(imageCleanup ? { imageCleanup } : {}),
      }, id);

      console.error('Failed to update news article:', describeErrorForLog(error));
      return NextResponse.json({ error: 'Failed to update news article' }, { status: 500 });
    }

    // 0 行は「無い」と「RLS が隠した」の両方。成功と偽らず 404 にする（SEC-NEWS-016）。
    if (!updatedRows || updatedRows.length === 0) {
      if (imagePath) {
        await removeNewsImages(uploadSupabase, [imagePath]);
        unreferencedPath = null;
      }
      return respondArticleNotFound(request, authz.userId, 'admin.news.update.not_found', id);
    }

    // 行が新しい画像を指したので、古い画像だけを消す。新旧が同じ道筋なら消さない。
    unreferencedPath = null;
    const imageCleanup =
      imagePath && previousImageUrl
        ? await removeNewsImages(uploadSupabase, [previousImageUrl], [imagePath])
        : undefined;

    await logNewsAudit(request, authz.userId, 'admin.news.update', 'success', 'News article updated', {
      articleId: id,
      status: parsed.data.status,
      category: parsed.data.category,
      ...(imageCleanup ? { imageCleanup } : {}),
    }, id);

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    if (unreferencedPath && cleanupClient) {
      await removeNewsImages(cleanupClient, [unreferencedPath]);
    }

    console.error('PUT /api/admin/news/:id error:', describeErrorForLog(error));
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

    if (!isNewsId(id)) {
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

      console.error('Failed to update news article status:', describeErrorForLog(error));
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
    console.error('PATCH /api/admin/news/:id error:', describeErrorForLog(error));
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

    if (!isNewsId(id)) {
      return respondArticleNotFound(request, authz.userId, 'admin.news.delete.not_found', id);
    }

    const supabase = await createClient(request);

    const { data: deletedRows, error } = await supabase
      .from('news_articles')
      .delete()
      .eq('id', id)
      .select('id, image_url');

    if (error) {
      await logNewsAudit(request, authz.userId, 'admin.news.delete.failed', 'failure', 'News article delete failed', {
        articleId: id,
      }, id);

      console.error('Failed to delete news article:', describeErrorForLog(error));
      return NextResponse.json({ error: 'Failed to delete article' }, { status: 500 });
    }

    if (!deletedRows || deletedRows.length === 0) {
      return respondArticleNotFound(request, authz.userId, 'admin.news.delete.not_found', id);
    }

    // 行を消した後に画像を消す。置き場は service role でないと消せないので、ここで初めてその client を作る。
    let imageCleanup: 'ok' | 'failed';
    try {
      const storageSupabase = await createServiceRoleClient();
      imageCleanup = await removeNewsImages(
        storageSupabase,
        deletedRows.map((row) => (row as { image_url?: string | null }).image_url),
      );
    } catch (cleanupError) {
      console.error('Failed to remove news images:', describeErrorForLog(cleanupError));
      imageCleanup = 'failed';
    }

    await logNewsAudit(request, authz.userId, 'admin.news.delete', 'success', 'News article deleted', {
      articleId: id,
      imageCleanup,
    }, id);

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('DELETE /api/admin/news/:id error:', describeErrorForLog(error));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
