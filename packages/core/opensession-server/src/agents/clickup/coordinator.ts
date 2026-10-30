import type { ClickUpApi, ClickUpComment, ClickUpTask } from "./api";
import type { ClickUpSettings } from "./config";
import {
  commentCommand,
  completedOutput,
  isAssignedTask,
  type TaskAction,
} from "./prompts";
import { ClickUpStore, type TaskSession } from "./store";

export type PreparedTask = Pick<
  TaskSession,
  "sessionId" | "repoId" | "branch" | "worktreeDir"
>;
export type TaskRun = {
  session: TaskSession;
  action: TaskAction;
  message: string;
  signal: AbortSignal;
  save: () => Promise<void>;
};
export interface ClickUpRuntime {
  prepare(task: ClickUpTask): Promise<PreparedTask>;
  run(input: TaskRun): Promise<string>;
  createPr(session: TaskSession): Promise<string>;
  sessionUrl(sessionId: string): string;
}

export class ClickUpCoordinator {
  private readonly running = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  private readonly flushing = new Map<string, Promise<void>>();
  private polling: Promise<void> | null = null;
  private stopping = false;
  lastError: string | null = null;
  lastPollAt: string | null = null;

  constructor(
    private readonly api: ClickUpApi,
    readonly store: ClickUpStore,
    private readonly settings: ClickUpSettings,
    private readonly userId: number,
    private readonly runtime: ClickUpRuntime,
  ) {}

  async restore(): Promise<void> {
    await this.store.load();
    for (const session of this.store.sessions.values()) {
      if (!session.claimed) continue;
      session.claimed = false;
      session.phase = "stopped";
      this.addReply(
        session,
        "Open Session restarted during this turn. Check the session before replying with a new instruction. The interrupted instruction will not be replayed.",
      );
    }
    await this.store.save();
  }

