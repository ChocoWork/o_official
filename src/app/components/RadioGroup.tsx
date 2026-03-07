import { RadioButtonGroup } from '@/app/components/ui/RadioButtonGroup';

interface RadioGroupProps {
  name: string;
  options: { value: string; label: string }[];
  selectedValue: string;
  onChange: (value: string) => void;
}

export default function RadioGroup({ name, options, selectedValue, onChange }: RadioGroupProps) {
  return <RadioButtonGroup name={name} options={options} value={selectedValue} onChange={onChange}  size="md"/>;
}