'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import { Button } from '@/components/ui/Button/Button';
import { Card } from '@/components/ui/Card/Card';
import { StatusBadge } from '@/components/ui/StatusBadge/StatusBadge';
import { SingleSelect } from '@/components/ui/SingleSelect/SingleSelect';
import { TextField } from '@/components/ui/TextField/TextField';
import { TextAreaField } from '@/components/ui/TextAreaField/TextAreaField';

type InquiryStatus = 'open' | 'pending' | 'answered' | 'closed';
type InquiryType = 'product' | 'order' | 'other';

type ThreadListItem = {
  id: string;
  created_at: string;
  updated_at: string;
  last_message_at: string;
  name: string;
  email: string;
  inquiry_type: InquiryType;
  subject: string;
  status: InquiryStatus;
  order_id: string | null;
};

type ThreadMessage = {
  id: string;
  sender_role: 'user' | 'admin';
  body: string;
  channel: 'web' | 'email';
  created_at: string;
};

type ThreadDetail = ThreadListItem & {
  message: string;
  orderNumber: string | null;
  messages: ThreadMessage[];
};

type ReplyTemplate = {
  id: string;
  title: string;
  category: InquiryType | 'general' | null;
  body: string;
  sort_order: number;
};

const STATUS_LABELS: Record<InquiryStatus, string> = {
  open: '新規',
  pending: 'ユーザー返信あり',
  answered: '返信済み',
  closed: 'クローズ',
};

const STATUS_TONES: Record<InquiryStatus, 'positive' | 'neutral' | 'warning'> = {
  open: 'warning',
  pending: 'warning',
  answered: 'positive',
  closed: 'neutral',
};

const TYPE_LABELS: Record<InquiryType, string> = {
  product: '商品について',
  order: 'ご注文について',
  other: 'その他',
};

const STATUS_FILTER_OPTIONS = [
  { value: 'all', label: 'すべて' },
  { value: 'open', label: '新規' },
  { value: 'pending', label: 'ユーザー返信あり' },
  { value: 'answered', label: '返信済み' },
  { value: 'closed', label: 'クローズ' },
];

