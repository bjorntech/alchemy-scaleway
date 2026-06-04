import { AwsClient } from "aws4fetch";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { ScalewayCredentials } from "./Credentials.ts";
import { isNotFound, ScalewayError, scalewayError } from "./Errors.ts";
import { omitUndefined } from "./Internal.ts";

export interface ScalewayNamespaceRecord {
  id: string;
  name: string;
  project_id: string;
  region?: string;
  description?: string;
  environment_variables?: Record<string, string>;
  status?: string;
}

export interface ScalewayContainerRecord {
  id: string;
  name: string;
  namespace_id: string;
  project_id?: string;
  region?: string;
  status?: string;
  domain_name?: string;
  endpoint?: string;
  registry_image?: string;
  min_scale?: number;
  max_scale?: number;
  cpu_limit?: number;
  memory_limit?: number;
  timeout?: number;
  privacy?: string;
  protocol?: string;
  port?: number;
  max_concurrency?: number;
  http_option?: string;
  environment_variables?: Record<string, string>;
}

export interface ScalewayCronRecord {
  id: string;
  container_id: string;
  schedule: string;
  name?: string;
  status?: string;
  args?: Record<string, unknown>;
}

export interface ScalewayDomainRecord {
  id: string;
  container_id: string;
  hostname: string;
  url?: string;
  status?: string;
  error_message?: string;
}

export interface ObjectStorageBucketRecord {
  name: string;
  region: string;
  endpoint: string;
  tags?: Record<string, string>;
  versioning?: boolean;
}

export interface ScalewayClients {
  region: string;
  projectId?: string;
  containers: {
    createNamespace(input: {
      name: string;
      project_id: string;
      description?: string;
      environment_variables?: Record<string, string>;
    }): Effect.Effect<ScalewayNamespaceRecord, ScalewayError>;
    getNamespace(namespaceId: string): Effect.Effect<ScalewayNamespaceRecord, ScalewayError>;
    updateNamespace(namespaceId: string, input: {
      name?: string;
      description?: string;
      environment_variables?: Record<string, string>;
    }): Effect.Effect<ScalewayNamespaceRecord, ScalewayError>;
    deleteNamespace(namespaceId: string): Effect.Effect<void, ScalewayError>;
    createContainer(input: Record<string, unknown>): Effect.Effect<ScalewayContainerRecord, ScalewayError>;
    getContainer(containerId: string): Effect.Effect<ScalewayContainerRecord, ScalewayError>;
    updateContainer(containerId: string, input: Record<string, unknown>): Effect.Effect<ScalewayContainerRecord, ScalewayError>;
    deleteContainer(containerId: string): Effect.Effect<void, ScalewayError>;
    deployContainer(containerId: string): Effect.Effect<void, ScalewayError>;
    createCron(input: { container_id: string; schedule: string; name?: string; args?: Record<string, unknown> }): Effect.Effect<ScalewayCronRecord, ScalewayError>;
    getCron(cronId: string): Effect.Effect<ScalewayCronRecord, ScalewayError>;
    updateCron(cronId: string, input: { container_id?: string; schedule?: string; name?: string; args?: Record<string, unknown> }): Effect.Effect<ScalewayCronRecord, ScalewayError>;
    deleteCron(cronId: string): Effect.Effect<void, ScalewayError>;
    listCrons(containerId: string): Effect.Effect<ReadonlyArray<ScalewayCronRecord>, ScalewayError>;
    createDomain(input: { container_id: string; hostname: string }): Effect.Effect<ScalewayDomainRecord, ScalewayError>;
    getDomain(domainId: string): Effect.Effect<ScalewayDomainRecord, ScalewayError>;
    deleteDomain(domainId: string): Effect.Effect<void, ScalewayError>;
    listDomains(containerId: string): Effect.Effect<ReadonlyArray<ScalewayDomainRecord>, ScalewayError>;
  };
  objectStorage: {
    createBucket(input: { name: string; region: string; tags?: Record<string, string>; versioning?: boolean }): Effect.Effect<ObjectStorageBucketRecord, ScalewayError>;
    getBucket(input: { name: string; region?: string }): Effect.Effect<ObjectStorageBucketRecord, ScalewayError>;
    updateBucket(input: { name: string; region: string; tags?: Record<string, string>; versioning?: boolean }): Effect.Effect<ObjectStorageBucketRecord, ScalewayError>;
    deleteBucket(input: { name: string; region: string }): Effect.Effect<void, ScalewayError>;
  };
}

