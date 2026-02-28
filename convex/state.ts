import { v } from "convex/values";

import { mutation, query } from "./_generated/server";

const STATE_KEY = "primary";

export const get = query({
  args: {},
  handler: async (ctx) => {
    const record = await ctx.db
      .query("sharkState")
      .withIndex("by_key", (q) => q.eq("key", STATE_KEY))
      .unique();

    if (!record) {
      return null;
    }

    return {
      payload: record.payload,
      updatedAt: record.updatedAt,
    };
  },
});

export const upsert = mutation({
  args: {
    payload: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("sharkState")
      .withIndex("by_key", (q) => q.eq("key", STATE_KEY))
      .unique();

    const next = {
      key: STATE_KEY,
      payload: args.payload,
      updatedAt: Date.now(),
    };

    if (existing) {
      await ctx.db.patch(existing._id, next);
      return { ok: true, updated: true };
    }

    await ctx.db.insert("sharkState", next);
    return { ok: true, updated: false };
  },
});
