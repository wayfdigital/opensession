import type { AgentModule } from "../types";
import { statePath } from "../../server/paths";
import { ClickUpApi } from "./api";
import { clickUpSettings } from "./config";
import { ClickUpCoordinator } from "./coordinator";
import { createClickUpRuntime } from "./runtime";
import { ClickUpStore } from "./store";

export class ClickUpAgent implements AgentModule {
  name = "clickup";
  private coordinator: ClickUpCoordinator | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  getRoutes(): ReturnType<AgentModule["getRoutes"]> {
    return new Map();
  }

  async startup(): Promise<void> {
    const settings = clickUpSettings();
    const api = new ClickUpApi({ token: settings.token });
    const user = await api.user();
    const workspaces = await api.workspaces();
    if (!workspaces.some((workspace) => workspace.id === settings.workspaceId))
      throw new Error(
        "The ClickUp token cannot access the configured Workspace",
      );
    const store = new ClickUpStore(
      statePath(".opensession-clickup.json"),
      user.id,
      settings.workspaceId,
    );
    this.coordinator = new ClickUpCoordinator(
      api,
      store,
      settings,
      user.id,
      createClickUpRuntime(api, user.id),
    );
    await this.coordinator.restore();
    this.stopped = false;
    const tick = async () => {
      await this.coordinator?.poll();
      if (!this.stopped) this.timer = setTimeout(tick, settings.pollMs);
    };
    void tick();
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.coordinator?.shutdown();
  }

  health(): ReturnType<AgentModule["health"]> {
    return this.coordinator?.health() ?? { status: "not_started" };
  }
}
