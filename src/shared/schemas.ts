import { z } from "zod";

export const BrowserIdSchema = z.object({
  browser_id: z.string().optional(),
});

export const BrowserTurnSchema = BrowserIdSchema.extend({
  session_id: z.string(),
  turn_id: z.string(),
});

export const TabIdSchema = BrowserTurnSchema.extend({
  tabId: z.number().int(),
});

export const TargetIdSchema = TabIdSchema.extend({
  targetId: z.string(),
});

export const CdpCommandSchema = BrowserTurnSchema.extend({
  target: z
    .object({
      tabId: z.number().int().optional(),
      targetId: z.string().optional(),
      extensionId: z.string().optional(),
    })
    .passthrough(),
  method: z.string(),
  commandParams: z.record(z.unknown()).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export const UserHistoryQuerySchema = BrowserTurnSchema.extend({
  query: z.string().optional(),
  limit: z.number().int().positive().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export const FinalizeTabStatusSchema = z.enum(["handoff", "deliverable"]);

export const FinalizeTabEntrySchema = z.object({
  tabId: z.number().int(),
  status: FinalizeTabStatusSchema,
});

export const FinalizeTabsSchema = BrowserTurnSchema.extend({
  keep: z.array(FinalizeTabEntrySchema),
});

export const NameSessionSchema = BrowserTurnSchema.extend({
  name: z.string(),
});

export const MoveMouseSchema = BrowserTurnSchema.extend({
  tabId: z.number().int(),
  x: z.number().finite(),
  y: z.number().finite(),
  waitForArrival: z.boolean().optional(),
});

export const DownloadChangeEventSchema = z.object({
  id: z.string(),
  filename: z.string(),
  url: z.string().optional(),
  status: z.enum(["started", "in_progress", "complete", "canceled", "failed"]),
});

export const AgentCursorStateSchema = z.object({
  cursor: z
    .object({
      visible: z.boolean(),
      x: z.number().finite(),
      y: z.number().finite(),
      animateMovement: z.boolean().optional(),
      moveSequence: z.number().int().optional(),
    })
    .nullable(),
  isVisible: z.boolean(),
  sessionId: z.string().nullable(),
  turnId: z.string().nullable(),
});

export type BrowserTurnInput = z.infer<typeof BrowserTurnSchema>;
export type CdpCommandInput = z.infer<typeof CdpCommandSchema>;
export type UserHistoryQueryInput = z.infer<typeof UserHistoryQuerySchema>;
export type FinalizeTabsInput = z.infer<typeof FinalizeTabsSchema>;
export type MoveMouseInput = z.infer<typeof MoveMouseSchema>;
