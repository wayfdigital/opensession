import { z } from "zod";
import { realpath } from "node:fs/promises";
import {
  cancelAgentRun,
  isAgentSessionBusy,
  runAgent,
} from "../../server/agent-runner";
import {
  configuredRepos,
  configuredServer,
  defaultRepo,
} from "../../server/config";
import { getDefaultModel, toPiModel } from "../../server/models";
import {
  updateSessionFile,
  recordRunOutcome,
} from "../../server/session-cache";
import { sessionMetadata } from "../../server/session-kernel";
import { createWorktree, worktreePathFor } from "../../server/worktree";
import { createWorkspace, findWorkspaceByKey } from "../../server/workspaces";
import type { NativeSessionFile } from "../../server/types";
import { ClickUpApi } from "./api";
import type { ClickUpRuntime, TaskRun } from "./coordinator";
import { taskPrompt } from "./prompts";
import { createClickUpTools } from "./tools";

const runMetadata = z.object({
  piSessionId: z.string().optional(),
  model: z.string().optional(),
});

async function taskWorktreeExists(
  repo: string,
  path: string,
  branch: string,
): Promise<boolean> {
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
  const process = Bun.spawn(
    ["git", "-C", repo, "worktree", "list", "--porcelain"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [output, , code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (code !== 0) throw new Error("Could not verify the ClickUp worktree");
  return output
    .split("\n\n")
    .some(
      (record) =>
        record.split("\n").includes(`worktree ${canonical}`) &&
        record.split("\n").includes(`branch refs/heads/${branch}`),
    );
}

export function createClickUpRuntime(
  api: ClickUpApi,
  userId: number,
): ClickUpRuntime {
  return {
    async prepare(task) {
      const repo = defaultRepo();
      const branch = `clickup-${task.id}`;
      const sessionId = `os-clickup-${task.team_id}-${task.id}`;
      const expectedPath = worktreePathFor(branch, repo.id, { isolated: true });
      const worktreeDir = (await taskWorktreeExists(
        repo.repo,
        expectedPath,
        branch,
      ))
        ? expectedPath
        : await createWorktree(branch, repo.id, { isolated: true });
      const ref = {
        kind: "clickup",
        id: task.id,
        url: task.url,
        title: task.name,
      };
      const now = new Date().toISOString();
      const key = `clickup-${task.team_id}-${task.id}`;
      const workspace =
        (await findWorkspaceByKey(key)) ??
        (await createWorkspace({
          name: task.name.slice(0, 120),
          createdBy: "ClickUp",
          repo: repo.id,
          branch,
          worktreeDir,
          key,
          externalRefs: [ref],
        }));
      await updateSessionFile(sessionId, (data) => {
        const existing: Partial<NativeSessionFile> = data;
        return {
          id: sessionId,
          claudeSessionId: "",
          createdAt: now,
          ...existing,
          branch,
          worktreeDir,
          repo: repo.id,
          title: `${task.custom_id || task.id}: ${task.name}`,
          createdBy: "ClickUp",
          lastActivity: now,
          mode: "code",
          automation: "clickup",
          agentStarted: true,
          externalRefs: [ref],
          workspaceId: workspace.id,
        };
      });
      return { sessionId, repoId: repo.id, branch, worktreeDir };
    },

    async run(input: TaskRun) {
      const { session, signal } = input;
      const stored = await sessionMetadata({
        op: "get",
        sessionId: session.sessionId,
      });
      const metadata = stored ? runMetadata.parse(JSON.parse(stored.doc)) : {};
      let engineId = metadata.piSessionId || session.engineSessionId;
      if (engineId && isAgentSessionBusy(engineId))
        throw new Error(
          "This session is already running in Open Session. Wait for that turn before sending another instruction.",
        );
      const model = metadata.model || getDefaultModel();
      const planning = session.phase === "planning";
      const cancel = () => {
        if (engineId) void cancelAgentRun(engineId);
      };
      signal.addEventListener("abort", cancel, { once: true });
      let text = "";
      let failure: string | null = null;
      const persist = async () => {
        session.engineSessionId = engineId;
        await input.save();
        await updateSessionFile(session.sessionId, (data) => ({
          ...data,
          piSessionId: engineId || undefined,
          lastEngineProvider: "pi",
          model,
          mode: planning ? "ask" : "code",
          lastActivity: new Date().toISOString(),
        }));
      };
      try {
        await persist();
        for await (const event of runAgent({
          prompt: taskPrompt(session, input.action, input.message),
          cwd: session.worktreeDir,
          sessionId: engineId || undefined,
          mode: planning ? "ask" : "code",
          model: toPiModel(model),
          mcpServers: [],
          inProcessMcp: {
            "clickup-task": createClickUpTools({
              api,
              task: session.task,
              userId,
              readOnly: planning,
              signal,
            }),
          },
          journal: { kind: "clickup" },
          transcriptSessionId: session.sessionId,
          shouldCancel: () => signal.aborted,
        })) {
          if (event.type === "init") {
            engineId = event.sessionId || engineId;
            await persist();
            if (signal.aborted) cancel();
          }
          if (signal.aborted) break;
          if (event.type === "text_chunk" && event.text) text += event.text;
          if (event.type === "done") {
            engineId = event.sessionId || engineId;
            if (event.result) text = event.result;
          }
          if (event.type === "error")
            failure = event.content || "The coding engine failed";
        }
        if (failure) throw new Error(failure);
        return text;
      } catch (error) {
        failure =
          error instanceof Error ? error.message : "The coding engine failed";
        throw error;
      } finally {
        signal.removeEventListener("abort", cancel);
        if (signal.aborted) cancel();
        await persist();
        await recordRunOutcome(session.sessionId, failure);
      }
    },

    async createPr(session) {
      const repo = configuredRepos()[session.repoId];
      if (!repo?.ghRepo)
        throw new Error(
          "Configure the repository's GitHub owner/name before creating a PR",
        );
      async function gh(args: string[]): Promise<string> {
        const proc = Bun.spawn(["gh", "pr", ...args, "--repo", repo.ghRepo], {
          cwd: session.worktreeDir,
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            GH_PROMPT_DISABLED: "1",
          },
        });
        const timeout = setTimeout(() => proc.kill(), 60_000);
        try {
          const [output, , code] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
          ]);
          if (code !== 0)
            throw new Error(
              "GitHub PR command failed. Check the branch push and gh authentication on this host.",
            );
          return output.trim();
        } finally {
          clearTimeout(timeout);
        }
      }
      const existing = await gh([
        "list",
        "--head",
        session.branch,
        "--state",
        "open",
        "--json",
        "url",
        "--jq",
        ".[0].url // empty",
      ]);
      if (existing) return existing;
      return gh([
        "create",
        "--head",
        session.branch,
        "--base",
        repo.defaultBranch,
        "--title",
        `${session.task.custom_id || session.task.id}: ${session.task.name}`,
        "--body",
        `Implements ${session.task.name}.\n\nTask: ${session.task.url}\n\nSession: ${this.sessionUrl(session.sessionId)}`,
      ]);
    },

    sessionUrl(sessionId) {
      const base =
        process.env.OPENSESSION_UI_BASE || configuredServer().publicBaseUrl;
      return `${base.replace(/\/$/, "")}/session/${encodeURIComponent(sessionId)}`;
    },
  };
}
