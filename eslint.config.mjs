import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypeScript from 'eslint-config-next/typescript';

const eslintConfig = [
  {
    // スキルのサンプルは複数ファイルの断片を1枚に連結したドキュメントで、
    // 単体では成立しないコード。実装ではないので lint 対象から外す。
    ignores: [
      '.claude/skills/**/examples/**',
      '.github/skills/**/examples/**',
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypeScript,
  {
    files: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    rules: {
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/immutability': 'off',
      // react-hooks/static-components は止めない（推奨設定のまま有効）。部品を画面の関数の中で
      // 定義すると再描画のたびに作り直され、入力やフォーカスが消える（FREQ-372）。
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@/components/ui',
              message:
                '`@/components/ui/<Component>` の直接importを使用してください。',
            },
            {
              name: '@/components/ui/index',
              message:
                '`@/components/ui/<Component>` の直接importを使用してください。',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['tests/**/*.{ts,tsx,js,jsx}', 'jest.config.cjs'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'react/display-name': 'off',
      'prefer-const': 'off',
    },
  },
  {
    files: ['e2e/**/*.{ts,tsx,js,jsx}', 'scripts/**/*.{js,cjs,mjs}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
];

export default eslintConfig;
