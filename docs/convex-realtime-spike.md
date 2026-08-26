# Convex realtime spike

The isolated harness is available at `/spikes/convex-realtime`. It uses a Convex query subscription (`useQuery`) and mutation (`useMutation`) and does not use `/api/stream` or a polling timer.

## Local setup

1. Copy `.env.example` values into `.env.local` (the URLs are public deployment identifiers, not secrets).
2. Configure the Convex deployment and generate typed bindings with `npx convex dev` (or run `npx convex dev --once` with `CONVEX_DEPLOYMENT` configured).
3. Start Next with `npm run dev`.

The checked-in `_generated` bindings are an untyped harness fallback so the application can build before Convex credentials/codegen are available. A configured deployment should regenerate them.

## Two-browser verification

1. Open `http://localhost:3000/spikes/convex-realtime` in two browser windows.
2. Confirm both show the same initial status after the subscription connects.
3. Click a status button in window A.
4. Confirm window B updates without refreshing; each browser records its own observation time and displays approximate write-to-observation latency (local epoch time minus the Convex mutation write time).
5. Repeat in the opposite direction and compare each browser’s independently observed latency.

The supplied hosted endpoints are `https://adamant-badger-403.convex.cloud` and `https://adamant-badger-403.convex.site`. Live verification may remain blocked until the Convex deployment is configured and functions are pushed.
