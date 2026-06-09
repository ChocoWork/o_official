import "./SearchField.css";
import type { SearchFieldProps } from "./SearchField_type";

export type { SearchFieldProps } from "./SearchField_type";

export function SearchField({
  label,
  showClearButton = false,
  onClear,
  className,
  value,
  size = 'md',
  ...props
}: SearchFieldProps) {
  const hasValue = typeof value === 'string' && value.length > 0;

  return (
    <label
      data-ui-search-field=""
      data-ui-size={size}
      className={className}
    >
      {label && <span data-ui-search-field-label="">{label}</span>}
      <div data-ui-search-field-wrapper="">
        <span data-ui-search-field-icon="" aria-hidden="true">
          <i className="ri-search-line" />
        </span>
        <input
          type="search"
          value={value}
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
      </div>
    </label>
  );
}
