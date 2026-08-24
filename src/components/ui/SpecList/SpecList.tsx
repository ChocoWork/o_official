import { Fragment } from 'react';
import './SpecList.css';
import type { SpecListProps } from './SpecList_types';

export type { SpecListRow, SpecListProps } from './SpecList_types';

/**
 * ラベルと値の 2 列を罫線で区切って並べる仕様リスト。
 * MATERIAL / CARE / MADE IN のような属性表示に使う。
 */
export function SpecList({
  rows,
  className,
  labelClassName,
  valueClassName,
  size = 'md',
  'data-testid': dataTestId,
}: SpecListProps) {
  return (
    <dl
      data-ui-spec-list=""
      data-ui-size={size}
      data-testid={dataTestId}
      className={className}
    >
      {rows.map((row) => (
        <Fragment key={row.label}>
          <dt data-ui-spec-list-label="" className={labelClassName}>
            {row.label}
          </dt>
          <dd data-ui-spec-list-value="" className={valueClassName}>
            {row.value}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}
