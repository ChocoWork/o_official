import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    files: ["**/*.{ts,tsx,js,jsx,mjs,cjs}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/components/ui",
              message:
                "`@/components/ui/<Component>` の直接importを使用してください。",
            },
            {
              name: "@/components/ui/index",
              message:
                "`@/components/ui/<Component>` の直接importを使用してください。",
            },
          ],
        },
      ],
    },
  },
];

export default eslintConfig;
