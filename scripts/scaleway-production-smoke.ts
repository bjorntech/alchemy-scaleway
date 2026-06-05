import { spawnSync } from "node:child_process";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

if (process.env.SCW_LIVE_TEST !== "1") {
  throw new Error("Set SCW_LIVE_TEST=1 to run the live Scaleway production smoke test");
}

required("SCW_SECRET_KEY");
required("SCW_ACCESS_KEY");
required("SCW_DEFAULT_PROJECT_ID");

const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const stage = `smoke-${suffix}`;
const prefix = `alchemy-smoke-${suffix}`;
const stackFile = "scripts/scaleway-production-stack.ts";

function runAlchemy(command: "deploy" | "destroy", phase: "create" | "update" | "settle") {
  console.log(`alchemy ${command} ${phase}`);
  const result = spawnSync(
    "bun",
    ["alchemy", command, stackFile, "--stage", stage, "--yes"],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        ALCHEMY_TELEMETRY_DISABLED: process.env.ALCHEMY_TELEMETRY_DISABLED ?? "1",
        CI: process.env.CI ?? "1",
        SCW_SMOKE_PHASE: phase,
        SCW_SMOKE_PREFIX: prefix,
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(`alchemy ${command} ${phase} failed with exit code ${result.status ?? "unknown"}`);
  }
}

try {
  runAlchemy("deploy", "create");
  runAlchemy("deploy", "update");
  runAlchemy("deploy", "settle");
  console.log("production smoke test deploy/update paths succeeded");
} finally {
  runAlchemy("destroy", "settle");
  console.log("production smoke test destroy path succeeded");
}
