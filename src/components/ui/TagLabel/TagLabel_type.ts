import type { ReactNode } from "react";
import type { ComponentSize } from "@/components/ui/types";

export interface TagLabelProps {
  children: ReactNode;
  variant?: "solid" | "outline" | "subtle";
  rounded?: boolean;
  removable?: boolean;
  onRemove?: () => void;
  className?: string;
  /** tag size */
  size?: ComponentSize;
}
