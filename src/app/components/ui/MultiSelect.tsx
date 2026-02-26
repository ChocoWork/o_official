import { Checkbox } from './Checkbox';
import type { SelectOption } from './shared';

export interface MultiSelectProps {
  options: SelectOption[];
  values: string[];
  onChange: (values: string[]) => void;
  label?: string;
}

export function MultiSelect({ options, values, onChange, label }: MultiSelectProps) {
  const handleChange = (optionValue: string) => {
    if (values.includes(optionValue)) {
      onChange(values.filter((value) => value !== optionValue));
      return;
    }
    onChange([...values, optionValue]);
  };

  return (
    <fieldset className="space-y-2">
      {label ? <legend className="text-xs tracking-wider text-black/80 font-brand">{label}</legend> : null}
      <div className="space-y-2 border border-black/20 p-3">
        {options.map((option) => (
          <Checkbox
            key={option.value}
            name={option.value}
            checked={values.includes(option.value)}
            onChange={() => handleChange(option.value)}
            label={option.label}
          />
        ))}
      </div>
    </fieldset>
  );
}
