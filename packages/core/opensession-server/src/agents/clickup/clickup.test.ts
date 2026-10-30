import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ClickUpApi, ClickUpApiError } from "./api";
import {
  ClickUpCoordinator,
  type ClickUpRuntime,
  type TaskRun,
} from "./coordinator";
import { ClickUpStore } from "./store";
import { createClickUpTools } from "./tools";
import { clickUpFixture, exampleTask } from "./fixture";
import { isAssignedTask, completedOutput } from "./prompts";
import { runGateReason, isUnattendedKind } from "../../server/run-policy";

const disposals: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
});

const settings = {
  token: "fixture-token",
  workspaceId: "123",
  listIds: [],
  pollMs: 30_000,
  readyStatus: "ready",
  workingStatus: "in progress",
};

async function setup() {
  const fixture = clickUpFixture();
  disposals.push(() => {
    fixture.server.stop(true);
  });
  const dir = await mkdtemp(join(tmpdir(), "clickup-test-"));
  disposals.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "state.json");
  const store = new ClickUpStore(path, 10, "123");
  const runs: TaskRun[] = [];
  let run: ClickUpRuntime["run"] = async () => "A response";
  let preparations = 0;
  let prs = 0;
  const runtime: ClickUpRuntime = {
    async prepare(task) {
      preparations++;
      return {
        sessionId: `os-clickup-${task.id}`,
        repoId: "example",
        branch: `clickup-${task.id}`,
        worktreeDir: dir,
      };
    },
    async run(input) {
      runs.push(input);
      return run(input);
    },
    async createPr() {
      prs++;
      return "https://github.com/example/repo/pull/12";
    },
    sessionUrl(id) {
      return `http://localhost:3851/session/${id}`;
    },
  };
  const coordinator = new ClickUpCoordinator(
    fixture.api,
    store,
    settings,
    10,
    runtime,
  );
  await coordinator.restore();
  disposals.push(() => coordinator.shutdown());
  return {
    ...fixture,
    coordinator,
    store,
    path,
    runtime,
    runs,
    runWith(fn: ClickUpRuntime["run"]) {
      run = fn;
    },
    counts: () => ({ preparations, prs }),
  };
}

describe("ClickUp HTTP contract", () => {
  test("uses the token owner, paginates assignments, and includes subtasks and List scope", async () => {
    const f = await setup();
    for (let i = 2; i <= 101; i++)
      f.tasks.set(`task${i}`, exampleTask(`task${i}`));
    expect((await f.api.user()).id).toBe(10);
    expect(await f.api.assignedTasks("123", 10, ["456"])).toHaveLength(101);
    const queries = f.requests
      .filter((r) => r.path === "team/123/task")
      .map((r) => new URLSearchParams(r.query));
    expect(queries.map((q) => q.get("page"))).toEqual(["0", "1"]);
    expect(queries[0]?.get("assignees[]")).toBe("10");
    expect(queries[0]?.get("subtasks")).toBe("true");
    expect(queries[0]?.get("list_ids[]")).toBe("456");
  });

  test("paginates comments with date AND id and returns oldest first", async () => {
    const f = await setup();
    const ids = Array.from(
      { length: 61 },
      (_, i) => f.addComment(`comment ${i}`, 20, "task1", 1000 + i).id,
    );
    expect((await f.api.comments("task1")).map((c) => c.id)).toEqual(ids);
    const pages = f.requests.filter((r) => r.path === "task/task1/comment");
    expect(pages).toHaveLength(3);
    expect(pages[1]?.query).toContain("start=");
    expect(pages[1]?.query).toContain("start_id=");
  });

  test("rejects foreign, closed, unassigned and out-of-scope tasks", () => {
    const task = exampleTask();
    expect(isAssignedTask(task, "123", 10, [])).toBe(true);
    expect(isAssignedTask(task, "999", 10, [])).toBe(false);
    expect(isAssignedTask(task, "123", 11, [])).toBe(false);
    expect(isAssignedTask(task, "123", 10, ["999"])).toBe(false);
    expect(
      isAssignedTask(
        { ...task, status: { status: "Complete", type: "closed" } },
        "123",
        10,
        [],
      ),
    ).toBe(false);
  });

  test("errors never echo response bodies or tokens, and writes are not retried", async () => {
    let calls = 0;
    const api = new ClickUpApi({
      token: "secret-value",
      intervalMs: 0,
      fetch: async () => {
        calls++;
        return new Response("secret-value", { status: 429 });
      },
    });
    await expect(api.comment("task1", "test")).rejects.toThrow("HTTP 429");
    expect(calls).toBe(1);
    expect(new ClickUpApiError(401).message).not.toContain("secret-value");
  });
});