export const makeScalewayClients = Effect.gen(function* () {
  const credentials = yield* ScalewayCredentials;
  const { apiUrl, region, projectId } = credentials;
  const secretKey = Redacted.value(credentials.secretKey);
  const base = `/containers/v1beta1/regions/${region}`;

  const request = <T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(`${apiUrl}${path}`, {
          method,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-Auth-Token": secretKey,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await response.text();
        const decoded = text.length === 0 ? undefined : JSON.parse(text);
        if (!response.ok) {
          const message = messageFromBody(decoded) ?? `Scaleway request failed with status ${response.status}`;
          throw scalewayError({
            operation: `${method} ${path}`,
            cause: new Error(message),
            statusCode: response.status,
            retryable: response.status >= 500 || response.status === 429,
          });
        }
        return decoded as T;
      },
      catch: (cause) =>
        cause instanceof Error && cause.name === "ScalewayError"
          ? (cause as ScalewayError)
          : scalewayError({ operation: `${method} ${path}`, cause }),
    });

  const objectStorage = makeObjectStorageClient(credentials.accessKey, secretKey, region);

  return {
    region,
    projectId,
    containers: {
      createNamespace: (input) => request("POST", `${base}/namespaces`, input).pipe(Effect.map(decodeNamespace)),
      getNamespace: (id) => request("GET", `${base}/namespaces/${id}`).pipe(Effect.map(decodeNamespace)),
      updateNamespace: (id, input) => request("PATCH", `${base}/namespaces/${id}`, input).pipe(Effect.map(decodeNamespace)),
      deleteNamespace: (id) => request<void>("DELETE", `${base}/namespaces/${id}`),
      createContainer: (input) => request("POST", `${base}/containers`, input).pipe(Effect.map(decodeContainer)),
      getContainer: (id) => request("GET", `${base}/containers/${id}`).pipe(Effect.map(decodeContainer)),
      updateContainer: (id, input) => request("PATCH", `${base}/containers/${id}`, input).pipe(Effect.map(decodeContainer)),
      deleteContainer: (id) => request<void>("DELETE", `${base}/containers/${id}`),
      deployContainer: (id) => request<void>("POST", `${base}/containers/${id}/deploy`, {}),
      createCron: (input) => request("POST", `${base}/crons`, input).pipe(Effect.map(decodeCron)),
      getCron: (id) => request("GET", `${base}/crons/${id}`).pipe(Effect.map(decodeCron)),
      updateCron: (id, input) => request("PATCH", `${base}/crons/${id}`, input).pipe(Effect.map(decodeCron)),
      deleteCron: (id) => request<void>("DELETE", `${base}/crons/${id}`),
      listCrons: (containerId) => request("GET", `${base}/crons?container_id=${encodeURIComponent(containerId)}`).pipe(Effect.map(decodeCronList)),
      createDomain: (input) => request("POST", `${base}/domains`, input).pipe(Effect.map(decodeDomain)),
      getDomain: (id) => request("GET", `${base}/domains/${id}`).pipe(Effect.map(decodeDomain)),
      deleteDomain: (id) => request<void>("DELETE", `${base}/domains/${id}`),
      listDomains: (containerId) => request("GET", `${base}/domains?container_id=${encodeURIComponent(containerId)}`).pipe(Effect.map(decodeDomainList)),
    },
    objectStorage,
  } satisfies ScalewayClients;
});

