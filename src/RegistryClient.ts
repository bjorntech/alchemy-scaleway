/**
 * Minimal Docker/OCI Registry v2 distribution-protocol client used to copy an
 * image from a source registry into a Scaleway Container Registry namespace
 * without any external binary (no skopeo/crane, no Docker daemon).
 *
 * Scope and known limitations:
 * - Blobs are copied one at a time and buffered in memory with a known
 *   Content-Length monolithic upload (validated against Scaleway). Very large
 *   single layers are held in memory; chunked streaming uploads are a future
 *   optimization.
 * - Multi-arch manifest lists / OCI indexes are preserved by copying every
 *   referenced manifest (including attestation manifests) before pushing the
 *   index.
 * - Cross-repository blob mount is not used; the mirror copies between
 *   different registries where mount does not apply.
 */
import { createHash } from "node:crypto";

export interface RegistryAuth {
  username: string;
  password: string;
}

export interface ImageCopyRequest {
  /** Source image reference, e.g. `ghcr.io/acme/api:1.4.2` or `docker.io/library/nginx@sha256:...`. */
  source: string;
  sourceAuth?: RegistryAuth;
  /** Destination image (host/repository, no tag), e.g. `rg.fr-par.scw.cloud/ns/api`. */
  destination: string;
  destAuth?: RegistryAuth;
  /** Tags to push the copied top-level manifest under. */
  destTags: string[];
  /** Copy all platforms in a manifest list. When false, copies only `platform`. */
  allPlatforms: boolean;
  /** Single platform to copy when `allPlatforms` is false. Defaults to linux/amd64. */
  platform?: { os: string; architecture: string };
  /** Abort signal scoped to this copy operation. */
  signal?: AbortSignal;
  /** Receives coarse progress messages for long-running mirror operations. */
  onProgress?: (message: string) => void | Promise<void>;
}

export interface ImageCopyResult {
  digest: string;
  platforms: number;
}

const MANIFEST_MEDIA_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
];
const MANIFEST_ACCEPT = MANIFEST_MEDIA_TYPES.join(", ");
const INDEX_TYPES = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);

const sha256 = (data: Uint8Array) => `sha256:${createHash("sha256").update(data).digest("hex")}`;

const RETRY_DELAYS = [250, 1_000, 2_000];

const isTransient = (error: unknown) => {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  if (message === "eof") return true;
  return [
    " 429",
    " 500",
    " 502",
    " 503",
    " 504",
    "request canceled",
    "request cancelled",
    "connection reset",
    "connection refused",
    "econnreset",
    "econnrefused",
    "etimedout",
    "i/o timeout",
    "tls handshake timeout",
    "unexpected eof",
    " eof",
    ": eof",
  ].some((needle) => message.includes(needle));
};

