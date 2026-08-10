import { defineConfig } from "prisma/config";

// Prisma 7 no longer reads .env implicitly, so load it before the config is
// evaluated. Node 20+ supports this natively.
process.loadEnvFile?.(".env");

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
