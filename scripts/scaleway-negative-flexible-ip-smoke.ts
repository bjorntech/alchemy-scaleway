import { spawnSync } from "node:child_process";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

type FlexibleIpListResponse = {
  ips?: Array<{ id?: string; tags?: string[] }>;
};

if (process.env.SCW_LIVE_NEGATIVE_TEST !== "1") {
  throw new Error("Set SCW_LIVE_NEGATIVE_TEST=1 to run the live Scaleway negative smoke test");
}

const secretKey = required("SCW_SECRET_KEY");
required("SCW_DEFAULT_PROJECT_ID");

const region = process.env.SCW_DEFAULT_REGION || "fr-par";
const zone = process.env.SCW_DEFAULT_ZONE || `${region}-1`;
const apiUrl = process.env.SCW_API_URL ?? "https://api.scaleway.com";
const suffix = process.env.SCW_NEGATIVE_SMOKE_RUN_ID ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const stage = process.env.SCW_NEGATIVE_SMOKE_STAGE ?? `negative-smoke-${suffix}`;
const prefix = process.env.SCW_NEGATIVE_SMOKE_PREFIX ?? `alchemy-negative-smoke-${suffix}`;
const stackFile = "scripts/scaleway-negative-flexible-ip-stack.ts";
const logicalIdTag = "alchemy:logical-id=FlexibleIp";
const negativeSmokeTag = `alchemy-negative-smoke=${prefix}`;

console.log(`negative flexible IP smoke stage=${stage} prefix=${prefix}`);

function runAlchemy(command: "deploy" | "destroy") {
  console.log(`alchemy ${command}`);
  const result = spawnSync("bun", ["alchemy", command, stackFile, "--stage", stage, "--yes"], {
    encoding: "utf8",
    env: {
      ...process.env,
      ALCHEMY_TELEMETRY_DISABLED: process.env.ALCHEMY_TELEMETRY_DISABLED ?? "1",
      CI: process.env.CI ?? "1",
      SCW_NEGATIVE_SMOKE_PREFIX: prefix,
    },
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

async function scaleway<T>(method: "GET" | "DELETE", path: string): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      "X-Auth-Token": secretKey,
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${method} ${path} failed with ${response.status}: ${body}`);
  }
  return response.status === 204 ? (undefined as T) : await response.json() as T;
}

async function findTaggedFlexibleIps() {
  const found: Array<{ id: string; tags: string[] }> = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await scaleway<FlexibleIpListResponse>("GET", `/instance/v1/zones/${zone}/ips?page=${page}&per_page=100`);
    const ips = response.ips ?? [];
    for (const ip of ips) {
      const tags = ip.tags ?? [];
      if (ip.id && tags.includes(logicalIdTag) && tags.includes(negativeSmokeTag)) {
        found.push({ id: ip.id, tags });
      }
    }
    if (ips.length < 100) break;
  }
  return found;
}

const deploy = runAlchemy("deploy");
let failure: Error | undefined;

if (deploy.status === 0) {
  runAlchemy("destroy");
  failure = new Error("negative smoke deploy unexpectedly succeeded; reverse DNS failure was not triggered");
} else {
  const output = `${deploy.stdout ?? ""}\n${deploy.stderr ?? ""}`;
  if (!output.toLowerCase().includes("reverse")) {
    failure = new Error(`negative smoke deploy failed for an unexpected reason with exit code ${deploy.status ?? "unknown"}`);
  }
}

const leaked = await findTaggedFlexibleIps();
for (const ip of leaked) {
  console.log(`deleting leaked flexible IP ${ip.id}`);
  await scaleway<void>("DELETE", `/instance/v1/zones/${zone}/ips/${ip.id}`);
}

if (leaked.length > 0) {
  throw new Error(`negative smoke found and deleted ${leaked.length} leaked flexible IP(s): ${leaked.map((ip) => ip.id).join(", ")}`);
}

if (failure) throw failure;

console.log("negative flexible IP smoke test verified failed reverse DNS create cleanup");
