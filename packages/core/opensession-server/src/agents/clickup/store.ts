import { readFile } from "fs/promises";
import { z } from "zod";
import { writeJsonAtomicAsync } from "../../server/shared/atomic-write";
import { clickUpTask } from "./api";

export const taskSession = z.object({
  task: clickUpTask,
  sessionId: z.string(),
  repoId: z.string(),
  branch: z.string(),
  worktreeDir: z.string(),
  engineSessionId: z.string().default(""),
  phase: z.enum([
    "awaiting_direction",
    "planning",
    "awaiting_implementation",
    "working",
    "idle",
    "stopped",
    "suspended",
  ]),
  startedAt: z.number(),
  seenComments: z.array(z.string()),
  plan: z.string().default(""),
  claimed: z.boolean().default(false),
  implementationRequested: z.boolean().optional(),
  outbox: z.array(z.object({ id: z.string(), text: z.string() })).default([]),
});
export type TaskSession = z.infer<typeof taskSession>;
const state = z.object({
  version: z.literal(1),
  userId: z.number(),
  workspaceId: z.string(),
  sessions: z.array(taskSession),
});

export class ClickUpStore {
  readonly sessions = new Map<string, TaskSession>();
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly userId: number,
    private readonly workspaceId: string,
  ) {}

  async load(): Promise<void> {
    let content: string;
    try {
      content = await readFile(this.path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return;
      throw error;
    }
    const saved = state.parse(JSON.parse(content));
    if (saved.userId !== this.userId || saved.workspaceId !== this.workspaceId)
      throw new Error(
        "ClickUp account or Workspace changed. Use a separate instance state directory.",
      );
    for (const session of saved.sessions)
      this.sessions.set(session.task.id, session);
  }

  save(): Promise<void> {
    const snapshot = state.parse({
      version: 1,
      userId: this.userId,
      workspaceId: this.workspaceId,
      sessions: [...this.sessions.values()],
    });
    const write = this.writes.then(() =>
      writeJsonAtomicAsync(this.path, snapshot, true, 0o600),
    );
    this.writes = write.catch(() => {});
    return write;
  }
}
