"use client";

import { ConvexProvider, ConvexReactClient } from "convex/react";
import type { ReactNode } from "react";

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;

if (!convexUrl) {
  throw new Error(
    "Missing required configuration: NEXT_PUBLIC_CONVEX_URL must be set for the Convex client.",
  );
}

// Keep one client for the lifetime of the application rather than creating it
// during provider renders. The root layout mounts this provider once.
const convexClient = new ConvexReactClient(convexUrl);

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  return <ConvexProvider client={convexClient}>{children}</ConvexProvider>;
}
