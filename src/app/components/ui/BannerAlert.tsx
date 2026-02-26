import { cn } from '@/lib/utils';

export interface BannerAlertProps {
  title: string;
  description?: string;
  variant?: 'info' | 'warning' | 'error' | 'success';
}

const bannerTone: Record<NonNullable<BannerAlertProps['variant']>, string> = {
  info: 'border-black/20 bg-[#f5f5f5] text-black',
  warning: 'border-black bg-[#f5f5f5] text-black',
  error: 'border-black bg-black text-white',
  success: 'border-black/20 bg-white text-black',
};

export function BannerAlert({ title, description, variant = 'info' }: BannerAlertProps) {
  return (
    <div className={cn('border p-4', bannerTone[variant])}>
      <p className="text-sm font-medium tracking-wider">{title}</p>
      {description ? <p className="mt-1 text-sm opacity-80">{description}</p> : null}
    </div>
  );
}
