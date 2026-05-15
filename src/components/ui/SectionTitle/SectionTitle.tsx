import clsx from 'clsx';

type SectionTitleProps = {
  title: string;
};

export function SectionTitle({ title }: SectionTitleProps) {
  return (
    <div className={clsx('text-left mb-[11px] sm:mb-[26px] md:mb-[34px] lg:mb-[55px]')}>
      <h2 className={clsx('underline underline-offset-8 decoration-black decoration-1 text-[18px] sm:text-[20px] md:text-[22px] lg:text-[26px] mb-[16px] sm:mb-[18px] md:mb-[20px] tracking-tight')}>
        {title}
      </h2>
    </div>
  );
}
