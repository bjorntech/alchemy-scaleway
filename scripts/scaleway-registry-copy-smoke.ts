/**
 * Live smoke test for the pure-TypeScript registry-to-registry image copy into
 * a real Scaleway Container Registry namespace. Gated by SCW_LIVE_REGISTRY_TEST=1.
 *
 *   op run --environment <alchemy-scaleway-production> -- \
 *     SCW_LIVE_REGISTRY_TEST=1 bun run scripts/scaleway-registry-copy-smoke.ts
 *
 * It exercises the production `copyImage`/`resolveSourceDigest` from
 * src/RegistryClient.ts against the real Scaleway registry to validate what a
 * mock cannot: Bearer-token auth (nologin:SCW_SECRET_KEY), blob uploads,
 * OCI/Docker media types, and a multi-arch manifest-list push, with the
 * manifest digest preserved end to end. It creates a temporary namespace and
 * deletes it on exit.
 */
import { copyImage, resolveSourceDigest } from "../src/RegistryClient.ts";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

if (process.env.SCW_LIVE_REGISTRY_TEST !== "1") {
  throw new Error("Set SCW_LIVE_REGISTRY_TEST=1 to run the live Scaleway registry copy smoke test");
}

const secretKey = required("SCW_SECRET_KEY");
const projectId = required("SCW_DEFAULT_PROJECT_ID");
const region = process.env.SCW_DEFAULT_REGION ?? "fr-par";
const apiUrl = process.env.SCW_API_URL ?? "https://api.scaleway.com";
const source = process.env.SCW_REGISTRY_SMOKE_SOURCE ?? "docker.io/library/hello-world:latest";
const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const namespaceName = (process.env.SCW_REGISTRY_SMOKE_NAME ?? `alchemy-copy-smoke-${suffix}`).toLowerCase();

const registryBase = `${apiUrl}/registry/v1/regions/${region}`;

async function scaleway<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${registryBase}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      "X-Auth-Token": secretKey,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

interface NamespaceRecord {
  id: string;
  name: string;
  endpoint?: string;
  status?: string;
}

let namespace: NamespaceRecord | undefined;

async function main() {
  console.log(`source = ${source}`);
  console.log(`creating Scaleway registry namespace "${namespaceName}" in ${region}...`);

  namespace = await scaleway<NamespaceRecord>("POST", "/namespaces", { name: namespaceName, project_id: projectId });
  for (let i = 0; i < 60 && namespace.status?.toLowerCase() !== "ready"; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    namespace = await scaleway<NamespaceRecord>("GET", `/namespaces/${namespace.id}`);
  }
  if (!namespace.endpoint) throw new Error("namespace has no endpoint");
  console.log(`namespace ready: ${namespace.endpoint} (status=${namespace.status})`);

  const destination = `${namespace.endpoint}/hello`;
  const destAuth = { username: "nologin", password: secretKey };

  const sourceDigest = await resolveSourceDigest(source);
  console.log(`source top manifest digest: ${sourceDigest}`);

  console.log(`copying into ${destination}:mirrored ...`);
  const result = await copyImage({
    source,
    destination,
    destTags: ["mirrored"],
    destAuth,
    allPlatforms: true,
  });
  console.log(`pushed: ${result.digest} (image manifests copied: ${result.platforms})`);

  // verify by resolving the manifest back from Scaleway
  const readback = await resolveSourceDigest(`${destination}:mirrored`, destAuth);
  console.log(`pulled back from Scaleway: ${readback}`);

  const match = readback === sourceDigest;
  console.log(`\nDIGEST PRESERVED END-TO-END (source -> Scaleway -> readback): ${match ? "YES ✅" : "NO ❌"}`);
  if (!match) throw new Error("digest mismatch after Scaleway round-trip");
}

main()
  .catch((err) => {
    console.error(`\nSMOKE FAILED: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (namespace?.id) {
      try {
        await scaleway("DELETE", `/namespaces/${namespace.id}`);
        console.log(`cleaned up namespace ${namespace.id}`);
      } catch (err) {
        console.error(`cleanup failed for namespace ${namespace.id}: ${(err as Error).message}`);
      }
    }
  });
