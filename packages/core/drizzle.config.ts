import { defineConfig } from "drizzle-kit";

// `npm run db:generate -w @clanker/core` deja una carpeta por migración en `migrations/`,
// que el core empaqueta como recurso y aplica al bootear.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/store/schema.ts",
  out: "./migrations",
});
