import clsx from 'clsx';

type SectionTitleProps = {
  title: string;
};

export function SectionTitle({ title }: SectionTitleProps) {
  return (
    <div className={clsx('text-left mb-6 md:mb-8')}>
      <h2 className={clsx('text-xl lg:text-2xl text-black tracking-tight underline underline-offset-8 decoration-black decoration-1')}>
        {title}
      </h2>
    </div>
  );
}