describe("ClickUp task lifecycle", () => {
  test("reads a new threaded reply under an old parent comment", async () => {
    const f = await setup();
    const parent = f.addComment("Earlier discussion", 20, "task1", 1);
    await f.coordinator.poll();
    parent.reply_count = 1;
    f.replies.set(parent.id, [
      {
        id: "reply1",
        date: String(Date.now() + 10),
        comment_text: "plan",
        user: { id: 20 },
      },
    ]);
    await f.coordinator.poll();
    await f.coordinator.settle();
    expect(f.runs).toHaveLength(1);
    expect(f.runs[0]?.action).toBe("plan");
  });

  test("greets once and skips old discussion and self comments across restart", async () => {
    const f = await setup();
    f.addComment("implement", 20, "task1", 1);
    await f.coordinator.poll();
    await f.coordinator.poll();
    expect(f.runs).toHaveLength(0);
    expect(f.counts().preparations).toBe(1);
    expect(
      f.comments.get("task1")?.filter((c) => c.user.id === 10),
    ).toHaveLength(1);
    const restored = new ClickUpCoordinator(
      f.api,
      new ClickUpStore(f.path, 10, "123"),
      settings,
      10,
      f.runtime,
    );
    await restored.restore();
    await restored.poll();
    expect(f.counts().preparations).toBe(1);
    expect(f.runs).toHaveLength(0);
    expect(await readFile(f.path, "utf8")).not.toContain("fixture-token");
    await restored.shutdown();
  });

  test("plans, continues the interview, implements on status change and links the PR", async () => {
    const f = await setup();
    await f.coordinator.poll();
    f.runWith(async () => "Which response should trigger retry?");
    f.addComment("plan");
    await f.coordinator.poll();
    await f.coordinator.settle();
    expect(f.store.sessions.get("task1")?.phase).toBe("planning");
    f.runWith(async () => "Retry only transient errors.\nPLANNING_COMPLETE");
    f.addComment("HTTP 503");
    await f.coordinator.poll();
    await f.coordinator.settle();
    expect(f.store.sessions.get("task1")?.phase).toBe(
      "awaiting_implementation",
    );
    expect(f.controls.statusWrites).toContain("ready");
    expect(
      f.comments
        .get("task1")
        ?.some((c) => c.comment_text.includes("# Implementation Plan")),
    ).toBe(true);
    f.tasks.get("task1")!.status.status = "in progress";
    f.runWith(async () => "Verified retries.\nIMPLEMENTATION_COMPLETE");
    await f.coordinator.poll();
    await f.coordinator.settle();
    expect(f.counts().prs).toBe(1);
    expect(
      f.comments.get("task1")?.some((c) => c.comment_text.includes("/pull/12")),
    ).toBe(true);
    await f.coordinator.poll();
    await f.coordinator.settle();
    expect(f.runs).toHaveLength(3);
  });

  test("serializes prompts and stop supersedes queued work during an active run", async () => {
    const f = await setup();
    await f.coordinator.poll();
    f.runWith(
      async ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => resolve("IMPLEMENTATION_COMPLETE"),
            { once: true },
          );
        }),
    );
    f.addComment("implement");
    await f.coordinator.poll();
    f.addComment("also change the label");
    f.addComment("stop");
    await f.coordinator.poll();
    await f.coordinator.settle();
    expect(f.runs).toHaveLength(1);
    expect(f.runs[0]?.signal.aborted).toBe(true);
    expect(f.counts().prs).toBe(0);
    expect(f.store.sessions.get("task1")?.phase).toBe("stopped");
    await f.coordinator.poll();
    expect(f.runs).toHaveLength(1);
  });

  test("does not interpret a failed scan as unassignment; reassignment keeps the session", async () => {
    const f = await setup();
    await f.coordinator.poll();
    f.controls.failScan = true;
    await f.coordinator.poll();
    expect(f.store.sessions.get("task1")?.phase).toBe("awaiting_direction");
    f.controls.failScan = false;
    f.tasks.get("task1")!.assignees = [];
    await f.coordinator.poll();
    expect(f.store.sessions.get("task1")?.phase).toBe("suspended");
    f.addComment("do not execute this stale instruction");
    f.tasks.get("task1")!.assignees = [{ id: 10 }];
    await f.coordinator.poll();
    await f.coordinator.poll();
    expect(f.runs).toHaveLength(0);
    expect(f.counts().preparations).toBe(1);
  });

  test("reconciles a reply accepted before the connection failed", async () => {
    const f = await setup();
    f.controls.failReplyAfterAccept = true;
    await f.coordinator.poll();
    expect(f.store.sessions.get("task1")?.outbox).toHaveLength(1);
    const restored = new ClickUpCoordinator(
      f.api,
      new ClickUpStore(f.path, 10, "123"),
      settings,
      10,
      f.runtime,
    );
    await restored.restore();
    await restored.poll();
    expect(
      f.comments.get("task1")?.filter((c) => c.user.id === 10),
    ).toHaveLength(1);
    expect(restored.store.sessions.get("task1")?.outbox).toHaveLength(0);
    await restored.shutdown();
  });

  test("crash claims are reported and never rerun automatically", async () => {
    const f = await setup();
    await f.coordinator.poll();
    const session = f.store.sessions.get("task1")!;
    session.claimed = true;
    session.phase = "working";
    await f.store.save();
    const restored = new ClickUpCoordinator(
      f.api,
      new ClickUpStore(f.path, 10, "123"),
      settings,
      10,
      f.runtime,
    );
    await restored.restore();
    await restored.poll();
    expect(f.runs).toHaveLength(0);
    expect(restored.store.sessions.get("task1")?.phase).toBe("stopped");
    expect(
      f.comments
        .get("task1")
        ?.some((c) => c.comment_text.includes("will not be replayed")),
    ).toBe(true);
    await restored.shutdown();
  });

  test("a missing ready status does not approve an already in-progress task", async () => {
    const f = await setup();
    f.controls.statuses = ["in progress", "Done"];
    f.tasks.get("task1")!.status.status = "in progress";
    await f.coordinator.poll();
    f.addComment("plan");
    f.runWith(async () => "Review before coding.\nPLANNING_COMPLETE");
    await f.coordinator.poll();
    await f.coordinator.settle();
    await f.coordinator.poll();
    await f.coordinator.settle();
    expect(f.runs).toHaveLength(1);
    expect(f.store.sessions.get("task1")?.phase).toBe(
      "awaiting_implementation",
    );
    f.tasks.get("task1")!.status.status = "Open";
    await f.coordinator.poll();
    f.tasks.get("task1")!.status.status = "in progress";
    f.runWith(async () => "IMPLEMENTATION_COMPLETE");
    await f.coordinator.poll();
    await f.coordinator.settle();
    expect(f.runs).toHaveLength(2);
    expect(f.counts().prs).toBe(1);
  });

  test("missing custom statuses do not prevent implementation", async () => {
    const f = await setup();
    f.controls.statuses = ["Open", "Done"];
    await f.coordinator.poll();
    f.addComment("implement");
    f.runWith(async () => "IMPLEMENTATION_COMPLETE");
    await f.coordinator.poll();
    await f.coordinator.settle();
    expect(f.counts().prs).toBe(1);
    expect(f.controls.statusWrites).toHaveLength(0);
    expect(
      f.comments
        .get("task1")
        ?.some((c) => c.comment_text.includes('no "in progress" status')),
    ).toBe(true);
  });

  test("account changes fail closed and completion markers must be terminal", async () => {
    const f = await setup();
    await expect(new ClickUpStore(f.path, 999, "123").load()).rejects.toThrow(
      "account or Workspace changed",
    );
    expect(
      completedOutput(
        "Mention IMPLEMENTATION_COMPLETE in documentation",
        "IMPLEMENTATION_COMPLETE",
      ),
    ).toBeNull();
    expect(runGateReason({ journal: { kind: "clickup" } })).toBeNull();
    expect(isUnattendedKind("clickup")).toBe(true);
  });
});

