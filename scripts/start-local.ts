import { mkdir, writeFile, access } from "node:fs/promises";
import { resolve, join } from "node:path";

// A regular instance with isolated state. Unlike the demo Portal, integrations run.
const root = resolve(import.meta.dir, "..");
const stateDir = resolve(
  process.env.OPENSESSION_LOCAL_STATE || join(root, ".local-state"),
);
const port = Number(process.env.PORT || 3851);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 3850)
  throw new Error("Choose a local port from 1024 to 65535 other than 3850");
await mkdir(stateDir, { recursive: true, mode: 0o700 });
const envPath = join(stateDir, "opensession.env");
try {
  await access(envPath);
} catch {
  await writeFile(envPath, "# Settings saves integration credentials here.\n", {
    flag: "wx",
    mode: 0o600,
  });
}

const probe = Bun.listen({
  hostname: "127.0.0.1",
  port: 0,
  socket: { data() {} },
});
const kernelPort = probe.port;
probe.stop(true);
const kernelUrl = `http://127.0.0.1:${kernelPort}`;
const shared = {
  PATH: `${join(process.env.HOME || "", ".bun/bin")}:${process.env.PATH || "/usr/bin:/bin"}`,
  HOME: process.env.HOME || "",
  USER: process.env.USER || "",
  LANG: process.env.LANG || "en_US.UTF-8",
  NODE_ENV: "production",
  OPENSESSION_STATE_DIR: stateDir,
  OPENSESSION_SESSION_KERNEL_PORT: String(kernelPort),
  OPENSESSION_SESSION_KERNEL_URL: kernelUrl,
  OPENSESSION_SESSION_KERNEL_TOKEN: crypto.randomUUID() + crypto.randomUUID(),
  OPENSESSION_SESSION_KERNEL_WORKERS: "2",
};
const kernel = Bun.spawn(
  [
    process.execPath,
    "--no-env-file",
    "packages/core/opensession-server/src/session-kernel-service.ts",
  ],
  { cwd: root, env: shared, stdout: "inherit", stderr: "inherit" },
);
let gateway: ReturnType<typeof Bun.spawn> | undefined;
let stopping = false;
const stop = () => {
  stopping = true;
  gateway?.kill("SIGTERM");
  kernel.kill("SIGTERM");
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
void kernel.exited.then(() => {
  if (!stopping) {
    console.error("Local session kernel exited; stopping the gateway");
    stop();
    process.exitCode = 1;
  }
});

try {
  let ready = false;
  for (let attempt = 0; attempt < 100 && !stopping; attempt++) {
    if (kernel.exitCode !== null)
      throw new Error("Local session kernel exited");
    try {
      ready = (await fetch(`${kernelUrl}/ready`)).ok;
    } catch {}
    if (ready) break;
    await Bun.sleep(100);
  }
  if (!ready) throw new Error("Local session kernel did not become ready");
  console.log(
    `Local Open Session at http://127.0.0.1:${port}. State: ${stateDir}`,
  );
  while (!stopping) {
    gateway = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        `--env-file=${envPath}`,
        "packages/core/opensession-server/opensession.ts",
      ],
      {
        cwd: root,
        env: {
          ...shared,
          PORT: String(port),
          HOST: "127.0.0.1",
          OPENSESSION_ENV_FILE: envPath,
          OPENSESSION_DEPLOY_STATE: join(stateDir, "deploy"),
          OPENSESSION_GATEWAY_LEASE: join(stateDir, "gateway-active.lock"),
          OPENSESSION_GATEWAY_LEASE_WAIT_SECS: "1",
          OPENSESSION_EXECUTOR: "0",
          OPENSESSION_PI_DETACH: "0",
          OPENSESSION_PROCESS_SUPERVISOR: "local",
          OPENSESSION_UI_BASE:
            process.env.OPENSESSION_UI_BASE || `http://127.0.0.1:${port}`,
          OPENSESSION_GITHUB_AUTH_STORE: join(stateDir, "github-auth.json"),
          OPENSESSION_WEB_SESSIONS_STORE: join(stateDir, "web-sessions.json"),
          OPENSESSION_KEYCHAIN_STORE: join(stateDir, "keychain.json"),
          OPENSESSION_SEARCH_DB: join(stateDir, "search.db"),
        },
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    await gateway.exited;
    if (!stopping) await Bun.sleep(1000);
  }
} finally {
  stop();
}
