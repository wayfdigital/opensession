import type { UnifiedSession } from "../../server/types";
import { ClickUpApi } from "./api";
import { clickUpSettings } from "./config";
import { isAssignedTask } from "./prompts";
import { createClickUpTools } from "./tools";
import { findIntegration } from "../../server/integrations/registry";
import { isEnabled } from "../../server/integrations/load";

export async function clickUpSessionTools(
  session: Pick<UnifiedSession, "externalRefs" | "mode">,
) {
  const integration = findIntegration("clickup");
  const ref = session.externalRefs?.find((ref) => ref.kind === "clickup");
  if (!integration || !isEnabled(integration) || !ref) return {};
  const settings = clickUpSettings();
  const api = new ClickUpApi({ token: settings.token });
  const user = await api.user();
  const task = await api.task(ref.id);
  if (!isAssignedTask(task, settings.workspaceId, user.id, settings.listIds))
    return {};
  return {
    "clickup-task": createClickUpTools({
      api,
      task,
      userId: user.id,
      readOnly: session.mode === "ask",
    }),
  };
}
