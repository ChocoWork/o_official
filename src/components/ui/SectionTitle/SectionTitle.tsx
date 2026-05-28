import "./SectionTitle.css"
import clsx from 'clsx';

type SectionTitleProps = {
  title: string;
};

export function SectionTitle({ title }: SectionTitleProps) {
  return (
    <div className={clsx('text-left mb-[11px] sm:mb-[26px] md:mb-[34px] lg:mb-[55px]')}>
      <h2 className={clsx('underline underline-offset-8 decoration-black decoration-1 mb-[16px] sm:mb-[18px] md:mb-[20px] tracking-tight')} style={{ fontSize: 'var(--lk-size-3xl)' }}>
        {title}
      </h2>
    </div>
  );
}
