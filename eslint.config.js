import js from '@eslint/js';
import ts from 'typescript-eslint';
export default ts.config({ ignores: ['dist/**', 'node_modules/**'] }, js.configs.recommended, ...ts.configs.recommended, {
 files: ['**/*.{ts,tsx,mjs,js}'], languageOptions: { globals: { console: 'readonly', process: 'readonly', Buffer: 'readonly', setTimeout: 'readonly', URL: 'readonly' } },
 rules: { '@typescript-eslint/no-explicit-any': 'error' }
});
