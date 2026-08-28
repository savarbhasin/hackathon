/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agentProfiles from "../agentProfiles.js";
import type * as agentRuns from "../agentRuns.js";
import type * as agentStreaming from "../agentStreaming.js";
import type * as conversations from "../conversations.js";
import type * as documents from "../documents.js";
import type * as missions from "../missions.js";
import type * as schedules from "../schedules.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agentProfiles: typeof agentProfiles;
  agentRuns: typeof agentRuns;
  agentStreaming: typeof agentStreaming;
  conversations: typeof conversations;
  documents: typeof documents;
  missions: typeof missions;
  schedules: typeof schedules;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  agent: import("@convex-dev/agent/_generated/component.js").ComponentApi<"agent">;
};