test("real MCP tools create follow-ups with the AI identity and enforce task scope", async () => {
  const f = await setup();
  const server = createClickUpTools({
    api: f.api,
    task: exampleTask(),
    userId: 10,
    readOnly: false,
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await server.instance.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "get_task",
      "add_comment",
      "create_task",
    ]);
    const result = await client.callTool({
      name: "create_task",
      arguments: { name: "Add retry telemetry", priority: 2 },
    });
    expect(result.isError).not.toBe(true);
    expect(f.created).toHaveLength(1);
    expect(f.created[0]?.assignees).toEqual([]);
    await client.callTool({
      name: "add_comment",
      arguments: { text: "Follow-up recorded" },
    });
    expect(f.comments.get("task1")?.at(-1)?.user.id).toBe(10);
    f.tasks.get("task1")!.assignees = [];
    expect(
      (
        await client.callTool({
          name: "create_task",
          arguments: { name: "Must not exist" },
        })
      ).isError,
    ).toBe(true);
    expect(f.created).toHaveLength(1);
  } finally {
    await client.close();
    await server.instance.close();
  }
  const readOnly = createClickUpTools({
    api: f.api,
    task: exampleTask(),
    userId: 10,
    readOnly: true,
  });
  const [readerTransport, readServerTransport] =
    InMemoryTransport.createLinkedPair();
  const reader = new Client({ name: "reader", version: "1" });
  await readOnly.instance.connect(readServerTransport);
  await reader.connect(readerTransport);
  expect((await reader.listTools()).tools.map((tool) => tool.name)).toEqual([
    "get_task",
  ]);
  await reader.close();
  await readOnly.instance.close();
});
