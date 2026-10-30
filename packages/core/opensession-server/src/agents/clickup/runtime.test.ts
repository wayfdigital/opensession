import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  prepareSnapshotEnv,
  loadSnapshotHarness,
  type SnapshotHarness,
} from "../../server/testing/snapshot-harness";
import type { RunAgentOpts } from "../../server/agent-runner";
import type { TaskSession } from "./store";
import { clickUpFixture, exampleTask } from "./fixture";

const dirs = prepareSnapshotEnv("clickup-runtime");
const previousConfig = process.env.OPENSESSION_CONFIG;
const configPath = join(dirs.root, "config.json");
process.env.OPENSESSION_CONFIG = configPath;
let harness: SnapshotHarness;
let runner: typeof import("../../server/agent-runner");
let runtimeModule: typeof import("./runtime");
const fixture = clickUpFixture();
const repo = join(dirs.root, "repo");

beforeAll(async () => {
  await mkdir(repo);
  const git = async (...args: string[]) => {
    const process = Bun.spawn(["git", ...args], {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [, stderr, code] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    if (code !== 0) throw new Error(stderr);
  };
  await git("init", "--initial-branch=main");
  await writeFile(join(repo, "README.md"), "Fixture repository\n");
  await git("add", "README.md");
  await git(
    "-c",
    "commit.gpgsign=false",
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "Initial fixture",
  );
  await git("remote", "add", "origin", repo);
  await writeFile(
    configPath,
    JSON.stringify({
      repos: {
        fixture: {
          repo,
          default: true,
          defaultBranch: "main",
          ghRepo: "example/fixture",
          sharedCheckout: true,
        },
      },
      paths: { worktreesDir: join(dirs.root, "worktrees") },
    }),
  );
  harness = await loadSnapshotHarness();
  runner = await import("../../server/agent-runner");
  runtimeModule = await import("./runtime");
}, 30_000);

afterAll(() => {
  runner?.__setEngineForTest(null);
  runner?.__setModelAvailabilityForTest(null);
  fixture.server.stop(true);
  harness?.restore();
  if (previousConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = previousConfig;
});

test("prepares a real isolated worktree and session, reuses both, and runs through the engine adapter", async () => {
  expect(harness.ready).toBe(true);
  const runtime = runtimeModule.createClickUpRuntime(fixture.api, 10);
  const task = exampleTask();
  const prepared = await runtime.prepare(task);
  expect(prepared.worktreeDir).not.toBe(repo);
  expect(await runtime.prepare(task)).toEqual(prepared);
  const session: TaskSession = {
    ...prepared,
    task,
    engineSessionId: "",
    phase: "planning",
    startedAt: Date.now(),
    seenComments: [],
    plan: "",
    claimed: true,
    outbox: [],
  };
  const calls: RunAgentOpts[] = [];
  runner.__setModelAvailabilityForTest(() => null);
  runner.__setEngineForTest(async function* (options) {
    calls.push(options);
    yield { type: "init", sessionId: "clickup-fixture-engine" };
    yield {
      type: "done",
      sessionId: "clickup-fixture-engine",
      result: "Test the retry boundary.\nPLANNING_COMPLETE",
    };
  });
  let saves = 0;
  const result = await runtime.run({
    session,
    action: "plan",
    message: "plan",
    signal: new AbortController().signal,
    save: async () => {
      saves++;
    },
  });
  expect(result).toContain("PLANNING_COMPLETE");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.mode).toBe("ask");
  expect(calls[0]?.mcpServers).toEqual([]);
  expect(calls[0]?.user).toBeUndefined();
  expect(calls[0]?.journal?.kind).toBe("clickup");
  expect(calls[0]?.transcriptSessionId).toBe(prepared.sessionId);
  expect(Object.keys(calls[0]?.inProcessMcp || {})).toEqual(["clickup-task"]);
  expect(JSON.stringify(calls[0]?.prompt)).not.toContain("fixture-token");
  expect(session.engineSessionId).toBe("clickup-fixture-engine");
  expect(saves).toBeGreaterThan(1);
  const stored = harness.readSession(prepared.sessionId);
  expect(stored.piSessionId).toBe("clickup-fixture-engine");
  expect(stored.automation).toBe("clickup");
}, 30_000);
