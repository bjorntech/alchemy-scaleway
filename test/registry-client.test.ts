import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyImage, parseImageReference, resolveSourceDigest } from "../src/RegistryClient.ts";

const sha256 = (data: Uint8Array) => `sha256:${createHash("sha256").update(data).digest("hex")}`;
const bytes = (value: string) => new TextEncoder().encode(value);
const json = (value: unknown) => bytes(JSON.stringify(value));

const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const OCI_INDEX = "application/vnd.oci.image.index.v1+json";

interface ManifestEntry {
  mediaType: string;
  raw: Uint8Array;
}

interface MockRegistry {
  host: string;
  blobs: Map<string, Uint8Array>;
  manifests: Map<string, ManifestEntry>;
  uploads: number;
  manifestPuts: number;
  stop(): void;
}

// A minimal Registry v2 server that requires Bearer auth (to exercise the
// challenge/token flow) and enforces blob referential integrity on manifest push.
function startRegistry(options: { requireAuth?: boolean; basic?: string; failUploadsTimes?: number; delayedManifestHeads?: Record<string, number> } = {}): MockRegistry {
  const requireAuth = options.requireAuth ?? true;
  const blobs = new Map<string, Uint8Array>();
  const manifests = new Map<string, ManifestEntry>();
  const state = { uploads: 0, manifestPuts: 0 };
  let remainingFailures = options.failUploadsTimes ?? 0;
  const delayedManifestHeads = new Map(Object.entries(options.delayedManifestHeads ?? {}));

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;

      if (p === "/token") {
        if (options.basic) {
          const header = req.headers.get("authorization") ?? "";
          const expected = `Basic ${Buffer.from(options.basic).toString("base64")}`;
          if (header !== expected) return new Response("bad creds", { status: 401 });
        }
        return Response.json({ token: "mock-token" });
      }

      if (requireAuth && req.headers.get("authorization") !== "Bearer mock-token") {
        return new Response("auth required", {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer realm="http://${url.host}/token",service="mock",scope="repository:x:pull"`,
          },
        });
      }

      let match: RegExpMatchArray | null;
      if ((match = p.match(/^\/v2\/(.+)\/blobs\/(sha256:[a-f0-9]+)$/))) {
        const data = blobs.get(match[2]);
        if (!data) return new Response("no blob", { status: 404 });
        return req.method === "HEAD"
          ? new Response(null, { status: 200 })
          : new Response(data as unknown as BodyInit, { status: 200 });
      }
      if (p.match(/^\/v2\/(.+)\/blobs\/uploads\/$/) && req.method === "POST") {
        state.uploads += 1;
        return new Response(null, { status: 202, headers: { Location: `${p}${crypto.randomUUID()}` } });
      }
      if (p.match(/^\/v2\/(.+)\/blobs\/uploads\/[^/]+$/) && req.method === "PUT") {
        if (remainingFailures > 0) {
          remainingFailures -= 1;
          return new Response("flaky", { status: 503 });
        }
        const digest = url.searchParams.get("digest")!;
        const body = new Uint8Array(await req.arrayBuffer());
        if (sha256(body) !== digest) return new Response("digest mismatch", { status: 400 });
        blobs.set(digest, body);
        return new Response(null, { status: 201, headers: { "Docker-Content-Digest": digest } });
      }
      if ((match = p.match(/^\/v2\/(.+)\/manifests\/(.+)$/))) {
        const reference = decodeURIComponent(match[2]);
        if (req.method === "PUT") {
          state.manifestPuts += 1;
          const raw = new Uint8Array(await req.arrayBuffer());
          const digest = sha256(raw);
          const parsed = JSON.parse(new TextDecoder().decode(raw));
          for (const d of [parsed.config, ...(parsed.layers ?? []), ...(parsed.manifests ?? [])].filter(Boolean)) {
            if (!blobs.has(d.digest) && !manifests.has(d.digest)) {
              return new Response(`missing ref ${d.digest}`, { status: 400 });
            }
          }
          const entry: ManifestEntry = { mediaType: req.headers.get("content-type")!, raw };
          manifests.set(reference, entry);
          manifests.set(digest, entry);
          return new Response(null, { status: 201, headers: { "Docker-Content-Digest": digest } });
        }
        const entry = manifests.get(reference);
        if (!entry) return new Response("no manifest", { status: 404 });
        if (req.method === "HEAD") {
          const delayedHeads = delayedManifestHeads.get(reference) ?? 0;
          if (delayedHeads > 0) {
            delayedManifestHeads.set(reference, delayedHeads - 1);
            return new Response("manifest not visible yet", { status: 404 });
          }
          return new Response(null, {
            status: 200,
            headers: { "Content-Type": entry.mediaType, "Docker-Content-Digest": sha256(entry.raw) },
          });
        }
        return new Response(entry.raw as unknown as BodyInit, {
          status: 200,
          headers: { "Content-Type": entry.mediaType, "Docker-Content-Digest": sha256(entry.raw) },
        });
      }
      return new Response(`unhandled ${req.method} ${p}`, { status: 500 });
    },
  });

  return {
    host: `localhost:${server.port}`,
    blobs,
    manifests,
    get uploads() {
      return state.uploads;
    },
    get manifestPuts() {
      return state.manifestPuts;
    },
    stop: () => server.stop(true),
  };
}

// Seeds a single-platform image (config + one layer + manifest) into a registry.
function seedImage(reg: MockRegistry, repo: string, tag: string, salt: string) {
  const config = json({ architecture: "amd64", os: "linux", salt });
  const layer = bytes(`layer-${salt}`);
  const configDigest = sha256(config);
  const layerDigest = sha256(layer);
  reg.blobs.set(configDigest, config);
  reg.blobs.set(layerDigest, layer);
  const manifest = json({
    schemaVersion: 2,
    mediaType: OCI_MANIFEST,
    config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: configDigest, size: config.byteLength },
    layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar", digest: layerDigest, size: layer.byteLength }],
  });
  const digest = sha256(manifest);
  const entry = { mediaType: OCI_MANIFEST, raw: manifest };
  reg.manifests.set(tag, entry);
  reg.manifests.set(digest, entry);
  return { digest, configDigest, layerDigest, manifest };
}

// Seeds a multi-arch index referencing two single-platform child manifests.
function seedIndex(reg: MockRegistry, repo: string, tag: string) {
  const amd64 = seedImage(reg, repo, "child-amd64", "amd64");
  const arm64 = seedImage(reg, repo, "child-arm64", "arm64");
  const index = json({
    schemaVersion: 2,
    mediaType: OCI_INDEX,
    manifests: [
      { mediaType: OCI_MANIFEST, digest: amd64.digest, size: amd64.manifest.byteLength, platform: { os: "linux", architecture: "amd64" } },
      { mediaType: OCI_MANIFEST, digest: arm64.digest, size: arm64.manifest.byteLength, platform: { os: "linux", architecture: "arm64" } },
    ],
  });
  const digest = sha256(index);
  const entry = { mediaType: OCI_INDEX, raw: index };
  reg.manifests.set(tag, entry);
  reg.manifests.set(digest, entry);
  return { digest, amd64, arm64 };
}

let registries: MockRegistry[] = [];
const track = (reg: MockRegistry) => {
  registries.push(reg);
  return reg;
};
afterEach(() => {
  for (const reg of registries) reg.stop();
  registries = [];
});

describe("parseImageReference", () => {
  test("parses host, repository, and tag", () => {
    expect(parseImageReference("ghcr.io/acme/api:1.4.2")).toEqual({
      apiHost: "ghcr.io",
      repository: "acme/api",
      reference: "1.4.2",
    });
  });

  test("maps Docker Hub host and library namespace and defaults the tag", () => {
    expect(parseImageReference("docker.io/nginx")).toEqual({
      apiHost: "registry-1.docker.io",
      repository: "library/nginx",
      reference: "latest",
    });
  });

  test("handles digest-pinned references", () => {
    const parsed = parseImageReference("ghcr.io/acme/api@sha256:abc123");
    expect(parsed.repository).toBe("acme/api");
    expect(parsed.reference).toBe("sha256:abc123");
  });
});

describe("copyImage", () => {
  test("copies a single-arch image through the Bearer auth flow", async () => {
    const src = track(startRegistry());
    const dest = track(startRegistry());
    const seeded = seedImage(src, "app/api", "1.0", "v1");

    const result = await copyImage({
      source: `${src.host}/app/api:1.0`,
      destination: `${dest.host}/mirror/api`,
      destTags: ["1.0-content", "1.0"],
      allPlatforms: true,
    });

    expect(result.digest).toBe(seeded.digest);
    expect(result.platforms).toBe(1);
    expect(dest.blobs.has(seeded.configDigest)).toBe(true);
    expect(dest.blobs.has(seeded.layerDigest)).toBe(true);
    // pushed under both requested tags + its own digest
    expect(dest.manifests.has("1.0-content")).toBe(true);
    expect(dest.manifests.has("1.0")).toBe(true);
    expect(dest.manifests.has(seeded.digest)).toBe(true);
  });

  test("reports coarse progress while copying", async () => {
    const src = track(startRegistry());
    const dest = track(startRegistry());
    seedImage(src, "app/api", "1.0", "v1");
    const progress: string[] = [];

    await copyImage({
      source: `${src.host}/app/api:1.0`,
      destination: `${dest.host}/mirror/api`,
      destTags: ["1.0"],
      allPlatforms: true,
      onProgress: (message) => {
        progress.push(message);
      },
    });

    expect(progress.some((message) => message.startsWith("Resolving source manifest"))).toBe(true);
    expect(progress.some((message) => message.startsWith("Copying blob sha256:"))).toBe(true);
    expect(progress.some((message) => message === `Tagging mirrored image ${dest.host}/mirror/api:1.0`)).toBe(true);
  });

  test("preserves a multi-arch index and copies every child", async () => {
    const src = track(startRegistry());
    const dest = track(startRegistry());
    const seeded = seedIndex(src, "app/api", "1.0");

    const result = await copyImage({
      source: `${src.host}/app/api:1.0`,
      destination: `${dest.host}/mirror/api`,
      destTags: ["mirrored"],
      allPlatforms: true,
    });

    expect(result.digest).toBe(seeded.digest);
    expect(result.platforms).toBe(2);
    const top = dest.manifests.get("mirrored")!;
    expect(top.mediaType).toBe(OCI_INDEX);
    expect(sha256(top.raw)).toBe(seeded.digest);
    expect(dest.manifests.has(seeded.amd64.digest)).toBe(true);
    expect(dest.manifests.has(seeded.arm64.digest)).toBe(true);
    expect(dest.blobs.has(seeded.amd64.layerDigest)).toBe(true);
    expect(dest.blobs.has(seeded.arm64.layerDigest)).toBe(true);
  });

  test("copies only the requested platform when allPlatforms is false", async () => {
    const src = track(startRegistry());
    const dest = track(startRegistry());
    const seeded = seedIndex(src, "app/api", "1.0");

    const result = await copyImage({
      source: `${src.host}/app/api:1.0`,
      destination: `${dest.host}/mirror/api`,
      destTags: ["mirrored"],
      allPlatforms: false,
      platform: { os: "linux", architecture: "arm64" },
    });

    expect(result.digest).toBe(seeded.arm64.digest);
    const top = dest.manifests.get("mirrored")!;
    expect(top.mediaType).toBe(OCI_MANIFEST);
    expect(dest.blobs.has(seeded.arm64.layerDigest)).toBe(true);
    expect(dest.blobs.has(seeded.amd64.layerDigest)).toBe(false);
  });

  test("fails when the requested platform is missing", async () => {
    const src = track(startRegistry());
    const dest = track(startRegistry());
    seedIndex(src, "app/api", "1.0");

    await expect(
      copyImage({
        source: `${src.host}/app/api:1.0`,
        destination: `${dest.host}/mirror/api`,
        destTags: ["mirrored"],
        allPlatforms: false,
        platform: { os: "windows", architecture: "amd64" },
      }),
    ).rejects.toThrow(/no windows\/amd64 manifest/);
  });

  test("skips re-uploading blobs already present in the destination", async () => {
    const src = track(startRegistry());
    const dest = track(startRegistry());
    seedImage(src, "app/api", "1.0", "v1");

    await copyImage({ source: `${src.host}/app/api:1.0`, destination: `${dest.host}/mirror/api`, destTags: ["a"], allPlatforms: true });
    const uploadsAfterFirst = dest.uploads;
    await copyImage({ source: `${src.host}/app/api:1.0`, destination: `${dest.host}/mirror/api`, destTags: ["b"], allPlatforms: true });

    // Second copy finds blobs already present (HEAD 200) and starts no new uploads.
    expect(dest.uploads).toBe(uploadsAfterFirst);
  });

  test("skips copying an image tree when the destination manifest already exists", async () => {
    const src = track(startRegistry());
    const dest = track(startRegistry());
    seedImage(src, "app/api", "1.0", "v1");

    await copyImage({ source: `${src.host}/app/api:1.0`, destination: `${dest.host}/mirror/api`, destTags: ["a"], allPlatforms: true });
    const uploadsAfterFirst = dest.uploads;
    await copyImage({ source: `${src.host}/app/api:1.0`, destination: `${dest.host}/mirror/api`, destTags: ["b"], allPlatforms: true });

    expect(dest.uploads).toBe(uploadsAfterFirst);
    expect(dest.manifests.has("b")).toBe(true);
  });

  test("skips retagging when the destination tag already points at the digest", async () => {
    const src = track(startRegistry());
    const dest = track(startRegistry());
    seedImage(src, "app/api", "1.0", "v1");

    await copyImage({ source: `${src.host}/app/api:1.0`, destination: `${dest.host}/mirror/api`, destTags: ["a"], allPlatforms: true });
    const manifestPutsAfterFirst = dest.manifestPuts;
    const progress: string[] = [];
    await copyImage({
      source: `${src.host}/app/api:1.0`,
      destination: `${dest.host}/mirror/api`,
      destTags: ["a"],
      allPlatforms: true,
      onProgress: (message) => {
        progress.push(message);
      },
    });

    expect(dest.manifestPuts).toBe(manifestPutsAfterFirst);
    expect(progress.some((message) => message.includes("already points at"))).toBe(true);
  });

  test("waits until pushed tags are pull-visible", async () => {
    const src = track(startRegistry());
    const dest = track(startRegistry({ delayedManifestHeads: { "1.0": 1 } }));
    const seeded = seedImage(src, "app/api", "1.0", "v1");
    const progress: string[] = [];

    const result = await copyImage({
      source: `${src.host}/app/api:1.0`,
      destination: `${dest.host}/mirror/api`,
      destTags: ["1.0"],
      allPlatforms: true,
      onProgress: (message) => {
        progress.push(message);
      },
    });

    expect(result.digest).toBe(seeded.digest);
    expect(progress).toContain(`Verifying mirrored image ${dest.host}/mirror/api:1.0`);
  });

  test("sends Basic credentials to the source token endpoint", async () => {
    const src = track(startRegistry({ basic: "octocat:ghcr-token" }));
    const dest = track(startRegistry());
    const seeded = seedImage(src, "app/api", "1.0", "v1");

    const result = await copyImage({
      source: `${src.host}/app/api:1.0`,
      sourceAuth: { username: "octocat", password: "ghcr-token" },
      destination: `${dest.host}/mirror/api`,
      destTags: ["1.0"],
      allPlatforms: true,
    });
    expect(result.digest).toBe(seeded.digest);
  });

  test("retries transient upload failures", async () => {
    const src = track(startRegistry());
    const dest = track(startRegistry({ failUploadsTimes: 1 }));
    const seeded = seedImage(src, "app/api", "1.0", "v1");

    const result = await copyImage({
      source: `${src.host}/app/api:1.0`,
      destination: `${dest.host}/mirror/api`,
      destTags: ["1.0"],
      allPlatforms: true,
    });

    expect(result.digest).toBe(seeded.digest);
    expect(dest.blobs.has(seeded.configDigest)).toBe(true);
    expect(dest.blobs.has(seeded.layerDigest)).toBe(true);
  });

  test("surfaces a clear error when the source manifest is missing", async () => {
    const src = track(startRegistry());
    const dest = track(startRegistry());

    await expect(
      copyImage({ source: `${src.host}/app/api:missing`, destination: `${dest.host}/mirror/api`, destTags: ["x"], allPlatforms: true }),
    ).rejects.toThrow(/get manifest .* failed: 404/);
  });

  test("honors an aborted copy signal", async () => {
    const src = track(startRegistry());
    const dest = track(startRegistry());
    seedImage(src, "app/api", "1.0", "v1");
    const controller = new AbortController();
    controller.abort(new Error("mirror timed out"));

    await expect(
      copyImage({
        source: `${src.host}/app/api:1.0`,
        destination: `${dest.host}/mirror/api`,
        destTags: ["x"],
        allPlatforms: true,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/mirror timed out|aborted/i);
  });
});

describe("resolveSourceDigest", () => {
  test("returns the top manifest digest without copying", async () => {
    const src = track(startRegistry());
    const seeded = seedIndex(src, "app/api", "1.0");
    expect(await resolveSourceDigest(`${src.host}/app/api:1.0`)).toBe(seeded.digest);
  });
});
