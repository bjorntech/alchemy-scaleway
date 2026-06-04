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
  public_endpoint?: string;
  image?: string;
  min_scale?: number;
  max_scale?: number;
  mvcpu_limit?: number;
  memory_limit_bytes?: number;
  timeout?: number;
  privacy?: string;
  protocol?: string;
  port?: number;
  https_connections_only?: boolean;
  environment_variables?: Record<string, string>;
}

export interface ScalewayTriggerCronConfig {
  schedule: string;
  timezone?: string;
  body?: string;
  headers?: Record<string, string>;
}

export interface ScalewayTriggerSqsConfig {
  region?: string;
  endpoint?: string;
  access_key_id?: string;
  /** Write-only: provided on create/update, never returned by reads. */
  secret_access_key?: string;
  queue_url?: string;
}

export interface ScalewayTriggerNatsConfig {
  server_urls?: string[];
  subject?: string;
  /** Write-only: provided on create/update, never returned by reads. */
  credentials_file_content?: string;
}

export interface ScalewayTriggerDestinationConfig {
  http_path?: string;
  http_method?: string;
}

export interface ScalewayTriggerRecord {
  id: string;
  container_id: string;
  name?: string;
  description?: string;
  status?: string;
  source_type?: string;
  destination_config?: ScalewayTriggerDestinationConfig;
  cron_config?: ScalewayTriggerCronConfig;
  sqs_config?: ScalewayTriggerSqsConfig;
  nats_config?: ScalewayTriggerNatsConfig;
}

export interface ScalewayCreateTriggerInput {
  container_id: string;
  name?: string;
  description?: string;
  destination_config?: ScalewayTriggerDestinationConfig;
  cron_config?: ScalewayTriggerCronConfig;
  sqs_config?: ScalewayTriggerSqsConfig;
  nats_config?: ScalewayTriggerNatsConfig;
}

export interface ScalewayUpdateTriggerInput {
  name?: string;
  description?: string;
  destination_config?: ScalewayTriggerDestinationConfig;
  cron_config?: Partial<ScalewayTriggerCronConfig>;
  sqs_config?: ScalewayTriggerSqsConfig;
  nats_config?: ScalewayTriggerNatsConfig;
}

export interface ScalewayDomainRecord {
  id: string;
  container_id: string;
  hostname: string;
  status?: string;
  error_message?: string;
}

