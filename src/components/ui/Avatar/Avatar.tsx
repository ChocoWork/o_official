import '@/components/ui/Avatar/Avatar.css';
import { cn } from '@/lib/utils';
import type { AvatarProps } from '@/components/ui/Avatar/Avatar_types';

export function Avatar({
  src,
  alt,
  fallback,
  size = 'md',
  icon,
  className,
  status,
}: AvatarProps) {
  const rootDataAttrs = {
    'data-ui-avatar': 'true',
    'data-ui-avatar-size': size,
    'data-ui-size': size,
  } as const;

  return (
    <span className={cn('avatar', className)} {...rootDataAttrs}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={alt} className="avatar__image" />
      ) : (
        <span className="avatar__fallback" role="img" aria-label={alt}>
          {icon ?? <span aria-hidden="true">{fallback}</span>}
        </span>
      )}
      {status ? (
        <span
          className="avatar__status"
          data-ui-avatar-status={status}
          aria-hidden="true"
        />
      ) : null}
    </span>
  );
}