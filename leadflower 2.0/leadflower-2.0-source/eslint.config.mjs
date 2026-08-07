import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import security from 'eslint-plugin-security'
import reactHooks from 'eslint-plugin-react-hooks'

/**
 * Security-focused lint configuration.
 *
 * Scoped deliberately narrowly. A full style ruleset applied to an existing
 * codebase produces thousands of findings, which trains everyone to ignore the
 * output — and the security rules go with it.
 */
import globals from 'globals'

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/*.d.ts'] },
  { linterOptions: { reportUnusedDisableDirectives: false } },
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  security.configs.recommended,
  {
    // The React rules apply only to the client. Existing inline suppression
    // comments there were written against these rules; without the plugin
    // installed they would reference an unknown rule and quietly hide the
    // findings they were meant to suppress.
    files: ['client/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // `server/scripts/**/*.mjs` is listed alongside the root scripts directory
    // so build-time Node scripts get the same ruleset as everything else rather
    // than the stricter default, which flags every path built from import.meta.
    files: ['server/**/*.ts', 'server/scripts/**/*.mjs', 'client/**/*.{ts,tsx}', 'scripts/**/*.mjs', '*.mjs', '*.ts'],
    rules: {
      // Findings that indicate a real vulnerability class.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'security/detect-eval-with-expression': 'error',
      'security/detect-child-process': 'error',
      'security/detect-non-literal-require': 'error',
      'security/detect-unsafe-regex': 'error',
      'security/detect-pseudoRandomBytes': 'error',
      'security/detect-new-buffer': 'error',

      // Noisy heuristics on a codebase that indexes objects by validated keys.
      // Object-injection risk here is covered by the prototype-pollution guards
      // in safeExpression and the batch transforms, which are unit tested.
      'security/detect-object-injection': 'off',
      'security/detect-non-literal-fs-filename': 'off',

      // Heuristic rules that fire on safe patterns in this codebase and would
      // otherwise bury the findings above.
      // `detect-possible-timing-attacks` flags boolean `=== true` comparisons
      // on health results, which carry no secret. Real secret comparison goes
      // through crypto.timingSafeEqual in webhookSecurity and tokens.
      'security/detect-possible-timing-attacks': 'off',
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',

      // Style rules that would otherwise bury the findings above.
      '@typescript-eslint/no-explicit-any': 'off',
      // The react-hooks plugin is not installed; inline directives referencing
      // its rules would otherwise error as unknown.
      'no-undef': 'off', // TypeScript resolves identifiers; this rule double-reports.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-empty-object-type': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-useless-escape': 'off',
      // Control characters in the artifact filename sanitiser are the point of
      // that expression: it strips them.
      'no-control-regex': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
)
