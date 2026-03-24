import { cn } from '@/lib/utils';
import type { BaseOverlayProps } from './OverlayShell';

export function SheetMedium(props: BaseOverlayProps) {
  if (!props.open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" onClick={props.onClose}>
      <div className="absolute inset-0 bg-black/40"></div>
      <aside
        className={cn('relative w-full max-h-[50vh] overflow-y-auto bg-white', props.className)}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="p-8">
          <div className="mb-6 flex items-center justify-between">
            {props.title ? (
              <h3 className="text-2xl tracking-tight text-black" style={{ fontFamily: 'Didot, serif' }}>
                {props.title}
              </h3>
            ) : (
              <span />
            )}
            <button
              type="button"
              onClick={props.onClose}
              className="flex h-8 w-8 cursor-pointer items-center justify-center transition-colors hover:bg-[#f5f5f5]"
              aria-label="close"
            >
              <div className="flex h-5 w-5 items-center justify-center">
                <i className="ri-close-line text-xl"></i>
              </div>
            </button>
          </div>
          {props.children}
        </div>
      </aside>
    </div>
  );
}
