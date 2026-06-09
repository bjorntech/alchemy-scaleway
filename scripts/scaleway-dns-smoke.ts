import { spawnSync } from "node:child_process";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

type DnsZoneRecord = { domain?: string; subdomain?: string; project_id?: string };
type DnsRecord = { name?: string; type?: string; data?: string };

if (process.env.SCW_LIVE_DNS_TEST !== "1") {
  throw new Error("Set SCW_LIVE_DNS_TEST=1 to run the live Scaleway DNS smoke test");
}

const secretKey = required("SCW_SECRET_KEY");
required("SCW_ORGANIZATION_ID");
required("SCW_DEFAULT_PROJECT_ID");

const apiUrl = process.env.SCW_API_URL ?? "https://api.scaleway.com";
const suffix = process.env.SCW_DNS_SMOKE_RUN_ID ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const stage = process.env.SCW_DNS_SMOKE_STAGE ?? `dns-smoke-${suffix}`;
const prefix = process.env.SCW_DNS_SMOKE_PREFIX ?? `alchemy-dns-smoke-${suffix}`;
const dnsZone = process.env.SCW_DNS_SMOKE_ZONE ?? process.env.SCW_SMOKE_DNS_ZONE ?? "sip.finnvid.org";
const recordName = process.env.SCW_DNS_SMOKE_RECORD ?? `_alchemy-${dnsSafeLabel(prefix)}`;
const recordValue = process.env.SCW_DNS_SMOKE_VALUE ?? `alchemy-scaleway-dns-smoke=${prefix}`;
const stackFile = "scripts/scaleway-dns-smoke-stack.ts";

console.log(`DNS smoke stage=${stage} prefix=${prefix} zone=${dnsZone} record=${recordName}`);

function dnsSafeLabel(value: string) {
  const label = value.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  return (label || "alchemy-dns-smoke").slice(0, 54).replace(/-+$/g, "") || "alchemy-dns-smoke";
}

function query(params: Record<string, string | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const value = search.toString();
  return value ? `?${value}` : "";
}

async function scaleway<T>(path: string): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    headers: {
      Accept: "application/json",
      "X-Auth-Token": secretKey,
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GET ${path} failed with ${response.status}: ${body}`);
  }
  return await response.json() as T;
}

function zoneNameOf(zone: DnsZoneRecord) {
  return [zone.subdomain, zone.domain].filter(Boolean).join(".");
}

function txtData(value: string | undefined) {
  return value?.replace(/^"|"$/g, "");
}

async function sharedZoneProjectId() {
  const response = await scaleway<{ dns_zones?: DnsZoneRecord[] }>(
    `/domain/v2beta1/dns-zones${query({ dns_zone: dnsZone })}`,
  );
  const zone = (response.dns_zones ?? []).find((candidate) => zoneNameOf(candidate) === dnsZone);
  if (!zone?.project_id) throw new Error(`DNS smoke zone ${dnsZone} was not found before deploy`);
  return zone.project_id;
}

async function readRecordSet(projectId: string) {
  const response = await scaleway<{ records?: DnsRecord[] }>(
    `/domain/v2beta1/dns-zones/${encodeURIComponent(dnsZone)}/records${query({
      name: recordName,
      type: "TXT",
      project_id: projectId,
    })}`,
  );
  return response.records ?? [];
}

async function recordExists(projectId: string) {
  return (await readRecordSet(projectId)).some((record) => record.name === recordName && record.type === "TXT" && txtData(record.data) === recordValue);
}

function runAlchemy(command: "deploy" | "destroy") {
  console.log(`alchemy ${command}`);
  const result = spawnSync("bun", ["alchemy", command, stackFile, "--stage", stage, "--yes"], {
    stdio: "inherit",
    env: {
      ...process.env,
      ALCHEMY_TELEMETRY_DISABLED: process.env.ALCHEMY_TELEMETRY_DISABLED ?? "1",
      CI: process.env.CI ?? "1",
      SCW_DNS_SMOKE_PREFIX: prefix,
      SCW_DNS_SMOKE_ZONE: dnsZone,
      SCW_DNS_SMOKE_RECORD: recordName,
      SCW_DNS_SMOKE_VALUE: recordValue,
    },
  });
  if (result.status !== 0) {
    throw new Error(`alchemy ${command} failed with exit code ${result.status ?? "unknown"}`);
  }
}

const zoneProjectId = await sharedZoneProjectId();
if ((await readRecordSet(zoneProjectId)).length > 0) {
  throw new Error(`DNS smoke record ${recordName} already exists in ${dnsZone}`);
}

try {
  runAlchemy("deploy");
  if (!(await recordExists(zoneProjectId))) {
    throw new Error(`DNS smoke record ${recordName} was not created in ${dnsZone}`);
  }
  console.log("DNS smoke deploy path succeeded");
} finally {
  runAlchemy("destroy");
}

if (!(await sharedZoneProjectId())) {
  throw new Error(`DNS smoke zone ${dnsZone} was not retained`);
}
if (await recordExists(zoneProjectId)) {
  throw new Error(`DNS smoke record ${recordName} still exists after destroy`);
}

console.log("DNS smoke destroy path retained the shared zone and removed the test record");
