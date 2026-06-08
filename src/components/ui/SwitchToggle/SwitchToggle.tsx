import "./SwitchToggle.css";
import type { SwitchToggleProps } from './SwitchToggle_type';

export type { SwitchToggleProps } from './SwitchToggle_type';

export function SwitchToggle({
  checked,
  onChange,
  label,
  disabled = false,
  fullWidth = false,
  size = 'md',
}: SwitchToggleProps) {
  return (
    <label
      data-ui-switch=""
      data-ui-switch-checked={checked ? 'true' : undefined}
      data-ui-switch-disabled={disabled ? 'true' : undefined}
      data-ui-switch-fullwidth={fullWidth ? 'true' : undefined}
      data-ui-size={size}
    >
      {label ? <span data-ui-switch-label="">{label}</span> : null}
      <button
        type="button"
        data-ui-switch-track=""
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        disabled={disabled}
      >
        <span data-ui-switch-thumb="" />
      </button>
    </label>
  );
}
