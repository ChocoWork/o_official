import type { ReactNode } from 'react';
import { Card } from './Card';

export interface StatItem {
  label: string;
  value: string;
  icon?: ReactNode;
}

export interface StatsProps {
  items: StatItem[];
}

export function Stats({ items }: StatsProps) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {items.map((item) => (
        <Card key={item.label} className="p-4">
          {item.icon ? <div className="mb-3 text-black">{item.icon}</div> : null}
          <p className="text-xs tracking-wider text-[#474747]">{item.label}</p>
          <p className="mt-2 text-2xl tracking-tight text-black">{item.value}</p>
        </Card>
      ))}
    </div>
  );
}
