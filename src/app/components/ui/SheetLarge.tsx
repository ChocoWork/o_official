import { cn } from '@/lib/utils';
import type { BaseOverlayProps } from './OverlayShell';
import { SheetMedium } from './SheetMedium';

export function SheetLarge(props: BaseOverlayProps) {
  return <SheetMedium {...props} className={cn('h-[80vh]', props.className)} />;
}
