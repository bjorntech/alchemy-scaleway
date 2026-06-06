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
required("SCW_ORGANIZATION_ID");
const defaultProjectId = required("SCW_DEFAULT_PROJECT_ID");
const domainProjectId = process.env.SCW_DOMAIN_PROJECT_ID ?? defaultProjectId;

const suffix = process.env.SCW_SMOKE_RUN_ID ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const stage = process.env.SCW_SMOKE_STAGE ?? `smoke-${suffix}`;
const prefix = process.env.SCW_SMOKE_PREFIX ?? `alchemy-smoke-${suffix}`;
const dnsZone = process.env.SCW_SMOKE_DNS_ZONE ?? "alchemy-smoke.finnvid.org";
const dnsLabel = process.env.SCW_SMOKE_DNS_LABEL ?? dnsSafeLabel(prefix);
const smokeUrl = `https://${dnsLabel}.${dnsZone}`;
const stackFile = "scripts/scaleway-production-stack.ts";

console.log(`production smoke stage=${stage} prefix=${prefix} smokeUrl=${smokeUrl}`);

function dnsSafeLabel(value: string) {
  const label = value.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  return (label || "alchemy-smoke").slice(0, 63).replace(/-+$/g, "") || "alchemy-smoke";
}

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
        SCW_SMOKE_DNS_ZONE: dnsZone,
        SCW_SMOKE_DNS_LABEL: dnsLabel,
        SCW_DOMAIN_PROJECT_ID: domainProjectId,
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(`alchemy ${command} ${phase} failed with exit code ${result.status ?? "unknown"}`);
  }
}

async function fetchSmokeDomain() {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 24; attempt++) {
    try {
      const response = await fetch(smokeUrl);
      const body = await response.text();
      if (response.ok && body.toLowerCase().includes("nginx")) {
        console.log(`fetched ${smokeUrl} (${response.status})`);
        return;
      }
      lastError = new Error(`unexpected response ${response.status}: ${body.slice(0, 120)}`);
    } catch (error) {
      lastError = error;
    }
    console.log(`waiting for ${smokeUrl} fetch attempt ${attempt}/24`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw lastError instanceof Error ? lastError : new Error(`failed to fetch ${smokeUrl}`);
}

try {
  runAlchemy("deploy", "create");
  runAlchemy("deploy", "update");
  runAlchemy("deploy", "settle");
  await fetchSmokeDomain();
  console.log("production smoke test deploy/update paths succeeded");
} finally {
  runAlchemy("destroy", "settle");
  console.log("production smoke test destroy path succeeded");
}
