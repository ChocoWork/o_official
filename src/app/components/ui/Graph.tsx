export interface GraphDatum {
  label: string;
  value: number;
}

export interface GraphProps {
  data: GraphDatum[];
  maxValue?: number;
}

export function Graph({ data, maxValue }: GraphProps) {
  const max = maxValue ?? Math.max(...data.map((item) => item.value), 1);

  return (
    <div className="space-y-3">
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
