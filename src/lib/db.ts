import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// Keep local development usable when `.env.local` has not been configured yet.
// Production deployments should always provide DATABASE_URL explicitly.
const databaseUrl = process.env.DATABASE_URL ?? "file:./dev.db";

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
