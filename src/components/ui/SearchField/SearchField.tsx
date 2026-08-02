import "./SearchField.css";
import type { KeyboardEvent } from "react";
import type { SearchFieldProps } from "./SearchField_type";

export type { SearchFieldProps } from "./SearchField_type";

export function SearchField({
  label,
  showClearButton = false,
  onClear,
  onSearch,
  searchButtonAriaLabel = "検索",
  className,
  value,
  size = 'md',
  onKeyDown,
  ...props
}: SearchFieldProps) {
  const hasValue = typeof value === 'string' && value.length > 0;
  const hasSearchButton = typeof onSearch === 'function';

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    onKeyDown?.(event);
    if (!event.defaultPrevented && event.key === 'Enter' && hasSearchButton) {
      event.preventDefault();
      onSearch();
    }
  };

  return (
    <label
      data-ui-search-field=""
      data-ui-size={size}
      className={className}
    >
      {label && <span data-ui-search-field-label="">{label}</span>}
      <div data-ui-search-field-wrapper="">
        {hasSearchButton ? null : (
          <span data-ui-search-field-icon="" aria-hidden="true">
            <i className="ri-search-line" />
          </span>
        )}
        <input
          type="search"
          value={value}
          onKeyDown={handleKeyDown}
          data-has-search-button={hasSearchButton ? "true" : undefined}
          data-ui-search-field-input=""
          {...props}
        />
        {showClearButton && hasValue && (
          <button
            type="button"
            aria-label="入力内容をクリア"
            onClick={onClear}
            data-ui-search-field-clear=""
          >
            <i className="ri-close-line" aria-hidden="true" />
          </button>
        )}
        {hasSearchButton ? (
          <button
            type="button"
            aria-label={searchButtonAriaLabel}
            onClick={onSearch}
            data-ui-search-field-submit=""
          >
            <i className="ri-search-line" aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </label>
  );
}
