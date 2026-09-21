import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

const noBuiltSql = [
  "error",
  {
    selector: "CallExpression[callee.property.name='query'] > TemplateLiteral[expressions.length>0]",
    message: "Build SQL with parameters ($1, $2…), never template literals (report §12.3).",
  },
  {
    selector: "CallExpression[callee.property.name='query'] > BinaryExpression",
    message: "Build SQL with parameters ($1, $2…), never string concatenation (report §12.3).",
  },
];

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/.next/**", "**/node_modules/**", "coverage/**", "docs/design/prototypes/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.node } } },
  { files: ["**/*.{ts,tsx,js,mjs}"], rules: { "no-restricted-syntax": noBuiltSql } },
  // The migrations package is the one place allowed to run identifier-built SQL (report §12.3).
  { files: ["packages/db/**"], rules: { "no-restricted-syntax": "off" } },
);
