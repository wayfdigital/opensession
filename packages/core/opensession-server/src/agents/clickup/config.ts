import { z } from "zod";

const settings = z.object({
  token: z.string().trim().min(1, "CLICKUP_API_TOKEN is required"),
  workspaceId: z
    .string()
    .trim()
    .regex(/^\d+$/, "CLICKUP_WORKSPACE_ID must be numeric"),
  listIds: z.array(z.string().regex(/^\d+$/)),
  pollMs: z.coerce
    .number()
    .int()
    .min(10)
    .max(3600)
    .transform((seconds) => seconds * 1000),
  readyStatus: z.string().min(1),
  workingStatus: z.string().min(1),
});

export type ClickUpSettings = z.infer<typeof settings>;

export function clickUpSettings(): ClickUpSettings {
  const result = settings.safeParse({
    token: process.env.CLICKUP_API_TOKEN ?? "",
    workspaceId: process.env.CLICKUP_WORKSPACE_ID ?? "",
    listIds: (process.env.CLICKUP_LIST_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
    pollMs: process.env.CLICKUP_POLL_SECONDS || "30",
    readyStatus: process.env.CLICKUP_READY_STATUS || "ready",
    workingStatus: process.env.CLICKUP_WORKING_STATUS || "in progress",
  });
  if (!result.success)
    throw new Error(
      `Invalid ClickUp configuration: ${result.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
    );
  return result.data;
}
