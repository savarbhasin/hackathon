import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
const profileId = v.id("agentProfiles");
function cap(value: number | undefined, fallback = 100, maximum = 500): number { return Math.max(1, Math.min(maximum, value ?? fallback)); }
function slugify(value: string): string { return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }
function invalidSlug(slug: string): boolean { return !slug || slug.length > 80 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug); }

export const list = query({
  args: { enabledOnly: v.optional(v.boolean()), limit: v.optional(v.number()) },
  returns: v.any(),
  handler: async (ctx, args) => {
    const limit = cap(args.limit);
    if (args.enabledOnly) {
      return await ctx.db.query("agentProfiles")
        .withIndex("by_enabled", (q: any) => q.eq("enabled", true))
        .order("asc")
        .take(limit);
    }
    return await ctx.db.query("agentProfiles").order("asc").take(limit);
  },
});
export const get = query({ args: { profileId }, returns: v.any(), handler: async (ctx, args) => await ctx.db.get(args.profileId) });
export const getBySlug = query({ args: { slug: v.string() }, returns: v.any(), handler: async (ctx, args) => await ctx.db.query("agentProfiles").withIndex("by_slug", (q: any) => q.eq("slug", slugify(args.slug))).first() });

const profileInput = { slug: v.string(), name: v.string(), role: v.optional(v.string()), description: v.optional(v.string()), instructions: v.optional(v.string()), isDefault: v.optional(v.boolean()), enabled: v.optional(v.boolean()) };

async function defaultProfile(ctx: any, excluding?: any) {
  return (await ctx.db.query("agentProfiles").collect()).find((profile: any) => profile.isDefault && profile._id !== excluding);
}

export const create = mutation({
  args: { operationKey: v.optional(v.string()), ...profileInput }, returns: v.any(),
  handler: async (ctx, args) => {
    const slug = slugify(args.slug); if (invalidSlug(slug)) return { kind: "conflict", reason: "invalid_slug" };
    if (!args.name.trim()) return { kind: "conflict", reason: "empty_name" };
    const existingSlug = await ctx.db.query("agentProfiles").withIndex("by_slug", (q: any) => q.eq("slug", slug)).first();
    if (existingSlug) return existingSlug;
    if (args.operationKey) { const existing = await ctx.db.query("agentProfiles").withIndex("by_operationKey", (q: any) => q.eq("operationKey", args.operationKey)).first(); if (existing) return existing; }
    if (args.isDefault && await defaultProfile(ctx)) return { kind: "conflict", reason: "default_profile_exists" };
    const now = Date.now(); const id = await ctx.db.insert("agentProfiles", { slug, name: args.name.trim(), role: args.role?.trim(), description: args.description ?? "", instructions: args.instructions ?? "", isDefault: args.isDefault ?? false, enabled: args.enabled ?? true, ...(args.operationKey ? { operationKey: args.operationKey } : {}), createdAt: now, updatedAt: now });
    return await ctx.db.get(id);
  },
});

export const update = mutation({
  args: { profileId, slug: v.optional(v.string()), name: v.optional(v.string()), role: v.optional(v.string()), description: v.optional(v.string()), instructions: v.optional(v.string()), isDefault: v.optional(v.boolean()), enabled: v.optional(v.boolean()) }, returns: v.any(),
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.profileId); if (!existing) return { kind: "not_found", entity: "agent_profile" };
    const slug = args.slug === undefined ? existing.slug : slugify(args.slug); if (invalidSlug(slug)) return { kind: "conflict", reason: "invalid_slug" };
    const sameSlug = await ctx.db.query("agentProfiles").withIndex("by_slug", (q: any) => q.eq("slug", slug)).first(); if (sameSlug && sameSlug._id !== args.profileId) return { kind: "conflict", reason: "slug_taken" };
    if (args.isDefault === true && !existing.isDefault && await defaultProfile(ctx, args.profileId)) return { kind: "conflict", reason: "default_profile_exists" };
    const patch: any = { updatedAt: Date.now(), slug };
    if (args.name !== undefined) { if (!args.name.trim()) return { kind: "conflict", reason: "empty_name" }; patch.name = args.name.trim(); }
    for (const key of ["role", "description", "instructions", "isDefault", "enabled"] as const) if (args[key] !== undefined) patch[key] = key === "role" ? args[key]?.trim() : args[key];
    await ctx.db.patch(args.profileId, patch); return await ctx.db.get(args.profileId);
  },
});

export const upsert = mutation({
  args: { operationKey: v.optional(v.string()), ...profileInput }, returns: v.any(),
  handler: async (ctx, args) => {
    const slug = slugify(args.slug); if (invalidSlug(slug)) return { kind: "conflict", reason: "invalid_slug" };
    if (args.operationKey) {
      const byOperation = await ctx.db.query("agentProfiles").withIndex("by_operationKey", (q: any) => q.eq("operationKey", args.operationKey)).first();
      if (byOperation && byOperation.slug !== slug) return { kind: "conflict", reason: "operation_key_owned_by_other_profile" };
    }
    const existing = await ctx.db.query("agentProfiles").withIndex("by_slug", (q: any) => q.eq("slug", slug)).first();
    if (existing) {
      if (args.operationKey && existing.operationKey && existing.operationKey !== args.operationKey) return { kind: "conflict", reason: "operation_key_mismatch" };
      if (args.isDefault === true && !existing.isDefault && await defaultProfile(ctx, existing._id)) return { kind: "conflict", reason: "default_profile_exists" };
      await ctx.db.patch(existing._id, { name: args.name.trim(), ...(args.role !== undefined ? { role: args.role?.trim() } : {}), ...(args.description !== undefined ? { description: args.description } : {}), ...(args.instructions !== undefined ? { instructions: args.instructions } : {}), ...(args.isDefault !== undefined ? { isDefault: args.isDefault } : {}), ...(args.enabled !== undefined ? { enabled: args.enabled } : {}), updatedAt: Date.now() });
      return await ctx.db.get(existing._id);
    }
    if (!args.name.trim()) return { kind: "conflict", reason: "empty_name" };
    if (args.isDefault && await defaultProfile(ctx)) return { kind: "conflict", reason: "default_profile_exists" };
    const now = Date.now();
    const id = await ctx.db.insert("agentProfiles", { slug, name: args.name.trim(), role: args.role?.trim(), description: args.description ?? "", instructions: args.instructions ?? "", isDefault: args.isDefault ?? false, enabled: args.enabled ?? true, ...(args.operationKey ? { operationKey: args.operationKey } : {}), createdAt: now, updatedAt: now });
    return await ctx.db.get(id);
  },
});

export const remove = mutation({ args: { profileId }, returns: v.any(), handler: async (ctx, args) => { const profile = await ctx.db.get(args.profileId); if (!profile) return { kind: "not_found" }; await ctx.db.delete(args.profileId); return { kind: "deleted" }; } });