const abortableDelay = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Registry operation aborted"));
      return;
    }
    const done = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timeout = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timeout);
      reject(signal?.reason ?? new Error("Registry operation aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });

const reportProgress = (request: Pick<ImageCopyRequest, "onProgress">, message: string) =>
  Promise.resolve(request.onProgress?.(message));

const withRetry = async <A>(operation: () => Promise<A>, signal?: AbortSignal): Promise<A> => {
  let lastError: unknown;
  for (const delay of [0, ...RETRY_DELAYS]) {
    if (delay > 0) await abortableDelay(delay, signal);
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransient(error)) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

// ---------------------------------------------------------------------------
// Image reference parsing
// ---------------------------------------------------------------------------
interface ParsedRef {
  /** Registry API host (Docker Hub maps to registry-1.docker.io). */
  apiHost: string;
  /** Repository path under the host. */
  repository: string;
  /** Tag or digest reference; defaults to `latest`. */
  reference: string;
}

const looksLikeHost = (segment: string): boolean => {
  return segment === "localhost" || segment.includes(".") || segment.includes(":");
};

export const parseImageReference = (ref: string): ParsedRef => {
  const [withoutDigest, digest] = ref.split("@");
  const lastSlash = withoutDigest.lastIndexOf("/");
  const afterSlash = withoutDigest.slice(lastSlash + 1);
  const colon = afterSlash.lastIndexOf(":");
  const tag = colon >= 0 ? afterSlash.slice(colon + 1) : undefined;
  const name = colon >= 0 ? withoutDigest.slice(0, lastSlash + 1) + afterSlash.slice(0, colon) : withoutDigest;

  const firstSegment = name.split("/")[0] ?? name;
  const hasHost = name.includes("/") && looksLikeHost(firstSegment);
  let host = hasHost ? firstSegment : "docker.io";
  let repository = hasHost ? name.slice(firstSegment.length + 1) : name;

  // Docker Hub conventions: official images live under `library/`.
  if ((host === "docker.io" || host === "index.docker.io") && !repository.includes("/")) {
    repository = `library/${repository}`;
  }
  const apiHost = host === "docker.io" || host === "index.docker.io" ? "registry-1.docker.io" : host;

  return { apiHost, repository, reference: digest ? `sha256:${digest.replace(/^sha256:/, "")}` : tag ?? "latest" };
};

// ---------------------------------------------------------------------------
// Registry client (auth + transport)
// ---------------------------------------------------------------------------
interface Challenge {
  realm: string;
  service?: string;
  scope?: string;
}

const parseChallenge = (header: string): Challenge | undefined => {
  if (!header.toLowerCase().startsWith("bearer ")) return undefined;
  const out: Record<string, string> = {};
  for (const match of header.slice(7).matchAll(/(\w+)="([^"]*)"/g)) out[match[1]] = match[2];
  if (!out.realm) return undefined;
  return { realm: out.realm, service: out.service, scope: out.scope };
};

class RegistryClient {
  private tokens = new Map<string, string>();

  constructor(
    readonly apiHost: string,
    readonly auth?: RegistryAuth,
  ) {}

  private async getToken(challenge: Challenge, scope: string, signal?: AbortSignal): Promise<string> {
    const url = new URL(challenge.realm);
    if (challenge.service) url.searchParams.set("service", challenge.service);
    if (scope) url.searchParams.set("scope", scope);
    const headers: Record<string, string> = {};
    if (this.auth) {
      headers.Authorization = `Basic ${Buffer.from(`${this.auth.username}:${this.auth.password}`).toString("base64")}`;
    }
    const res = await fetch(url, { headers, signal });
    if (!res.ok) throw new Error(`token request to ${url.host} failed: ${res.status}`);
    const body = (await res.json()) as { token?: string; access_token?: string };
    const token = body.token ?? body.access_token;
    if (!token) throw new Error(`token request to ${url.host} returned no token`);
    return token;
  }

  // Performs a request, transparently handling the 401 -> token -> retry dance
  // and caching the token under the requested scope.
  async request(method: string, path: string, scope: string, init: RequestInit = {}): Promise<Response> {
    // Local registries (used for testing) are reached over plain HTTP.
    const scheme = this.apiHost.startsWith("localhost") || this.apiHost.startsWith("127.0.0.1") ? "http" : "https";
    const url = `${scheme}://${this.apiHost}${path}`;
    const withAuth = (token?: string): RequestInit => ({
      ...init,
      method,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });

    let res = await fetch(url, withAuth(this.tokens.get(scope)));
    if (res.status !== 401) return res;

    const challenge = parseChallenge(res.headers.get("www-authenticate") ?? "");
    await res.arrayBuffer().catch(() => undefined);
    if (!challenge) {
      return fetch(url, withAuth()); // no usable challenge; surface the original failure
    }
    const token = await this.getToken(challenge, challenge.scope ?? scope, init.signal as AbortSignal | undefined);
    this.tokens.set(scope, token);
    return fetch(url, withAuth(token));
  }
}

const pullScope = (repo: string) => `repository:${repo}:pull`;
const pushScope = (repo: string) => `repository:${repo}:pull,push`;

interface FetchedManifest {
  digest: string;
  mediaType: string;
  raw: Uint8Array;
  parsed: { mediaType?: string; config?: Descriptor; layers?: Descriptor[]; manifests?: IndexEntry[] };
}

interface Descriptor {
  digest: string;
  size?: number;
}

interface IndexEntry extends Descriptor {
  mediaType?: string;
  platform?: { os?: string; architecture?: string };
}

const getManifest = (client: RegistryClient, repo: string, reference: string, signal?: AbortSignal): Promise<FetchedManifest> =>
  withRetry(async () => {
    const res = await client.request("GET", `/v2/${repo}/manifests/${reference}`, pullScope(repo), {
      headers: { Accept: MANIFEST_ACCEPT },
      signal,
    });
    if (!res.ok) throw new Error(`get manifest ${repo}:${reference} failed: ${res.status} ${await res.text()}`);
    const raw = new Uint8Array(await res.arrayBuffer());
    const parsed = JSON.parse(new TextDecoder().decode(raw));
    const mediaType = res.headers.get("content-type")?.split(";")[0] ?? parsed.mediaType;
    const digest = res.headers.get("docker-content-digest") ?? sha256(raw);
    return { digest, mediaType, raw, parsed };
  }, signal);

const blobExists = (client: RegistryClient, repo: string, digest: string, signal?: AbortSignal): Promise<boolean> =>
  withRetry(async () => {
    const res = await client.request("HEAD", `/v2/${repo}/blobs/${digest}`, pushScope(repo), { signal });
    await res.arrayBuffer().catch(() => undefined);
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    throw new Error(`head blob ${digest} failed: ${res.status}`);
  }, signal);

const pullBlob = (client: RegistryClient, repo: string, descriptor: Descriptor, signal?: AbortSignal): Promise<Uint8Array> =>
  withRetry(async () => {
    const res = await client.request("GET", `/v2/${repo}/blobs/${descriptor.digest}`, pullScope(repo), { signal });
    if (!res.ok) throw new Error(`get blob ${descriptor.digest} failed: ${res.status}`);
    const data = new Uint8Array(await res.arrayBuffer());
    if (sha256(data) !== descriptor.digest) throw new Error(`source blob digest mismatch for ${descriptor.digest}`);
    return data;
  }, signal);

const pushBlob = (client: RegistryClient, repo: string, descriptor: Descriptor, data: Uint8Array, signal?: AbortSignal): Promise<void> =>
  withRetry(async () => {
    if (await blobExists(client, repo, descriptor.digest, signal)) return;
    const start = await client.request("POST", `/v2/${repo}/blobs/uploads/`, pushScope(repo), { signal });
    if (start.status !== 202) throw new Error(`start upload for ${repo} failed: ${start.status} ${await start.text()}`);
    const location = start.headers.get("location");
    await start.arrayBuffer().catch(() => undefined);
    if (!location) throw new Error(`start upload for ${repo} returned no Location`);
    const path = location.replace(/^https?:\/\/[^/]+/, "");
    const separator = path.includes("?") ? "&" : "?";
    const put = await client.request(
      "PUT",
      `${path}${separator}digest=${encodeURIComponent(descriptor.digest)}`,
      pushScope(repo),
      {
        headers: { "Content-Type": "application/octet-stream", "Content-Length": String(data.byteLength) },
        body: data as unknown as BodyInit,
        signal,
      },
    );
    if (put.status !== 201) throw new Error(`finalize upload for ${descriptor.digest} failed: ${put.status} ${await put.text()}`);
    await put.arrayBuffer().catch(() => undefined);
  }, signal);

const putManifest = (
  client: RegistryClient,
  repo: string,
  reference: string,
  mediaType: string,
  raw: Uint8Array,
  signal?: AbortSignal,
): Promise<string> =>
  withRetry(async () => {
    const res = await client.request("PUT", `/v2/${repo}/manifests/${reference}`, pushScope(repo), {
      headers: { "Content-Type": mediaType, "Content-Length": String(raw.byteLength) },
      body: raw as unknown as BodyInit,
      signal,
    });
    if (res.status !== 201) throw new Error(`put manifest ${reference} failed: ${res.status} ${await res.text()}`);
    const digest = res.headers.get("docker-content-digest") ?? sha256(raw);
    await res.arrayBuffer().catch(() => undefined);
    return digest;
  }, signal);

// Copies a manifest and everything it references, pushing each manifest under
// its own digest so parent indexes resolve. Returns the copied manifest.
async function copyManifestTree(
  src: RegistryClient,
  srcRepo: string,
  dest: RegistryClient,
  destRepo: string,
  reference: string,
  counter: { images: number },
  signal?: AbortSignal,
  onProgress?: ImageCopyRequest["onProgress"],
): Promise<FetchedManifest> {
  await reportProgress({ onProgress }, `Fetching manifest ${reference}`);
  const manifest = await getManifest(src, srcRepo, reference, signal);
  if (INDEX_TYPES.has(manifest.mediaType)) {
    await reportProgress({ onProgress }, `Copying ${manifest.parsed.manifests?.length ?? 0} platform manifest(s) from index ${manifest.digest}`);
    for (const child of manifest.parsed.manifests ?? []) {
      await copyManifestTree(src, srcRepo, dest, destRepo, child.digest, counter, signal, onProgress);
    }
  } else {
    counter.images += 1;
    const blobs = [manifest.parsed.config, ...(manifest.parsed.layers ?? [])].filter(
      (descriptor): descriptor is Descriptor => Boolean(descriptor),
    );
    for (const descriptor of blobs) {
      await reportProgress({ onProgress }, `Copying blob ${descriptor.digest}${descriptor.size ? ` (${descriptor.size} bytes)` : ""}`);
      const data = await pullBlob(src, srcRepo, descriptor, signal);
      await pushBlob(dest, destRepo, descriptor, data, signal);
    }
  }
  await reportProgress({ onProgress }, `Pushing manifest ${manifest.digest}`);
  await putManifest(dest, destRepo, manifest.digest, manifest.mediaType, manifest.raw, signal);
  return manifest;
}

/** Resolves the source top-level manifest digest without copying. */
export const resolveSourceDigest = (source: string, auth?: RegistryAuth, signal?: AbortSignal): Promise<string> => {
  const parsed = parseImageReference(source);
  const client = new RegistryClient(parsed.apiHost, auth);
  return getManifest(client, parsed.repository, parsed.reference, signal).then((manifest) => manifest.digest);
};

/** Copies an image (single- or multi-arch) from a source registry into the destination. */
export async function copyImage(request: ImageCopyRequest): Promise<ImageCopyResult> {
  const sourceRef = parseImageReference(request.source);
  const destRef = parseImageReference(`${request.destination}:ignored`);
  const src = new RegistryClient(sourceRef.apiHost, request.sourceAuth);
  const dest = new RegistryClient(destRef.apiHost, request.destAuth);
  const counter = { images: 0 };
  const platform = request.platform ?? { os: "linux", architecture: "amd64" };

  await reportProgress(request, `Resolving source manifest ${request.source}`);
  const top = await getManifest(src, sourceRef.repository, sourceRef.reference, request.signal);

  let pushTarget = top;
  if (INDEX_TYPES.has(top.mediaType) && !request.allPlatforms) {
    const child = (top.parsed.manifests ?? []).find(
      (entry) => entry.platform?.os === platform.os && entry.platform?.architecture === platform.architecture,
    );
    if (!child) throw new Error(`source has no ${platform.os}/${platform.architecture} manifest`);
    await reportProgress(request, `Selected ${platform.os}/${platform.architecture} manifest ${child.digest}`);
    pushTarget = await copyManifestTree(src, sourceRef.repository, dest, destRef.repository, child.digest, counter, request.signal, request.onProgress);
  } else {
    await copyManifestTree(src, sourceRef.repository, dest, destRef.repository, sourceRef.reference, counter, request.signal, request.onProgress);
  }

  for (const tag of request.destTags) {
    await reportProgress(request, `Tagging mirrored image ${request.destination}:${tag}`);
    await putManifest(dest, destRef.repository, tag, pushTarget.mediaType, pushTarget.raw, request.signal);
  }
  return { digest: pushTarget.digest, platforms: counter.images };
}
