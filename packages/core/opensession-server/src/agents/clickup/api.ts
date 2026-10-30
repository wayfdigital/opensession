import { z } from "zod";

export const clickUpId = z
  .union([z.string().min(1), z.number().int()])
  .transform(String);
export const clickUpUser = z.object({
  id: z.number().int(),
  username: z.string().nullish(),
});
export const clickUpTask = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  custom_id: z.string().nullish(),
  name: z.string(),
  description: z.string().nullish(),
  markdown_description: z.string().nullish(),
  url: z.string().url(),
  team_id: clickUpId,
  list: z.object({ id: clickUpId }),
  status: z.object({ status: z.string(), type: z.string() }),
  assignees: z.array(clickUpUser),
  date_updated: z.string(),
  archived: z.boolean().optional(),
});
export const clickUpComment = z.object({
  id: clickUpId,
  date: z.string(),
  comment_text: z.string(),
  user: clickUpUser,
  reply_count: z.coerce.number().int().nonnegative().optional(),
});
export type ClickUpTask = z.infer<typeof clickUpTask>;
export type ClickUpComment = z.infer<typeof clickUpComment>;
export type ClickUpUser = z.infer<typeof clickUpUser>;
export const newClickUpTask = z.object({
  name: z.string().trim().min(1).max(500),
  markdown_content: z.string().max(50_000).optional(),
  assignees: z.array(z.number().int()).optional(),
  priority: z.number().int().min(1).max(4).optional(),
  due_date: z.number().int().optional(),
  start_date: z.number().int().optional(),
  parent: z.string().optional(),
});

export class ClickUpApiError extends Error {
  constructor(readonly status: number) {
    super(`ClickUp API returned HTTP ${status}`);
  }
}

type HttpFetch = (request: Request) => Promise<Response>;
type ClickUpApiOptions = {
  token: string;
  fetch?: HttpFetch;
  intervalMs?: number;
};

export class ClickUpApi {
  private nextRequestAt = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly send: HttpFetch;
  private readonly intervalMs: number;

  constructor(private readonly options: ClickUpApiOptions) {
    this.send = options.fetch ?? ((request) => fetch(request));
    this.intervalMs = options.intervalMs ?? 750;
  }

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    init?: RequestInit,
  ): Promise<T> {
    const turn = this.queue.then(async () => {
      const wait = this.nextRequestAt - Date.now();
      if (wait > 0) await Bun.sleep(wait);
      this.nextRequestAt = Date.now() + this.intervalMs;
    });
    this.queue = turn.catch(() => {});
    await turn;
    const response = await this.send(
      new Request(`https://api.clickup.com/api/v2/${path}`, {
        ...init,
        headers: {
          Authorization: this.options.token,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(20_000),
        redirect: "error",
      }),
    );
    if (response.status === 429) {
      const reset = Number(response.headers.get("X-RateLimit-Reset")) * 1000;
      this.nextRequestAt = Math.max(
        this.nextRequestAt,
        Date.now() + 60_000,
        Number.isFinite(reset) ? Math.min(reset, Date.now() + 300_000) : 0,
      );
    }
    if (!response.ok) throw new ClickUpApiError(response.status);
    const result = schema.safeParse(await response.json());
    if (!result.success)
      throw new Error("ClickUp returned an invalid response");
    return result.data;
  }

  async user(): Promise<ClickUpUser> {
    return (await this.request("user", z.object({ user: clickUpUser }))).user;
  }

  async workspaces() {
    return (
      await this.request(
        "team",
        z.object({
          teams: z.array(z.object({ id: clickUpId, name: z.string() })),
        }),
      )
    ).teams;
  }

  async assignedTasks(
    workspaceId: string,
    userId: number,
    listIds: string[],
  ): Promise<ClickUpTask[]> {
    const tasks = new Map<string, ClickUpTask>();
    for (let page = 0; page < 1000; page++) {
      const query = new URLSearchParams({
        page: String(page),
        "assignees[]": String(userId),
        include_closed: "false",
        subtasks: "true",
        include_markdown_description: "true",
        order_by: "id",
      });
      for (const id of listIds) query.append("list_ids[]", id);
      const result = await this.request(
        `team/${encodeURIComponent(workspaceId)}/task?${query}`,
        z.object({
          tasks: z.array(clickUpTask),
          last_page: z.boolean().optional(),
        }),
      );
      for (const task of result.tasks) tasks.set(task.id, task);
      if (
        result.last_page === true ||
        result.tasks.length === 0 ||
        (result.last_page === undefined && result.tasks.length < 100)
      )
        return [...tasks.values()];
    }
    throw new Error(
      "ClickUp task pagination exceeded its limit; assignment scan was not applied",
    );
  }

  task(taskId: string): Promise<ClickUpTask> {
    return this.request(
      `task/${encodeURIComponent(taskId)}?include_markdown_description=true`,
      clickUpTask,
    );
  }

  async comments(taskId: string, since = 0): Promise<ClickUpComment[]> {
    const comments = new Map<string, ClickUpComment>();
    let cursor = "";
    const cursors = new Set<string>();
    for (let page = 0; page < 1000; page++) {
      const result = await this.request(
        `task/${encodeURIComponent(taskId)}/comment${cursor}`,
        z.object({ comments: z.array(clickUpComment) }),
      );
      for (const comment of result.comments) {
        if (Number(comment.date) >= since) comments.set(comment.id, comment);
        if (comment.reply_count) {
          const replies = await this.request(
            `comment/${encodeURIComponent(comment.id)}/reply`,
            z.object({ comments: z.array(clickUpComment) }),
          );
          for (const reply of replies.comments) {
            if (Number(reply.date) >= since) comments.set(reply.id, reply);
          }
        }
      }
      const last = result.comments.at(-1);
      if (!last || result.comments.length < 25)
        return [...comments.values()].sort(
          (a, b) => Number(a.date) - Number(b.date) || a.id.localeCompare(b.id),
        );
      cursor = `?${new URLSearchParams({ start: last.date, start_id: last.id })}`;
      if (cursors.has(cursor))
        throw new Error("ClickUp comment pagination did not advance");
      cursors.add(cursor);
    }
    throw new Error("ClickUp comment pagination exceeded its limit");
  }

  async comment(taskId: string, text: string): Promise<string> {
    return (
      await this.request(
        `task/${encodeURIComponent(taskId)}/comment`,
        z.object({ id: clickUpId }),
        {
          method: "POST",
          body: JSON.stringify({ comment_text: text, notify_all: false }),
        },
      )
    ).id;
  }

  async setStatus(task: ClickUpTask, name: string): Promise<boolean> {
    const list = await this.request(
      `list/${encodeURIComponent(task.list.id)}`,
      z.object({ statuses: z.array(z.object({ status: z.string() })) }),
    );
    const status = list.statuses.find(
      (s) => s.status.toLowerCase() === name.toLowerCase(),
    );
    if (!status) return false;
    await this.request(`task/${encodeURIComponent(task.id)}`, z.object({}), {
      method: "PUT",
      body: JSON.stringify({ status: status.status }),
    });
    return true;
  }

  createTask(
    listId: string,
    input: z.infer<typeof newClickUpTask>,
  ): Promise<ClickUpTask> {
    return this.request(
      `list/${encodeURIComponent(listId)}/task`,
      clickUpTask,
      {
        method: "POST",
        body: JSON.stringify({
          ...newClickUpTask.parse(input),
          notify_all: false,
        }),
      },
    );
  }
}