const TYPE_FILTER_OPTIONS = [
  { value: 'all', label: 'すべて' },
  { value: 'product', label: '商品について' },
  { value: 'order', label: 'ご注文について' },
  { value: 'other', label: 'その他' },
];

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export default function ContactSection() {
  const [threads, setThreads] = useState<ThreadListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalCount, setTotalCount] = useState(0);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);

  const [replyBody, setReplyBody] = useState('');
  const [isReplying, setIsReplying] = useState(false);
  const [replyNotice, setReplyNotice] = useState<string | null>(null);

  const [templates, setTemplates] = useState<ReplyTemplate[]>([]);
  const [showTemplateManager, setShowTemplateManager] = useState(false);

  const fetchThreads = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: '20' });
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (typeFilter !== 'all') params.set('type', typeFilter);
      if (search) params.set('q', search);

      const res = await clientFetch(`/api/admin/contact?${params.toString()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      const json = await res.json();
      setThreads(json.data ?? []);
      setTotalPages(json.totalPages ?? 1);
      setTotalCount(json.totalCount ?? 0);
    } catch (error) {
      console.error('Failed to load inquiries:', error);
      setErrorMessage('問い合わせ一覧の取得に失敗しました。');
    } finally {
      setIsLoading(false);
    }
  }, [page, statusFilter, typeFilter, search]);

  const fetchTemplates = useCallback(async () => {
    try {
      const res = await clientFetch('/api/admin/contact/templates', { cache: 'no-store' });
      if (!res.ok) return;
      const json = await res.json();
      setTemplates(json.data ?? []);
    } catch (error) {
      console.error('Failed to load templates:', error);
    }
  }, []);

  const fetchDetail = useCallback(async (id: string) => {
    setIsDetailLoading(true);
    setReplyNotice(null);
    try {
      const res = await clientFetch(`/api/admin/contact/${id}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      const json = await res.json();
      setDetail(json.data);
    } catch (error) {
      console.error('Failed to load inquiry detail:', error);
      setDetail(null);
    } finally {
      setIsDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchThreads();
  }, [fetchThreads]);

  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  useEffect(() => {
    if (selectedId) {
      fetchDetail(selectedId);
    } else {
      setDetail(null);
    }
  }, [selectedId, fetchDetail]);

  const relevantTemplates = useMemo(() => {
    if (!detail) return templates;
    return templates.filter((template) => template.category === null || template.category === 'general' || template.category === detail.inquiry_type);
  }, [templates, detail]);

  const handleSearchSubmit = () => {
    setPage(1);
    setSearch(searchInput.trim());
  };

  const handleReply = async () => {
    if (!selectedId || replyBody.trim().length === 0) return;
    setIsReplying(true);
    setReplyNotice(null);
    try {
      const res = await clientFetch(`/api/admin/contact/${selectedId}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: replyBody.trim() }),
      });
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      const json = await res.json().catch(() => ({}));
      setReplyBody('');
      setReplyNotice(json.mailSent === false ? '返信を保存しました（メール送信は失敗しました）。' : '返信を送信しました。');
      await fetchDetail(selectedId);
      await fetchThreads();
    } catch (error) {
      console.error('Failed to send reply:', error);
      setReplyNotice('返信の送信に失敗しました。');
    } finally {
      setIsReplying(false);
    }
  };

  const handleStatusChange = async (status: InquiryStatus) => {
    if (!selectedId) return;
    try {
      const res = await clientFetch(`/api/admin/contact/${selectedId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      await fetchDetail(selectedId);
      await fetchThreads();
    } catch (error) {
      console.error('Failed to update status:', error);
    }
  };

  const applyTemplate = (templateId: string) => {
    const template = templates.find((item) => item.id === templateId);
    if (template) {
      setReplyBody(template.body);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 border-b border-black/10 pb-4">
        <div className="w-40">
          <SingleSelect
            name="contact-status"
            label="ステータス"
            value={statusFilter}
            onValueChange={(value) => {
              setPage(1);
              setStatusFilter(value);
            }}
            options={STATUS_FILTER_OPTIONS}
            size="sm"
            variant="dropdown"
            block
          />
        </div>
        <div className="w-40">
          <SingleSelect
            name="contact-type"
            label="種別"
            value={typeFilter}
            onValueChange={(value) => {
              setPage(1);
              setTypeFilter(value);
            }}
            options={TYPE_FILTER_OPTIONS}
            size="sm"
            variant="dropdown"
            block
          />
        </div>
        <div className="flex items-end gap-2">
          <TextField
            id="contact-search"
            label="検索（名前・メール・件名）"
            type="text"
            size="sm"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleSearchSubmit();
            }}
          />
          <Button variant="secondary" size="sm" className="font-acumin" onClick={handleSearchSubmit}>
            検索
          </Button>
        </div>
        <Button variant="secondary" size="sm" className="font-acumin" onClick={() => setShowTemplateManager((prev) => !prev)}>
          {showTemplateManager ? 'テンプレート管理を閉じる' : 'テンプレート管理'}
        </Button>
      </div>

      {showTemplateManager ? (
        <TemplateManager templates={templates} onChanged={fetchTemplates} />
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,360px)_1fr]">
        {/* 一覧 */}
        <div className="space-y-3">
          <div className="flex items-center justify-between text-xs font-acumin text-[#474747]">
            <span>{totalCount}件</span>
            <div className="flex items-center gap-2">
              <span>{page} / {totalPages}ページ</span>
              <Button variant="secondary" size="sm" className="font-acumin" disabled={page <= 1 || isLoading} onClick={() => setPage((prev) => Math.max(1, prev - 1))}>
                前へ
              </Button>
              <Button variant="secondary" size="sm" className="font-acumin" disabled={page >= totalPages || isLoading} onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}>
                次へ
              </Button>
            </div>
          </div>

          {errorMessage ? <p className="text-sm text-red-700 font-acumin">{errorMessage}</p> : null}

          {isLoading ? (
            <div className="py-8 text-center text-sm text-[#474747] font-acumin">読み込み中...</div>
          ) : threads.length === 0 ? (
            <div className="py-8 text-center text-sm text-[#474747] font-acumin">問い合わせがありません</div>
          ) : (
            <ul className="space-y-2" role="list">
              {threads.map((thread) => (
                <li key={thread.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(thread.id)}
                    className={`w-full text-left border p-3 transition-colors ${selectedId === thread.id ? 'border-black bg-black/5' : 'border-black/10 hover:bg-black/[0.02]'}`}
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <StatusBadge tone={STATUS_TONES[thread.status]} size="sm">
                        {STATUS_LABELS[thread.status]}
                      </StatusBadge>
                      <span className="text-[11px] text-[#474747] font-acumin">{formatDateTime(thread.last_message_at)}</span>
                    </div>
                    <p className="truncate text-sm text-black font-acumin">{thread.subject}</p>
                    <p className="truncate text-xs text-[#474747] font-acumin">
                      {TYPE_LABELS[thread.inquiry_type]}・{thread.name}（{thread.email}）
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* 詳細 + チャット + 返信 */}
        <div>
          {!selectedId ? (
            <Card size="md" className="text-sm text-[#474747] font-acumin">
              左の一覧から問い合わせを選択してください。
            </Card>
          ) : isDetailLoading || !detail ? (
            <Card size="md" className="text-sm text-[#474747] font-acumin">読み込み中...</Card>
          ) : (
            <div className="space-y-4">
              <Card size="md" className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-lg text-black font-acumin">{detail.subject}</h4>
                  <StatusBadge tone={STATUS_TONES[detail.status]} size="md">{STATUS_LABELS[detail.status]}</StatusBadge>
                </div>
                <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm text-[#474747] font-acumin sm:grid-cols-2">
                  <div><dt className="inline font-medium">お名前：</dt><dd className="inline">{detail.name}</dd></div>
                  <div><dt className="inline font-medium">メール：</dt><dd className="inline">{detail.email}</dd></div>
                  <div><dt className="inline font-medium">種別：</dt><dd className="inline">{TYPE_LABELS[detail.inquiry_type]}</dd></div>
                  <div><dt className="inline font-medium">注文番号：</dt><dd className="inline">{detail.orderNumber ?? '—'}</dd></div>
                  <div><dt className="inline font-medium">受信日時：</dt><dd className="inline">{formatDateTime(detail.created_at)}</dd></div>
                </dl>
                <div className="flex flex-wrap items-end gap-2 pt-2">
                  <div className="w-44">
                    <SingleSelect
                      name="contact-status-change"
                      label="ステータス変更"
                      value={detail.status}
                      onValueChange={(value) => handleStatusChange(value as InquiryStatus)}
                      options={STATUS_FILTER_OPTIONS.filter((option) => option.value !== 'all')}
                      size="sm"
                      variant="dropdown"
                      block
                    />
                  </div>
                </div>
              </Card>

              <div className="space-y-3">
                {detail.messages.map((message) => (
                  <div key={message.id} className={`flex ${message.sender_role === 'admin' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[80%] whitespace-pre-wrap border p-3 text-sm font-acumin ${message.sender_role === 'admin' ? 'border-black bg-black/[0.04]' : 'border-black/10 bg-white'}`}>
                      <div className="mb-1 flex items-center gap-2 text-[11px] text-[#474747]">
                        <span>{message.sender_role === 'admin' ? '管理者' : 'お客様'}</span>
                        <span>・{message.channel === 'email' ? 'メール' : 'サイト'}</span>
                        <span>・{formatDateTime(message.created_at)}</span>
                      </div>
                      <p className="text-black">{message.body}</p>
                    </div>
                  </div>
                ))}
              </div>

              <Card size="md" className="space-y-3">
                <div className="flex flex-wrap items-end gap-2">
                  <div className="w-full sm:w-64">
                    <SingleSelect
                      name="contact-template"
                      label="テンプレートを選択"
                      value=""
                      onValueChange={applyTemplate}
                      options={relevantTemplates.map((template) => ({ value: template.id, label: template.title }))}
                      placeholder={relevantTemplates.length > 0 ? '選択してください' : 'テンプレートがありません'}
                      size="sm"
                      variant="dropdown"
                      block
                    />
                  </div>
                </div>
                <TextAreaField
                  id="contact-reply"
                  label="返信内容"
                  rows={6}
                  size="md"
                  className="w-full"
                  value={replyBody}
                  onChange={(event) => setReplyBody(event.target.value)}
                />
                {replyNotice ? <p className="text-sm text-[#474747] font-acumin" role="status">{replyNotice}</p> : null}
                <div className="flex justify-end">
                  <Button size="md" className="font-acumin" onClick={handleReply} disabled={isReplying || replyBody.trim().length === 0}>
                    {isReplying ? '送信中...' : '返信を送信'}
                  </Button>
                </div>
              </Card>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

type TemplateManagerProps = {
  templates: ReplyTemplate[];
  onChanged: () => void | Promise<void>;
};

const TEMPLATE_CATEGORY_OPTIONS = [
  { value: 'general', label: '汎用' },
  { value: 'product', label: '商品について' },
  { value: 'order', label: 'ご注文について' },
  { value: 'other', label: 'その他' },
];

function TemplateManager({ templates, onChanged }: TemplateManagerProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('general');
  const [body, setBody] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const resetForm = () => {
    setEditingId(null);
    setTitle('');
    setCategory('general');
    setBody('');
  };

  const startEdit = (template: ReplyTemplate) => {
    setEditingId(template.id);
    setTitle(template.title);
    setCategory(template.category ?? 'general');
    setBody(template.body);
  };

  const handleSave = async () => {
    if (title.trim().length === 0 || body.trim().length === 0) return;
    setIsSaving(true);
    try {
      const payload = JSON.stringify({ title: title.trim(), category, body: body.trim() });
      const res = editingId
        ? await clientFetch(`/api/admin/contact/templates/${editingId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: payload })
        : await clientFetch('/api/admin/contact/templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      resetForm();
      await onChanged();
    } catch (error) {
      console.error('Failed to save template:', error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('このテンプレートを削除しますか？')) return;
    try {
      const res = await clientFetch(`/api/admin/contact/templates/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      if (editingId === id) resetForm();
      await onChanged();
    } catch (error) {
      console.error('Failed to delete template:', error);
    }
  };

  return (
    <Card size="md" className="space-y-4">
      <h4 className="text-base text-black font-acumin">返信テンプレート管理</h4>
      <div className="space-y-2">
        {templates.length === 0 ? (
          <p className="text-sm text-[#474747] font-acumin">テンプレートがありません。</p>
        ) : (
          templates.map((template) => (
            <div key={template.id} className="flex items-center justify-between gap-3 border border-black/10 p-2">
              <div className="min-w-0">
                <p className="truncate text-sm text-black font-acumin">{template.title}</p>
                <p className="truncate text-xs text-[#474747] font-acumin">
                  {TEMPLATE_CATEGORY_OPTIONS.find((option) => option.value === (template.category ?? 'general'))?.label}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button variant="secondary" size="sm" className="font-acumin" onClick={() => startEdit(template)}>編集</Button>
                <Button variant="primary" size="sm" className="font-acumin" onClick={() => handleDelete(template.id)}>削除</Button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="space-y-2 border-t border-black/10 pt-3">
        <p className="text-sm text-black font-acumin">{editingId ? 'テンプレートを編集' : '新規テンプレート'}</p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[200px]">
            <TextField id="template-title" label="タイトル" type="text" size="sm" className="w-full" value={title} onChange={(event) => setTitle(event.target.value)} />
          </div>
          <div className="w-44">
            <SingleSelect
              name="template-category"
              label="カテゴリ"
              value={category}
              onValueChange={setCategory}
              options={TEMPLATE_CATEGORY_OPTIONS}
              size="sm"
              variant="dropdown"
              block
            />
          </div>
        </div>
        <TextAreaField id="template-body" label="本文" rows={4} size="md" className="w-full" value={body} onChange={(event) => setBody(event.target.value)} />
        <div className="flex justify-end gap-2">
          {editingId ? (
            <Button variant="secondary" size="sm" className="font-acumin" onClick={resetForm}>キャンセル</Button>
          ) : null}
          <Button size="sm" className="font-acumin" onClick={handleSave} disabled={isSaving || title.trim().length === 0 || body.trim().length === 0}>
            {isSaving ? '保存中...' : '保存'}
          </Button>
        </div>
      </div>
    </Card>
  );
}
