import type { ReactNode } from 'react';

export interface AccordionItem {
  key: string;
  title: string;
  content: ReactNode;
}

export interface AccordionProps {
  items: AccordionItem[];
}

export function Accordion({ items }: AccordionProps) {
  return (
    <div className="space-y-2">
      {items.map((item) => (
        <details key={item.key} className="border border-black/10 p-4">
          <summary className="cursor-pointer text-sm tracking-wider text-black">{item.title}</summary>
          <div className="pt-3 text-sm text-[#474747]">{item.content}</div>
        </details>
      ))}
    </div>
  );
}
