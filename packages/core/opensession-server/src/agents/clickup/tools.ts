import { z } from "zod";
import { createSdkMcpServer, tool } from "../../server/inprocess-mcp";
import { newClickUpTask, type ClickUpApi, type ClickUpTask } from "./api";

type TaskToolScope = {
  api: ClickUpApi;
  task: ClickUpTask;
  userId: number;
  readOnly: boolean;
  signal?: AbortSignal;
};

export function createClickUpTools(scope: TaskToolScope) {
  const { api, task, userId } = scope;
  const response = (value: string) => ({
    content: [{ type: "text" as const, text: value }],
  });
  async function checkAssignment(): Promise<void> {
    if (scope.signal?.aborted) throw new Error("The ClickUp turn has stopped");
    const fresh = await api.task(task.id);
    if (
      fresh.team_id !== task.team_id ||
      fresh.list.id !== task.list.id ||
      !fresh.assignees.some((user) => user.id === userId) ||
      ["done", "closed"].includes(fresh.status.type) ||
      fresh.archived
    )
      throw new Error(
        "The task is no longer assigned and open in the original List",
      );
  }
  const read = tool(
    "get_task",
    "Read the assigned ClickUp task and its comments.",
    {},
    async () => {
      await checkAssignment();
      return response(
        JSON.stringify({
          task: await api.task(task.id),
          comments: await api.comments(task.id),
        }),
      );
    },
  );
  const comment = tool(
    "add_comment",
    "Add a separate note to this ClickUp task. The server already posts your final reply.",
    { text: z.string().trim().min(1).max(8000) },
    async ({ text }) => {
      await checkAssignment();
      return response(await api.comment(task.id, text));
    },
  );
  const create = tool(
    "create_task",
    "Create a follow-up task in the assigned task's List. Leave assignees empty unless explicitly requested. Set parent to the current task ID to create a subtask.",
    newClickUpTask.shape,
    async (input) => {
      await checkAssignment();
      if (input.parent && input.parent !== task.id)
        throw new Error("Subtasks must belong to the assigned task");
      const created = await api.createTask(task.list.id, input);
      return response(
        JSON.stringify({
          id: created.id,
          url: created.url,
          name: created.name,
        }),
      );
    },
  );
  return createSdkMcpServer({
    name: "clickup-task",
    tools: scope.readOnly ? [read] : [read, comment, create],
  });
}
