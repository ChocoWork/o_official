'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { LookForm } from '../../LookForm';
import { LookDetailResponse, LookFormValues } from '../../types';
import { clientFetch } from '@/lib/client-fetch';

export default function AdminLookEditPage() {
  const params = useParams<{ id: string }>();
  const lookId = params?.id;

  const [initialValues, setInitialValues] = useState<LookFormValues | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (!lookId) {
      setFetchError('LOOK IDの取得に失敗しました');
      setIsLoading(false);
      return;
    }

    const fetchLook = async () => {
      try {
        const response = await clientFetch(`/api/admin/looks/${lookId}`);
        const json = await response.json().catch(() => null);
        if (!response.ok) {
          setFetchError(json?.error ?? 'LOOKの取得に失敗しました');
          return;
        }

        const look = (json?.data ?? null) as LookDetailResponse | null;
        if (!look) {
          setFetchError('LOOKの取得に失敗しました');
          return;
        }

        const values: LookFormValues = {
          seasonYear: look.season_year,
          seasonType: look.season_type,
          theme: look.theme,
          themeDescription: look.theme_description ?? '',
          status: look.status,
          linkedItemIds: look.linkedItemIds ?? [],
          previewUrls: Array.isArray(look.image_urls) ? look.image_urls : [],
        };

        setInitialValues(values);
      } catch (error) {
        console.error('Failed to fetch look:', error);
        setFetchError('LOOKの取得に失敗しました');
      } finally {
        setIsLoading(false);
      }
    };

    void fetchLook();
  }, [lookId]);

  if (isLoading) {
    return (
      <main className="pt-32 pb-20">
        <div className="max-w-4xl mx-auto px-6 lg:px-12 text-center">読み込み中...</div>
      </main>
    );
  }

  if (fetchError) {
    return (
      <main className="pt-32 pb-20">
        <div className="max-w-4xl mx-auto px-6 lg:px-12 text-center text-red-600">
          {fetchError}
        </div>
      </main>
    );
  }

  if (!initialValues) {
    return null;
  }

  return (
    <LookForm
      submitUrl={`/api/admin/looks/${lookId}`}
      submitMethod="PUT"
      initialValues={initialValues}
    />
  );
}
