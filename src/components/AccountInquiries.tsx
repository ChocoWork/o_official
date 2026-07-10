'use client';

import { useCallback, useEffect, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import { Button } from '@/components/ui/Button/Button';
import { TextAreaField } from '@/components/ui/TextAreaField/TextAreaField';

type InquiryStatus = 'open' | 'pending' | 'answered' | 'closed';
type InquiryType = 'product' | 'order' | 'other';

type ThreadListItem = {
  id: string;
  created_at: string;
  last_message_at: string;
  inquiry_type: InquiryType;
  subject: string;
  status: InquiryStatus;
};

type ThreadMessage = {
  id: string;
  sender_role: 'user' | 'admin';
  body: string;
  channel: 'web' | 'email';
  created_at: string;
};

type ThreadDetail = ThreadListItem & {
  updated_at: string;
  messages: ThreadMessage[];
};

const STATUS_LABELS: Record<InquiryStatus, string> = {
  open: '受付済み',
  pending: '確認中',
  answered: '返信あり',
  closed: '完了',
};

const TYPE_LABELS: Record<InquiryType, string> = {
  product: '商品について',
  order: 'ご注文について',
  other: 'その他',
};

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// 一覧の日時: 購入履歴タブと同じ「YYYY.MM.DD」表記
function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}.${m}.${d}`;
}

export default function AccountInquiries() {
  const [threads, setThreads] = useState<ThreadListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [replyBody, setReplyBody] = useState('');
  const [isReplying, setIsReplying] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const fetchThreads = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await clientFetch('/api/contact/threads', { cache: 'no-store' });
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      const json = await res.json();
      setThreads(json.data ?? []);
    } catch (err) {
      console.error('Failed to load inquiries:', err);
      setError('お問い合わせ履歴を読み込めませんでした。');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const fetchDetail = useCallback(async (id: string) => {
    setIsDetailLoading(true);
    setNotice(null);
    try {
      const res = await clientFetch(`/api/contact/threads/${id}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      const json = await res.json();
      setDetail(json.data);
    } catch (err) {
      console.error('Failed to load inquiry detail:', err);
      setDetail(null);
    } finally {
      setIsDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchThreads();
  }, [fetchThreads]);

  useEffect(() => {
    if (selectedId) {
      fetchDetail(selectedId);
    } else {
      setDetail(null);
    }
  }, [selectedId, fetchDetail]);

  const handleReply = async () => {
    if (!selectedId || replyBody.trim().length === 0) return;
    setIsReplying(true);
    setNotice(null);
    try {
      const res = await clientFetch(`/api/contact/threads/${selectedId}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: replyBody.trim() }),
      });
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      setReplyBody('');
      setNotice('返信を送信しました。');
      await fetchDetail(selectedId);
      await fetchThreads();
    } catch (err) {
      console.error('Failed to send reply:', err);
      setNotice('返信の送信に失敗しました。');
    } finally {
      setIsReplying(false);
    }
  };

  if (selectedId) {
    return (
      <div className="account-sections">
        <div className="account-actions">
          <Button type="button" variant="secondary" size="sm" className="font-acumin" onClick={() => setSelectedId(null)}>
            一覧に戻る
          </Button>
        </div>

        {isDetailLoading || !detail ? (
          <div className="account-card account-groups">
            <p className="text-[#474747]">読み込み中...</p>
          </div>
        ) : (
          <div className="account-card account-groups space-y-4">
            <div>
              <span className="account-status">{STATUS_LABELS[detail.status]}</span>
              <p className="text-black mt-2" style={{ fontSize: 'var(--lk-size-lg)' }}>{detail.subject}</p>
              <p className="account-label">{TYPE_LABELS[detail.inquiry_type]}・{formatDateTime(detail.created_at)}</p>
            </div>

            <div className="space-y-3">
              {detail.messages.map((message) => (
                <div key={message.id} className={`flex ${message.sender_role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] whitespace-pre-wrap border p-3 text-sm ${message.sender_role === 'user' ? 'border-black bg-black/[0.04]' : 'border-black/10 bg-white'}`}>
                    <div className="mb-1 text-[11px] text-[#474747]">
                      {message.sender_role === 'user' ? 'あなた' : 'サポート'}・{formatDateTime(message.created_at)}
                    </div>
                    <p className="text-black">{message.body}</p>
                  </div>
                </div>
              ))}
            </div>

            <div className="space-y-2 border-t border-black/10 pt-4">
              <TextAreaField
                id="account-inquiry-reply"
                label="返信する"
                rows={4}
                size="md"
                className="w-full"
                value={replyBody}
                onChange={(event) => setReplyBody(event.target.value)}
              />
              {notice ? <p className="text-sm text-[#474747]" role="status">{notice}</p> : null}
              <div className="account-actions">
                <Button size="sm" className="font-acumin" onClick={handleReply} disabled={isReplying || replyBody.trim().length === 0}>
                  {isReplying ? '送信中...' : '返信を送信'}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="account-sections">
      {isLoading ? (
        <div className="account-card account-groups animate-pulse" aria-hidden="true">
          <div className="h-3 w-1/3 bg-black/8 mb-2" />
          <div className="h-4 w-1/2 bg-black/8" />
        </div>
      ) : null}

      {error ? <p className="text-red-600 account-feedback">{error}</p> : null}

      {!isLoading && !error && threads.length === 0 ? (
        <div className="account-card account-groups">
          <p className="text-black" style={{ fontSize: 'var(--lk-size-lg)' }}>お問い合わせ履歴はありません</p>
          <p className="text-[#474747]" style={{ fontSize: 'var(--lk-size-md)' }}>
            お問い合わせいただくと、こちらでやり取りを確認できます。
          </p>
        </div>
      ) : null}

      {threads.length > 0 ? (
        <div className="account-inquiry-list">
          {threads.map((thread) => (
            <button
              key={thread.id}
              type="button"
              onClick={() => setSelectedId(thread.id)}
              className="account-inquiry-item w-full text-left"
            >
              <p className="account-value account-inquiry-subject">{thread.subject}</p>
              <span className="account-status account-status-sm account-inquiry-status">{STATUS_LABELS[thread.status]}</span>
              <p className="account-label">{TYPE_LABELS[thread.inquiry_type]}</p>
              <span className="account-order-entry-date account-inquiry-date">
                {formatDate(thread.last_message_at)}
                <i className="ri-arrow-right-line" aria-hidden="true" />
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