export interface ScalewayRegistryNamespaceRecord {
  id: string;
  name: string;
  project_id: string;
  region?: string;
  description?: string;
  is_public?: boolean;
  endpoint?: string;
  status?: string;
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
    updateNamespace(
      namespaceId: string,
      input: {
        name?: string;
        description?: string;
        environment_variables?: Record<string, string>;
      },
    ): Effect.Effect<ScalewayNamespaceRecord, ScalewayError>;
    deleteNamespace(namespaceId: string): Effect.Effect<void, ScalewayError>;
    createContainer(
      input: Record<string, unknown>,
    ): Effect.Effect<ScalewayContainerRecord, ScalewayError>;
    getContainer(containerId: string): Effect.Effect<ScalewayContainerRecord, ScalewayError>;
    updateContainer(
      containerId: string,
      input: Record<string, unknown>,
    ): Effect.Effect<ScalewayContainerRecord, ScalewayError>;
    deleteContainer(containerId: string): Effect.Effect<void, ScalewayError>;
    createTrigger(
      input: ScalewayCreateTriggerInput,
    ): Effect.Effect<ScalewayTriggerRecord, ScalewayError>;
    getTrigger(triggerId: string): Effect.Effect<ScalewayTriggerRecord, ScalewayError>;
    updateTrigger(
      triggerId: string,
      input: ScalewayUpdateTriggerInput,
    ): Effect.Effect<ScalewayTriggerRecord, ScalewayError>;
    deleteTrigger(triggerId: string): Effect.Effect<void, ScalewayError>;
    createDomain(input: {
      container_id: string;
      hostname: string;
    }): Effect.Effect<ScalewayDomainRecord, ScalewayError>;
    getDomain(domainId: string): Effect.Effect<ScalewayDomainRecord, ScalewayError>;
    deleteDomain(domainId: string): Effect.Effect<void, ScalewayError>;
  };
  registry: {
    createNamespace(input: {
      name: string;
      project_id: string;
      description?: string;
      is_public?: boolean;
    }): Effect.Effect<ScalewayRegistryNamespaceRecord, ScalewayError>;
    getNamespace(
      namespaceId: string,
    ): Effect.Effect<ScalewayRegistryNamespaceRecord, ScalewayError>;
    updateNamespace(
      namespaceId: string,
      input: {
        description?: string;
        is_public?: boolean;
      },
    ): Effect.Effect<ScalewayRegistryNamespaceRecord, ScalewayError>;
    deleteNamespace(namespaceId: string): Effect.Effect<void, ScalewayError>;
  };
  objectStorage: {
    createBucket(input: {
      name: string;
      region: string;
      tags?: Record<string, string>;
      versioning?: boolean;
    }): Effect.Effect<ObjectStorageBucketRecord, ScalewayError>;
    getBucket(input: {
      name: string;
      region?: string;
    }): Effect.Effect<ObjectStorageBucketRecord, ScalewayError>;
    updateBucket(input: {
      name: string;
      region: string;
      tags?: Record<string, string>;
      versioning?: boolean;
    }): Effect.Effect<ObjectStorageBucketRecord, ScalewayError>;
    deleteBucket(input: { name: string; region: string }): Effect.Effect<void, ScalewayError>;
  };
}

export const makeScalewayClients = Effect.gen(function* () {
  const credentials = yield* ScalewayCredentials;
  const { apiUrl, region, projectId } = credentials;
  const secretKey = Redacted.value(credentials.secretKey);
  const base = `/containers/v1/regions/${region}`;
  const registryBase = `/registry/v1/regions/${region}`;

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
          const message =
            messageFromBody(decoded) ?? `Scaleway request failed with status ${response.status}`;
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
      createNamespace: (input) =>
        request("POST", `${base}/namespaces`, input).pipe(Effect.map(decodeNamespace)),
      getNamespace: (id) =>
        request("GET", `${base}/namespaces/${id}`).pipe(Effect.map(decodeNamespace)),
      updateNamespace: (id, input) =>
        request("PATCH", `${base}/namespaces/${id}`, input).pipe(Effect.map(decodeNamespace)),
      deleteNamespace: (id) => request<void>("DELETE", `${base}/namespaces/${id}`),
      createContainer: (input) =>
        request("POST", `${base}/containers`, input).pipe(Effect.map(decodeContainer)),
      getContainer: (id) =>
        request("GET", `${base}/containers/${id}`).pipe(Effect.map(decodeContainer)),
      updateContainer: (id, input) =>
        request("PATCH", `${base}/containers/${id}`, input).pipe(Effect.map(decodeContainer)),
      deleteContainer: (id) => request<void>("DELETE", `${base}/containers/${id}`),
      createTrigger: (input) =>
        request("POST", `${base}/triggers`, input).pipe(Effect.map(decodeTrigger)),
      getTrigger: (id) => request("GET", `${base}/triggers/${id}`).pipe(Effect.map(decodeTrigger)),
      updateTrigger: (id, input) =>
        request("PATCH", `${base}/triggers/${id}`, input).pipe(Effect.map(decodeTrigger)),
      deleteTrigger: (id) => request<void>("DELETE", `${base}/triggers/${id}`),
      createDomain: (input) =>
        request("POST", `${base}/domains`, input).pipe(Effect.map(decodeDomain)),
      getDomain: (id) => request("GET", `${base}/domains/${id}`).pipe(Effect.map(decodeDomain)),
      deleteDomain: (id) => request<void>("DELETE", `${base}/domains/${id}`),
    },
    registry: {
      createNamespace: (input) =>
        request("POST", `${registryBase}/namespaces`, input).pipe(
          Effect.map(decodeRegistryNamespace),
        ),
      getNamespace: (id) =>
        request("GET", `${registryBase}/namespaces/${id}`).pipe(
          Effect.map(decodeRegistryNamespace),
        ),
      updateNamespace: (id, input) =>
        request("PATCH", `${registryBase}/namespaces/${id}`, input).pipe(
          Effect.map(decodeRegistryNamespace),
        ),
      deleteNamespace: (id) => request<void>("DELETE", `${registryBase}/namespaces/${id}`),
    },
    objectStorage,
  } satisfies ScalewayClients;
});

