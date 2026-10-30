import { z } from "zod";
import {
  ClickUpApi,
  type ClickUpComment,
  type ClickUpTask,
  newClickUpTask,
} from "./api";

export function exampleTask(id = "task1"): ClickUpTask {
  return {
    id,
    name: "Fix upload retry",
    url: `https://app.clickup.com/t/${id}`,
    team_id: "123",
    list: { id: "456" },
    status: { status: "to do", type: "open" },
    assignees: [{ id: 10, username: "AI" }],
    date_updated: String(Date.now()),
    description: "Handle the final retry correctly.",
  };
}

export function clickUpFixture() {
  const tasks = new Map<string, ClickUpTask>([["task1", exampleTask()]]);
  const comments = new Map<string, ClickUpComment[]>();
  const replies = new Map<string, ClickUpComment[]>();
  const requests: Array<{ method: string; path: string; query: string }> = [];
  const created: ClickUpTask[] = [];
  let sequence = 0;
  const controls = {
    failScan: false,
    failReplyAfterAccept: false,
    statuses: ["ready", "in progress"],
    statusWrites: [] as string[],
  };
  function addComment(
    text: string,
    userId = 20,
    taskId = "task1",
    date = Date.now() + ++sequence,
  ) {
    const comment: ClickUpComment = {
      id: String(++sequence),
      date: String(date),
      comment_text: text,
      user: { id: userId },
    };
    comments.set(taskId, [...(comments.get(taskId) || []), comment]);
    return comment;
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname.replace("/api/v2/", "");
      requests.push({ method: request.method, path, query: url.search });
      if (request.headers.get("authorization") !== "fixture-token")
        return new Response(null, { status: 401 });
      if (path === "user")
        return Response.json({ user: { id: 10, username: "AI" } });
      if (path === "team")
        return Response.json({
          teams: [{ id: "123", name: "Fixture workspace" }],
        });
      const thread = path.match(/^comment\/([^/]+)\/reply$/);
      if (thread)
        return Response.json({ comments: replies.get(thread[1]!) ?? [] });
      if (path === "team/123/task") {
        if (controls.failScan) return new Response(null, { status: 503 });
        const page = Number(url.searchParams.get("page"));
        const assigned = [...tasks.values()].filter(
          (task) =>
            task.assignees.some((user) => user.id === 10) &&
            !["closed", "done"].includes(task.status.type),
        );
        return Response.json({
          tasks: assigned.slice(page * 100, page * 100 + 100),
          last_page: (page + 1) * 100 >= assigned.length,
        });
      }
      const match = path.match(/^task\/([^/]+)(\/comment)?$/);
      if (match) {
        const id = match[1]!;
        const task = tasks.get(id);
        if (!task) return new Response(null, { status: 404 });
        if (!match[2]) {
          if (request.method === "PUT") {
            const { status } = z
              .object({ status: z.string() })
              .parse(await request.json());
            task.status.status = status;
            controls.statusWrites.push(status);
          }
          return Response.json(task);
        }
        if (request.method === "POST") {
          const { comment_text } = z
            .object({ comment_text: z.string(), notify_all: z.literal(false) })
            .parse(await request.json());
          const comment = addComment(comment_text, 10, id);
          if (controls.failReplyAfterAccept) {
            controls.failReplyAfterAccept = false;
            return new Response("Response lost", { status: 503 });
          }
          return Response.json({ id: comment.id });
        }
        const all = [...(comments.get(id) || [])].reverse();
        const cursorId = url.searchParams.get("start_id");
        const start = cursorId
          ? all.findIndex((comment) => comment.id === cursorId) + 1
          : 0;
        return Response.json({ comments: all.slice(start, start + 25) });
      }
      if (path === "list/456")
        return Response.json({
          statuses: controls.statuses.map((status) => ({ status })),
        });
      if (path === "list/456/task" && request.method === "POST") {
        const input = newClickUpTask.parse(await request.json());
        const task = {
          ...exampleTask(`followup${++sequence}`),
          ...input,
          assignees: (input.assignees || []).map((id) => ({ id })),
        };
        tasks.set(task.id, task);
        created.push(task);
        return Response.json(task);
      }
      return new Response(null, { status: 404 });
    },
  });
  const api = new ClickUpApi({
    token: "fixture-token",
    intervalMs: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      return fetch(
        new Request(
          `${server.url.origin}${url.pathname}${url.search}`,
          request,
        ),
      );
    },
  });
  return {
    api,
    server,
    tasks,
    comments,
    replies,
    requests,
    created,
    controls,
    addComment,
  };
}
