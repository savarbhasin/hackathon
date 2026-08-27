import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { convexUrl } from "./queue/env";

let client: ConvexHttpClient | undefined;

export function convexDocumentsClient(): ConvexHttpClient {
  return client ??= new ConvexHttpClient(convexUrl(), { logger: false });
}

export const convexDocumentsApi = api.documents;

export function convexDocumentId(id: string) {
  return id as never;
}

export function serializeConvexDocument(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row._id !== "string") return null;
  return { ...row, id: row._id };
}

export function convexMutationError(value: unknown): Response | null {
  if (!value || typeof value !== "object") return Response.json({ error: "invalid_response" }, { status: 502 });
  const row = value as Record<string, unknown>;
  if (row.kind !== "conflict" && row.kind !== "not_found" && row.reason === undefined && row.entity === undefined) return null;
  const reason = typeof row.reason === "string" ? row.reason : typeof row.entity === "string" ? row.entity : row.kind;
  return Response.json({ error: reason }, { status: row.kind === "not_found" ? 404 : 409 });
}
