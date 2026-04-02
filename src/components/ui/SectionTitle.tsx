import clsx from 'clsx';

type SectionTitleProps = {
  title: string;
};

export function SectionTitle({ title }: SectionTitleProps) {
  return (
    <div className={clsx('text-left mb-6 md:mb-8 lg:mb-12')}>
      <h2 className={clsx('text-2xl md:text-3xl lg:text-4xl text-black tracking-tight underline underline-offset-8 decoration-black decoration-1')}>
        {title}
      </h2>
    </div>
  );
}
