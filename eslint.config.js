import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      ".wrangler/**",
      "worker-configuration.d.ts",
      "package-lock.json",
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // The codebase uses explicit `undefined` checks against
      // noUncheckedIndexedAccess results; eqeqeq keeps comparisons honest.
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-console": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Tests and the demo script assert over untyped JSON wire responses;
    // casting through `any` at the boundary is intentional there.
    files: ["test/**", "scripts/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