  poll(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.polling) return this.polling;
    this.polling = this.scan()
      .catch((error) => {
        this.lastError =
          error instanceof Error ? error.message : "ClickUp polling failed";
      })
      .finally(() => {
        this.polling = null;
      });
    return this.polling;
  }

  private async scan(): Promise<void> {
    this.lastError = null;
    const tasks = await this.api.assignedTasks(
      this.settings.workspaceId,
      this.userId,
      this.settings.listIds,
    );
    if (this.stopping) return;
    const assigned = new Map(
      tasks
        .filter((task) => this.eligible(task))
        .map((task) => [task.id, task]),
    );
    for (const session of this.store.sessions.values()) {
      if (assigned.has(session.task.id) || session.phase === "suspended")
        continue;
      session.phase = "suspended";
      this.running.get(session.task.id)?.controller.abort();
    }
    await this.store.save();
    for (const task of assigned.values()) {
      if (this.stopping) return;
      try {
        await this.processTask(task);
      } catch (error) {
        this.lastError =
          error instanceof Error
            ? error.message
            : "ClickUp task processing failed";
      }
    }
    this.lastPollAt = new Date().toISOString();
  }

  private eligible(task: ClickUpTask): boolean {
    return isAssignedTask(
      task,
      this.settings.workspaceId,
      this.userId,
      this.settings.listIds,
    );
  }

  private addReply(session: TaskSession, text: string): void {
    const content =
      text.trim() ||
      "The turn finished without a text response. Check the session for details.";
    for (let start = 0; start < content.length; start += 8_000) {
      session.outbox.push({
        id: crypto.randomUUID(),
        text: content.slice(start, start + 8_000),
      });
    }
  }

  private async reply(session: TaskSession, text: string): Promise<void> {
    this.addReply(session, text);
    await this.store.save();
    await this.flush(session);
  }

  private flush(session: TaskSession): Promise<void> {
    const existing = this.flushing.get(session.task.id);
    if (existing) return existing;
    const work = this.deliver(session).finally(() => {
      this.flushing.delete(session.task.id);
    });
    this.flushing.set(session.task.id, work);
    return work;
  }

  private async deliver(session: TaskSession): Promise<void> {
    if (!session.outbox.length || this.stopping) return;
    const comments = await this.api.comments(session.task.id);
    while (session.outbox.length && !this.stopping) {
      const item = session.outbox[0];
      if (!item) break;
      const marker = `[Open Session ${item.id}]`;
      if (
        !comments.some(
          (comment) =>
            comment.user.id === this.userId &&
            comment.comment_text.includes(marker),
        )
      ) {
        await this.api.comment(session.task.id, `${item.text}\n\n${marker}`);
      }
      session.outbox.shift();
      await this.store.save();
    }
  }

  private async processTask(task: ClickUpTask): Promise<void> {
    let session = this.store.sessions.get(task.id);
    if (!session) {
      const startedAt = Date.now();
      const comments = await this.api.comments(task.id);
      const prepared = await this.runtime.prepare(task);
      session = {
        ...prepared,
        task,
        engineSessionId: "",
        phase: "awaiting_direction",
        startedAt,
        seenComments: comments.map((comment) => comment.id),
        plan: "",
        claimed: false,
        outbox: [],
      };
      this.store.sessions.set(task.id, session);
      const existingPlan = comments
        .filter((comment) =>
          /^#{1,2} Implementation Plan\b/m.test(comment.comment_text),
        )
        .at(-1);
      if (existingPlan) session.plan = existingPlan.comment_text;
      this.addReply(
        session,
        `Ready to work on ${task.custom_id || task.id}: ${task.name}\n\n${this.runtime.sessionUrl(session.sessionId)}\n\nReply with plan, implement, or an instruction. Reply stop to cancel a running turn. Remove my assignment or close the task to pause it.`,
      );
      await this.store.save();
      await this.flush(session);
      return;
    }
    const working = this.settings.workingStatus.toLowerCase();
    if (task.status.status.toLowerCase() !== working) {
      session.implementationRequested = false;
    } else if (
      session.phase === "awaiting_implementation" &&
      session.task.status.status.toLowerCase() !== working
    ) {
      session.implementationRequested = true;
    }
    session.task = task;
    if (session.phase === "suspended") {
      session.phase = "stopped";
      session.implementationRequested = false;
      const comments = await this.api.comments(task.id);
      session.seenComments = [
        ...new Set([
          ...session.seenComments,
          ...comments.map((comment) => comment.id),
        ]),
      ];
      await this.reply(
        session,
        "Assigned again. The existing worktree is ready. Reply with an instruction to continue.",
      );
      return;
    }
    await this.flush(session);
    const comments = (
      await this.api.comments(task.id, session.startedAt)
    ).filter(
      (comment) =>
        comment.user.id !== this.userId &&
        !session.seenComments.includes(comment.id),
    );
    const stop = comments.findLast((comment) =>
      ["stop", "cancel"].includes(commentCommand(comment.comment_text)),
    );
    if (stop) {
      // A stop supersedes older queued instructions, including during a run.
      for (const comment of comments) {
        session.seenComments.push(comment.id);
        if (comment.id === stop.id) break;
      }
      session.phase = "stopped";
      this.running.get(task.id)?.controller.abort();
      await this.reply(
        session,
        "Stopped. Reply with a new instruction to continue.",
      );
      return;
    }
    if (this.running.has(task.id) || this.running.size >= 2) {
      await this.store.save();
      return;
    }
    const next = comments[0];
    if (next) {
      await this.dispatch(session, next);
    } else if (
      session.phase === "awaiting_implementation" &&
      session.plan &&
      session.implementationRequested &&
      task.status.status.toLowerCase() ===
        this.settings.workingStatus.toLowerCase()
    ) {
      await this.launch(
        session,
        "implement",
        "The task moved to the implementation status.",
      );
    }
    await this.store.save();
  }

  private async dispatch(
    session: TaskSession,
    comment: ClickUpComment,
  ): Promise<void> {
    const command = commentCommand(comment.comment_text);
    const action: TaskAction =
      command === "plan"
        ? "plan"
        : command === "implement" ||
            (session.phase === "awaiting_implementation" &&
              ["yes", "go", "proceed"].includes(command))
          ? "implement"
          : "message";
    // Refresh assignment at the execution boundary, not only at scan time.
    const fresh = await this.api.task(session.task.id);
    if (!this.eligible(fresh)) return;
    session.task = fresh;
    session.seenComments.push(comment.id);
    await this.launch(session, action, comment.comment_text);
  }

  private async launch(
    session: TaskSession,
    action: TaskAction,
    message: string,
  ): Promise<void> {
    if (this.stopping || this.running.has(session.task.id)) return;
    const fresh = await this.api.task(session.task.id);
    if (!this.eligible(fresh)) return;
    session.task = fresh;
    const planning =
      action === "plan" ||
      (action === "message" &&
        ["planning", "awaiting_implementation"].includes(session.phase));
    session.phase = planning ? "planning" : "working";
    session.implementationRequested = false;
    session.claimed = true;
    await this.store.save();
    const controller = new AbortController();
    // Defer execution until the running entry exists, even with a synchronous fixture.
    const promise = Promise.resolve()
      .then(() => this.execute(session, action, message, controller.signal))
      .finally(() => {
        this.running.delete(session.task.id);
      });
    this.running.set(session.task.id, { controller, promise });
  }

  private async execute(
    session: TaskSession,
    action: TaskAction,
    message: string,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      if (action === "implement")
        await this.moveStatus(session, this.settings.workingStatus);
      if (signal.aborted) return;
      const result = await this.runtime.run({
        session,
        action,
        message,
        signal,
        save: () => this.store.save(),
      });
      if (signal.aborted) return;
      const plan = completedOutput(result, "PLANNING_COMPLETE");
      const implemented = completedOutput(result, "IMPLEMENTATION_COMPLETE");
      if (session.phase === "planning" && plan !== null) {
        session.plan = plan;
        session.phase = "awaiting_implementation";
        await this.reply(
          session,
          `# Implementation Plan\n\n${plan}\n\nReply implement to start coding.`,
        );
        await this.moveStatus(session, this.settings.readyStatus);
      } else if (session.phase !== "planning" && implemented !== null) {
        const fresh = await this.api.task(session.task.id);
        if (signal.aborted || !this.eligible(fresh)) return;
        const pr = await this.runtime.createPr(session);
        session.phase = "idle";
        await this.reply(
          session,
          `${implemented ? implemented + "\n\n" : ""}Implementation complete.\n${pr}`,
        );
      } else {
        if (session.phase !== "planning") session.phase = "idle";
        await this.reply(session, result);
      }
    } catch (error) {
      if (!signal.aborted) {
        session.phase = "stopped";
        this.lastError =
          error instanceof Error ? error.message : "ClickUp turn failed";
        this.addReply(
          session,
          `The turn could not finish. ${this.lastError}\nCheck ${this.runtime.sessionUrl(session.sessionId)} and reply with a new instruction to retry.`,
        );
      }
    } finally {
      session.claimed = false;
      await this.store.save();
    }
  }

  private async moveStatus(
    session: TaskSession,
    status: string,
  ): Promise<void> {
    if (await this.api.setStatus(session.task, status)) {
      session.task.status.status = status;
      await this.store.save();
    } else {
      await this.reply(
        session,
        `This List has no "${status}" status. Continuing without changing the status.`,
      );
    }
  }

  async settle(): Promise<void> {
    await Promise.all([...this.running.values()].map((run) => run.promise));
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const run of this.running.values()) run.controller.abort();
    await this.polling;
    await this.settle();
    await this.store.save();
  }

  health() {
    return {
      status: this.lastError ? "degraded" : "operational",
      lastError: this.lastError,
      lastPollAt: this.lastPollAt,
      activeRuns: this.running.size,
      trackedTasks: this.store.sessions.size,
      pendingReplies: [...this.store.sessions.values()].reduce(
        (sum, session) => sum + session.outbox.length,
        0,
      ),
    };
  }
}
