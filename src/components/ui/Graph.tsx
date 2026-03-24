import { cn } from '@/lib/utils';
import { ComponentSize } from './types';

export interface GraphDatum {
  label: string;
  value: number;
  color?: string;
}

export type GraphVariant = 'progress' | 'bars' | 'donut';

export interface GraphProps {
  data: readonly GraphDatum[];
  maxValue?: number;
  variant?: GraphVariant;
  className?: string;
  legendClassName?: string;
  /** 表示サイズ。文字列サイズまたは具体的な高さ(px) */
  size?: ComponentSize | number;
}

export function Graph({ data, maxValue, variant = 'progress', className, legendClassName, size = 'md' }: GraphProps) {
  if (data.length === 0) {
    return null;
  }

  const max = maxValue ?? Math.max(...data.map((item) => item.value), 1);

  const containerClass =
    typeof size === 'number'
      ? ''
      : size === 'sm'
      ? 'h-40'
      : size === 'lg'
      ? 'h-96'
      : 'h-64';
  const containerStyle = typeof size === 'number' ? { height: size } : undefined;

  if (variant === 'bars') {
    return (
      <div className={cn(containerClass, 'flex items-end justify-between gap-2', className)} style={containerStyle}>
        {data.map((item) => (
          <div key={item.label} className="flex flex-1 flex-col items-center gap-2">
            <div
              className="w-full cursor-pointer bg-black transition-colors hover:bg-[#474747]"
              style={{ height: `${Math.min(100, (item.value / max) * 100)}%` }}
            ></div>
            <span className="text-xs text-black/40" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
              {item.label}
            </span>
          </div>
        ))}
      </div>
    );
  }

  if (variant === 'donut') {
    const total = Math.max(1, data.reduce((sum, item) => sum + item.value, 0));
    const radius = 40;
    const circumference = 2 * Math.PI * radius;
    let accumulated = 0;

    return (
      <div className={cn(className)}>
        <div className={cn('flex items-center justify-center', containerClass)} style={containerStyle}>
          <div className="relative h-48 w-48">
            <svg viewBox="0 0 100 100" className="h-full w-full">
              <g transform="rotate(-90 50 50)">
                {data.map((item, index) => {
                  const fallbackColors = ['#000000', '#474747', '#808080', '#B0B0B0'];
                  const color = item.color ?? fallbackColors[index % fallbackColors.length];
                  const segment = (item.value / total) * circumference;
                  const offset = -accumulated;
                  accumulated += segment;

                  return (
                    <circle
                      key={item.label}
                      cx="50"
                      cy="50"
                      r={radius}
                      fill="none"
                      stroke={color}
                      strokeWidth="20"
                      strokeDasharray={`${segment} ${circumference}`}
                      strokeDashoffset={`${offset}`}
                    ></circle>
                  );
                })}
              </g>
            </svg>
          </div>
        </div>
        <div className={cn('mt-6 grid grid-cols-2 gap-4', legendClassName)}>
          {data.map((item, index) => {
            const fallbackColors = ['#000000', '#474747', '#808080', '#B0B0B0'];
            const color = item.color ?? fallbackColors[index % fallbackColors.length];

            return (
              <div key={item.label} className="flex items-center gap-2">
                <svg viewBox="0 0 12 12" className="h-3 w-3">
                  <rect x="0" y="0" width="12" height="12" fill={color}></rect>
                </svg>
                <span className="text-xs text-black/60" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                  {item.label} {Math.round((item.value / total) * 100)}%
                </span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className={cn('space-y-3', className)}>
      {data.map((item) => (
        <div key={item.label} className="space-y-1">
          <div className="flex items-center justify-between text-xs text-[#474747]">
            <span>{item.label}</span>
            <span>{item.value}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-[#f5f5f5]">
            <div className="h-full bg-black" style={{ width: `${Math.min(100, (item.value / max) * 100)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}
