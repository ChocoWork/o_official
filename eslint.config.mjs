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
              name: "@/app/components/ui",
              message:
                "`@/app/components/ui/<Component>` の直接importを使用してください。",
            },
            {
              name: "@/app/components/ui/index",
              message:
                "`@/app/components/ui/<Component>` の直接importを使用してください。",
            },
          ],
        },
      ],
    },
  },
];

export default eslintConfig;
