import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  sharkState: defineTable({
    key: v.string(),
    payload: v.string(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),
});
