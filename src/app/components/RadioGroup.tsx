interface RadioGroupProps {
  name: string;
  options: { value: string; label: string }[];
  selectedValue: string;
  onChange: (value: string) => void;
}

export default function RadioGroup({ name, options, selectedValue, onChange }: RadioGroupProps) {
  return (
    <div className="flex gap-4">
      {options.map((option) => (
        <label key={option.value} className="flex items-center gap-2 cursor-pointer">
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={selectedValue === option.value}
            onChange={() => onChange(option.value)}
            className="cursor-pointer"
          />
          <span className="text-sm font-acumin">{option.label}</span>
        </label>
      ))}
    </div>
  );
}