// @crap-ignore: factory contains many small request closures; score them separately.
function makeObjectStorageClient(
  accessKey: string | undefined,
  secretKey: string,
  defaultRegion: string,
) {
  const clients = new Map<string, AwsClient>();
  const getClient = (region: string) => {
    if (!accessKey) throw new Error("Missing SCW_ACCESS_KEY for Scaleway Object Storage");
    const existing = clients.get(region);
    if (existing) return existing;
    const client = new AwsClient({
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
      service: "s3",
      region,
    });
    clients.set(region, client);
    return client;
  };

  const bucketEndpoint = (region: string) => `https://s3.${region}.scw.cloud`;
  const bucketVirtualHostEndpoint = (bucket: string, region: string) =>
    `https://${bucket}.s3.${region}.scw.cloud`;
  const bucketPath = (bucket: string, path: string) => `/${bucket}${path}`;
  const request = (
    bucket: string,
    region: string,
    method: "GET" | "PUT" | "HEAD" | "DELETE",
    path: string,
    init?: { body?: string; headers?: Record<string, string> },
  ) =>
    Effect.tryPromise({
      try: () =>
        getClient(region).fetch(`${bucketEndpoint(region)}${bucketPath(bucket, path)}`, {
          method,
          ...(init?.headers ? { headers: init.headers } : {}),
          ...(init?.body ? { body: init.body } : {}),
        }),
      catch: (cause) =>
        scalewayError({ operation: `${method} Object Storage ${path}`, resource: bucket, cause }),
    });

  const ensureOk = (response: Response, method: string, path: string) =>
    response.ok
      ? Effect.succeed(response)
      : Effect.tryPromise({
          try: async () => {
            const body = await response.text();
            const message =
              body.match(/<Message>([^<]+)<\/Message>/)?.[1] ??
              `Object Storage request failed with status ${response.status}`;
            throw scalewayError({
              operation: `${method} Object Storage ${path}`,
              cause: new Error(message),
              statusCode: response.status,
              retryable: response.status >= 500 || response.status === 429,
            });
          },
          catch: (cause) =>
            cause instanceof ScalewayError
              ? cause
              : scalewayError({ operation: `${method} Object Storage ${path}`, cause }),
        });

  const headBucket = (
    bucket: string,
    region: string,
  ): Effect.Effect<ObjectStorageBucketRecord, ScalewayError> =>
    Effect.gen(function* () {
      const response = yield* request(bucket, region, "HEAD", "/");
      yield* ensureOk(response, "HEAD", "/");
      const bucketRegion = response.headers.get("x-amz-bucket-region") ?? region;
      const versioning = yield* getVersioning(bucket, bucketRegion);
      const tags = yield* getTagging(bucket, bucketRegion);
      return omitUndefined({
        name: bucket,
        region: bucketRegion,
        endpoint: bucketVirtualHostEndpoint(bucket, bucketRegion),
        tags,
        versioning,
      }) as ObjectStorageBucketRecord;
    });

  const getVersioning = (bucket: string, region: string) =>
    Effect.gen(function* () {
      const response = yield* request(bucket, region, "GET", "/?versioning");
      const ok = yield* ensureOk(response, "GET", "/?versioning");
      const body = yield* Effect.tryPromise({
        try: () => ok.text(),
        catch: (cause) =>
          scalewayError({ operation: "read bucket versioning", resource: bucket, cause }),
      });
      return body.includes("<Status>Enabled</Status>");
    });

  const getTagging = (bucket: string, region: string) =>
    Effect.gen(function* () {
      const response = yield* request(bucket, region, "GET", "/?tagging");
      const ok = yield* ensureOk(response, "GET", "/?tagging");
      const body = yield* Effect.tryPromise({
        try: () => ok.text(),
        catch: (cause) => scalewayError({ operation: "read bucket tags", resource: bucket, cause }),
      });
      const matches = [
        ...body.matchAll(/<Tag>\s*<Key>([^<]+)<\/Key>\s*<Value>([^<]*)<\/Value>\s*<\/Tag>/g),
      ];
      return matches.length === 0
        ? undefined
        : Object.fromEntries(
            matches.map(([, key, value]) => [unescapeXml(key), unescapeXml(value)]),
          );
    }).pipe(
      Effect.catchIf(
        (error) =>
          isNotFound(error) ||
          (error instanceof ScalewayError &&
            (error.message.includes("NoSuchTagSet") || error.message.includes("NoSuchTagging"))),
        () => Effect.succeed(undefined),
      ),
    );

  const putVersioning = (bucket: string, region: string, enabled: boolean | undefined) =>
    enabled === undefined
      ? Effect.void
      : Effect.gen(function* () {
          const response = yield* request(bucket, region, "PUT", "/?versioning", {
            body: xml(
              `<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>${enabled ? "Enabled" : "Suspended"}</Status></VersioningConfiguration>`,
            ),
            headers: { "content-type": "application/xml" },
          });
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
            const body = xml(
              `<Tagging><TagSet>${Object.entries(tags)
                .map(
                  ([key, value]) =>
                    `<Tag><Key>${escapeXml(key)}</Key><Value>${escapeXml(value)}</Value></Tag>`,
                )
                .join("")}</TagSet></Tagging>`,
            );
            const response = yield* request(bucket, region, "PUT", "/?tagging", {
              body,
              headers: { "content-type": "application/xml" },
            });
            yield* ensureOk(response, "PUT", "/?tagging");
          });

  return {
    createBucket: ({
      name,
      region,
      tags,
      versioning,
    }: {
      name: string;
      region: string;
      tags?: Record<string, string>;
      versioning?: boolean;
    }) =>
      Effect.gen(function* () {
        const response = yield* request(name, region, "PUT", "/", {
          body: xml(
            `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${escapeXml(region)}</LocationConstraint></CreateBucketConfiguration>`,
          ),
          headers: { "content-type": "application/xml" },
        });
        yield* ensureOk(response, "PUT", "/");
        yield* putVersioning(name, region, versioning);
        yield* putTags(name, region, tags);
        return yield* headBucket(name, region);
      }),
    getBucket: ({ name, region }: { name: string; region?: string }) =>
      headBucket(name, region ?? defaultRegion),
    updateBucket: ({
      name,
      region,
      tags,
      versioning,
    }: {
      name: string;
      region: string;
      tags?: Record<string, string>;
      versioning?: boolean;
    }) =>
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
const escapeXml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
const unescapeXml = (value: string) =>
  value
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
const messageFromBody = (body: unknown) =>
  typeof body === "object" && body !== null && "message" in body ? String(body.message) : undefined;
// The Containers v1 API returns resource objects at the top level (no envelope key).
const decodeNamespace = (value: unknown) => value as ScalewayNamespaceRecord;
const decodeContainer = (value: unknown) => value as ScalewayContainerRecord;
const decodeTrigger = (value: unknown) => value as ScalewayTriggerRecord;
const decodeDomain = (value: unknown) => value as ScalewayDomainRecord;
const decodeRegistryNamespace = (value: unknown) => value as ScalewayRegistryNamespaceRecord;