// @crap-ignore: factory contains many small request closures; score them separately.
function makeObjectStorageClient(accessKey: string | undefined, secretKey: string, defaultRegion: string) {
  const getClient = () => {
    if (!accessKey) throw new Error("Missing SCW_ACCESS_KEY for Scaleway Object Storage");
    return new AwsClient({ accessKeyId: accessKey, secretAccessKey: secretKey, service: "s3", region: defaultRegion });
  };

  const bucketEndpoint = (region: string) => `https://s3.${region}.scw.cloud`;
  const bucketVirtualHostEndpoint = (bucket: string, region: string) => `https://${bucket}.s3.${region}.scw.cloud`;
  const bucketPath = (bucket: string, path: string) => `/${bucket}${path}`;
  const request = (bucket: string, region: string, method: "GET" | "PUT" | "HEAD" | "DELETE", path: string, init?: { body?: string; headers?: Record<string, string> }) =>
    Effect.tryPromise({
      try: () => getClient().fetch(`${bucketEndpoint(region)}${bucketPath(bucket, path)}`, { method, ...(init?.headers ? { headers: init.headers } : {}), ...(init?.body ? { body: init.body } : {}) }),
      catch: (cause) => scalewayError({ operation: `${method} Object Storage ${path}`, resource: bucket, cause }),
    });

  const ensureOk = (response: Response, method: string, path: string) =>
    response.ok
      ? Effect.succeed(response)
      : Effect.tryPromise({
          try: async () => {
            const body = await response.text();
            const message = body.match(/<Message>([^<]+)<\/Message>/)?.[1] ?? `Object Storage request failed with status ${response.status}`;
            throw scalewayError({ operation: `${method} Object Storage ${path}`, cause: new Error(message), statusCode: response.status, retryable: response.status >= 500 || response.status === 429 });
          },
          catch: (cause) => (cause instanceof ScalewayError ? cause : scalewayError({ operation: `${method} Object Storage ${path}`, cause })),
        });

  const headBucket = (bucket: string, region: string): Effect.Effect<ObjectStorageBucketRecord, ScalewayError> =>
    Effect.gen(function* () {
      const response = yield* request(bucket, region, "HEAD", "/");
      yield* ensureOk(response, "HEAD", "/");
      const bucketRegion = response.headers.get("x-amz-bucket-region") ?? region;
      const versioning = yield* getVersioning(bucket, bucketRegion);
      const tags = yield* getTagging(bucket, bucketRegion);
      return omitUndefined({ name: bucket, region: bucketRegion, endpoint: bucketVirtualHostEndpoint(bucket, bucketRegion), tags, versioning }) as ObjectStorageBucketRecord;
    });

  const getVersioning = (bucket: string, region: string) =>
    Effect.gen(function* () {
      const response = yield* request(bucket, region, "GET", "/?versioning");
      const ok = yield* ensureOk(response, "GET", "/?versioning");
      const body = yield* Effect.tryPromise({ try: () => ok.text(), catch: (cause) => scalewayError({ operation: "read bucket versioning", resource: bucket, cause }) });
      return body.includes("<Status>Enabled</Status>");
    });

  const getTagging = (bucket: string, region: string) =>
    Effect.gen(function* () {
      const response = yield* request(bucket, region, "GET", "/?tagging");
      const ok = yield* ensureOk(response, "GET", "/?tagging");
      const body = yield* Effect.tryPromise({ try: () => ok.text(), catch: (cause) => scalewayError({ operation: "read bucket tags", resource: bucket, cause }) });
      const matches = [...body.matchAll(/<Tag>\s*<Key>([^<]+)<\/Key>\s*<Value>([^<]*)<\/Value>\s*<\/Tag>/g)];
      return matches.length === 0 ? undefined : Object.fromEntries(matches.map(([, key, value]) => [unescapeXml(key), unescapeXml(value)]));
    }).pipe(
      Effect.catchIf(
        (error) => isNotFound(error) || (error instanceof ScalewayError && (error.message.includes("NoSuchTagSet") || error.message.includes("NoSuchTagging"))),
        () => Effect.succeed(undefined),
      ),
    );

  const putVersioning = (bucket: string, region: string, enabled: boolean | undefined) =>
    enabled === undefined
      ? Effect.void
      : Effect.gen(function* () {
          const response = yield* request(bucket, region, "PUT", "/?versioning", { body: xml(`<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>${enabled ? "Enabled" : "Suspended"}</Status></VersioningConfiguration>`), headers: { "content-type": "application/xml" } });
          yield* ensureOk(response, "PUT", "/?versioning");
        });

  const putTags = (bucket: string, region: string, tags: Record<string, string> | undefined) =>
    tags === undefined
      ? Effect.void
      : Object.keys(tags).length === 0
        ? Effect.gen(function* () {
            const response = yield* request(bucket, region, "DELETE", "/?tagging");
            yield* ensureOk(response, "DELETE", "/?tagging");
          }).pipe(Effect.catchIf(isNotFound, () => Effect.void))
        : Effect.gen(function* () {
            const body = xml(`<Tagging><TagSet>${Object.entries(tags).map(([key, value]) => `<Tag><Key>${escapeXml(key)}</Key><Value>${escapeXml(value)}</Value></Tag>`).join("")}</TagSet></Tagging>`);
            const response = yield* request(bucket, region, "PUT", "/?tagging", { body, headers: { "content-type": "application/xml" } });
            yield* ensureOk(response, "PUT", "/?tagging");
          });

  return {
    createBucket: ({ name, region, tags, versioning }: { name: string; region: string; tags?: Record<string, string>; versioning?: boolean }) =>
      Effect.gen(function* () {
        const response = yield* request(name, region, "PUT", "/", { body: xml(`<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${escapeXml(region)}</LocationConstraint></CreateBucketConfiguration>`), headers: { "content-type": "application/xml" } });
        yield* ensureOk(response, "PUT", "/");
        yield* putVersioning(name, region, versioning);
        yield* putTags(name, region, tags);
        return yield* headBucket(name, region);
      }),
    getBucket: ({ name, region }: { name: string; region?: string }) => headBucket(name, region ?? defaultRegion),
    updateBucket: ({ name, region, tags, versioning }: { name: string; region: string; tags?: Record<string, string>; versioning?: boolean }) =>
      Effect.gen(function* () {
        yield* putVersioning(name, region, versioning);
        yield* putTags(name, region, tags);
        return yield* headBucket(name, region);
      }),
    deleteBucket: ({ name, region }: { name: string; region: string }) =>
      Effect.gen(function* () {
        const response = yield* request(name, region, "DELETE", "/");
        yield* ensureOk(response, "DELETE", "/");
      }),
  };
}

const xml = (value: string) => `<?xml version="1.0" encoding="UTF-8"?>${value}`;
const escapeXml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const unescapeXml = (value: string) => value.replaceAll("&apos;", "'").replaceAll("&quot;", '"').replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");
const messageFromBody = (body: unknown) => (typeof body === "object" && body !== null && "message" in body ? String(body.message) : undefined);
const envelope = (value: unknown, key: string) => (typeof value === "object" && value !== null && key in value ? (value as Record<string, unknown>)[key] : value);
const decodeNamespace = (value: unknown) => envelope(value, "namespace") as ScalewayNamespaceRecord;
const decodeContainer = (value: unknown) => envelope(value, "container") as ScalewayContainerRecord;
const decodeCron = (value: unknown) => envelope(value, "cron") as ScalewayCronRecord;
const decodeDomain = (value: unknown) => envelope(value, "domain") as ScalewayDomainRecord;
const decodeCronList = (value: unknown) => ((value as { crons?: ScalewayCronRecord[] }).crons ?? []);
const decodeDomainList = (value: unknown) => ((value as { domains?: ScalewayDomainRecord[] }).domains ?? []);
