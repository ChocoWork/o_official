'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { SingleSelect } from '@/components/ui/SingleSelect';
import { TextField } from '@/components/ui/TextField';
import { clientFetch } from '@/lib/client-fetch';
import { StockistType } from '@/features/stockist/types';
import { StockistFormValues, StockistStatus } from './types';

const STOCKIST_TYPE_OPTIONS: Array<{ value: StockistType; label: StockistType }> = [
  { value: 'FLAGSHIP STORE', label: 'FLAGSHIP STORE' },
  { value: 'STORE', label: 'STORE' },
  { value: 'SELECT SHOP', label: 'SELECT SHOP' },
];

const STOCKIST_STATUS_OPTIONS: Array<{ value: StockistStatus; label: string }> = [
  { value: 'private', label: '非公開' },
  { value: 'published', label: '公開' },
];

type StockistFormProps = {
  submitUrl: string;
  submitMethod: 'POST' | 'PUT';
  initialValues?: StockistFormValues;
  isLoading?: boolean;
};

export function StockistForm({ submitUrl, submitMethod, initialValues, isLoading = false }: StockistFormProps) {
  const router = useRouter();

  const [type, setType] = useState<StockistType>(initialValues?.type ?? 'STORE');
  const [name, setName] = useState(initialValues?.name ?? '');
  const [address, setAddress] = useState(initialValues?.address ?? '');
  const [phone, setPhone] = useState(initialValues?.phone ?? '');
  const [time, setTime] = useState(initialValues?.time ?? '');
  const [holiday, setHoliday] = useState(initialValues?.holiday ?? '');
  const [status, setStatus] = useState<StockistStatus>(initialValues?.status ?? 'private');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (!initialValues) {
      return;
    }

    setType(initialValues.type);
    setName(initialValues.name);
    setAddress(initialValues.address);
    setPhone(initialValues.phone);
    setTime(initialValues.time);
    setHoliday(initialValues.holiday);
    setStatus(initialValues.status);
  }, [initialValues]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitError(null);
    setSubmitSuccess(null);

    const trimmedName = name.trim();
    const trimmedAddress = address.trim();
    const trimmedPhone = phone.trim();
    const trimmedTime = time.trim();
    const trimmedHoliday = holiday.trim();

    if (!trimmedName || !trimmedAddress || !trimmedPhone || !trimmedTime || !trimmedHoliday) {
      setSubmitError('必須項目を入力してください');
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await clientFetch(submitUrl, {
        method: submitMethod,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type,
          name: trimmedName,
          address: trimmedAddress,
          phone: trimmedPhone,
          time: trimmedTime,
          holiday: trimmedHoliday,
          status,
        }),
      });

      const responseJson = await response.json().catch(() => null);
      if (!response.ok) {
        setSubmitError(responseJson?.error ?? 'STOCKISTの保存に失敗しました');
        return;
      }

      setSubmitSuccess(submitMethod === 'PUT' ? 'STOCKISTを更新しました' : 'STOCKISTを保存しました');
      router.push('/admin?tab=STOCKIST');
    } catch (error) {
      console.error('Failed to submit stockist:', error);
      setSubmitError('通信エラーが発生しました。時間をおいて再度お試しください');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <main className="pt-32 pb-20">
        <div className="max-w-4xl mx-auto px-6 lg:px-12 text-center">読み込み中...</div>
      </main>
    );
  }

  return (
    <main className="pt-32 pb-20">
      <div className="max-w-4xl mx-auto px-6 lg:px-12">
        <form className="space-y-8" onSubmit={handleSubmit}>
          <SingleSelect
            label="公開状態"
            variant="dropdown"
            value={status}
            onValueChange={(value) => setStatus(value as StockistStatus)}
            options={STOCKIST_STATUS_OPTIONS}
            size="md"
          />

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <TextField
              required
              label="店舗名"
              value={name}
              onChange={(event) => setName(event.target.value)}
              size="md"
            />

            <SingleSelect
              label="店舗種別"
              variant="dropdown"
              value={type}
              onValueChange={(value) => setType(value as StockistType)}
              options={STOCKIST_TYPE_OPTIONS}
              size="md"
            />
          </div>

          <TextField
            required
            label="住所"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            size="md"
          />

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <TextField
              required
              label="電話番号"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              size="md"
            />

            <TextField
              required
              label="営業時間"
              value={time}
              onChange={(event) => setTime(event.target.value)}
              size="md"
            />

            <TextField
              required
              label="定休日"
              value={holiday}
              onChange={(event) => setHoliday(event.target.value)}
              size="md"
            />
          </div>

          {submitError ? <p className="text-sm text-red-600 font-acumin">{submitError}</p> : null}
          {submitSuccess ? <p className="text-sm text-green-700 font-acumin">{submitSuccess}</p> : null}

          <div className="pt-2 flex justify-end">
            <Button type="submit" variant="primary" size="sm" className="font-acumin" disabled={isSubmitting}>
              {isSubmitting ? '保存中...' : submitMethod === 'PUT' ? '更新' : '保存'}
            </Button>
          </div>
        </form>
      </div>
    </main>
  );
}
