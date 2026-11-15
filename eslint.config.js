import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules", "**/dist", "**/out", "**/coverage"] },
  ...tseslint.configs.recommended,
  {
    files: ["packages/ui/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: { "react-hooks/rules-of-hooks": "error", "react-hooks/exhaustive-deps": "error" },
  },
  {
    rules: {
      // shadcn add genera `from "cn"` (paquete npm); aquí cn vive en packages/ui/src/lib/utils.ts
      "no-restricted-imports": [
        "error",
        { paths: [{ name: "cn", message: 'Importa cn desde "@/lib/utils".' }] },
      ],
    },
  },
);
