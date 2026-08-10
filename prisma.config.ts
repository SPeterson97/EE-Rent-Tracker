import { defineConfig } from "prisma/config";

// Prisma 7 no longer reads .env implicitly, so load it before the config is
// evaluated. Node 20+ supports this natively.
//
// ENV_FILE selects a target: ENV_FILE=.env.neon npm run db:verify
// Variables already present in the environment are NOT overwritten, so
// `DATABASE_URL=... npx prisma migrate deploy` still wins over the file.
try {
  process.loadEnvFile?.(process.env.ENV_FILE ?? ".env");
} catch {
  // No env file present — rely on the ambient environment (CI, containers).
}

export default defineConfig({
  schema: "prisma/schema.prisma",

  datasource: {
    url: process.env.DATABASE_URL,

    // Prisma needs a scratch database to detect drift when generating
    // migrations. A local Postgres can create one automatically; hosted
    // providers generally require provisioning it yourself.
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },

  migrations: {
    path: "prisma/migrations",
  },
});
