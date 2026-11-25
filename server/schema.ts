import { z } from "zod";
import { groupTypes } from "../shared/types.js";

const raw = z.record(z.string(), z.unknown());
const ref = z.string().min(1).max(300);
const name = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((value) => !/[\r\n,]/.test(value), "名称不能包含换行或逗号");
export const workspaceSchema = z.object({
  name,
  base: raw,
  sources: z
    .array(
      z.object({
        id: ref,
        name,
        url: z.string().max(8192).optional(),
        provider: z.string().max(300).optional(),
        override: raw.optional(),
        filter: z
          .object({
            include: z.string().max(1000).optional(),
            exclude: z.string().max(1000).optional(),
            types: z.array(z.string()).optional(),
          })
          .optional(),
        headers: z.record(z.string(), z.string()).optional(),
        refreshedAt: z.string(),
        error: z.string().optional(),
        warnings: z.array(z.string()),
      }),
    )
    .max(100),
  nodes: z
    .array(
      z.object({
        id: ref,
        sourceId: ref,
        name,
        originalName: z.string().max(500),
        raw,
        dialer: ref.optional(),
      }),
    )
    .max(10000),
  groups: z
    .array(
      z.object({
        id: ref,
        name,
        type: z.enum(groupTypes),
        members: z.array(ref).max(10000),
        match: z
          .object({
            sourceId: z.string(),
            contains: z.string().max(500),
            sourceIds: z.array(z.string()).optional(),
            regex: z.string().max(1000).optional(),
            excludeRegex: z.string().max(1000).optional(),
            excludeTypes: z.array(z.string()).optional(),
          })
          .optional(),
        excluded: z.array(ref),
        extra: raw,
      }),
    )
    .max(300),
  chains: z
    .array(z.object({ id: ref, name, hops: z.array(ref).max(12) }))
    .max(300),
  rules: z
    .array(
      z.object({
        id: ref,
        text: z.string().min(1).max(4000),
        enabled: z.boolean(),
      }),
    )
    .max(20000),
});

export const proposalSchema = z.object({
  summary: z.string().max(3000),
  rules: z.array(z.string().min(1).max(4000)).max(5000),
  groups: z
    .array(
      z.object({
        name,
        type: z.enum(groupTypes),
        members: z.array(z.string().max(120)).max(300),
      }),
    )
    .max(100)
    .default([]),
});
