import { cn } from '@/lib/utils';
import type { BaseOverlayProps } from './OverlayShell';

export function SheetMedium(props: BaseOverlayProps) {
  if (!props.open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40" onClick={props.onClose}>
      <aside
        className={cn('absolute bottom-0 left-0 right-0 mx-auto h-[55vh] max-w-4xl border border-black/10 bg-white p-6', props.className)}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          {props.title ? <h3 className="text-lg tracking-tight text-black">{props.title}</h3> : <span />}
          <button type="button" onClick={props.onClose} className="text-xl text-[#474747] hover:text-black" aria-label="close">
            ×
          </button>
        </div>
        {props.children}
      </aside>
    </div>
  );
}
