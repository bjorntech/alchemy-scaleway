import { Resource } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { makeScalewayClients, type ScalewayFunctionRecord } from "./Clients.ts";
import { isNotFound, ScalewayError, scalewayError } from "./Errors.ts";
import { omitUndefined, physicalName, recordEquals, resolveRef } from "./Internal.ts";
import type { FunctionNamespace } from "./FunctionNamespace.ts";
import type { PrivateNetwork } from "./PrivateNetwork.ts";
import type { Providers } from "./Providers.ts";

export type FunctionNamespaceRef = string | FunctionNamespace;
export type FunctionPrivateNetworkRef = string | PrivateNetwork;
export type FunctionPrivacy = "public" | "private";
export type FunctionHttpOption = "enabled" | "redirected";
export type FunctionSandbox = "v1" | "v2";

export interface FunctionSourceZip {
  zipPath: string;
  hash?: string;
}

export interface FunctionProps {
  namespace: FunctionNamespaceRef;
  name?: string;
  runtime: string;
  handler: string;
  source: FunctionSourceZip;
  environmentVariables?: Record<string, string>;
  secretEnvironmentVariables?: Record<string, string | Redacted.Redacted<string>>;
  minScale?: number;
  maxScale?: number;
  memoryLimit?: number;
  timeout?: string;
  privacy?: FunctionPrivacy;
  description?: string;
  httpOption?: FunctionHttpOption;
  sandbox?: FunctionSandbox;
  tags?: string[];
  privateNetwork?: FunctionPrivateNetworkRef;
}

export type Function = Resource<
  "Scaleway.Function",
  FunctionProps,
  {
    functionId: string;
    namespaceId: string;
    name: string;
    region: string;
    runtime?: string;
    handler?: string;
    status?: string;
    url?: string;
    domainName?: string;
    sourceHash: string;
    privacy?: string;
    privateNetworkId?: string;
  },
  never,
  Providers
>;

export const Function = Resource<Function>("Scaleway.Function");

class FunctionDeployFailed extends Data.TaggedError("Scaleway.FunctionDeployFailed")<{
  functionId: string;
  status: string;
  message?: string;
}> {}

function namespaceId(namespace: FunctionNamespaceRef) {
  return resolveRef(typeof namespace === "string" ? namespace : namespace.namespaceId);
}

function privateNetworkId(privateNetwork: FunctionPrivateNetworkRef | undefined) {
  return privateNetwork === undefined
    ? Effect.succeed(undefined)
    : resolveRef(typeof privateNetwork === "string" ? privateNetwork : privateNetwork.privateNetworkId);
}

function unredactSecrets(secrets: FunctionProps["secretEnvironmentVariables"]) {
  return secrets
    ? Object.entries(secrets).map(([key, value]) => ({
        key,
        value: Redacted.isRedacted(value) ? Redacted.value(value) : value,
      }))
    : undefined;
}

function updateSecrets(olds: FunctionProps["secretEnvironmentVariables"], news: FunctionProps["secretEnvironmentVariables"]) {
  const current = unredactSecrets(news) ?? [];
  const removed = Object.keys(olds ?? {})
    .filter((key) => !(key in (news ?? {})))
    .map((key) => ({ key }));
  const entries = [...current, ...removed];
  return entries.length > 0 ? entries : undefined;
}

function secretsEqual(left: FunctionProps["secretEnvironmentVariables"], right: FunctionProps["secretEnvironmentVariables"]) {
  return JSON.stringify(unredactSecrets(left) ?? []) === JSON.stringify(unredactSecrets(right) ?? []);
}

function tagsEqual(left: string[] | undefined, right: string[] | undefined) {
  return JSON.stringify([...(left ?? [])].sort()) === JSON.stringify([...(right ?? [])].sort());
}

const sourceHash = (source: FunctionSourceZip): Effect.Effect<string, Error> =>
  source.hash
    ? Effect.succeed(source.hash)
    : Effect.tryPromise({
        try: async () => createHash("sha256").update(await readFile(source.zipPath)).digest("hex"),
        catch: (cause) => new Error(`Failed to hash function ZIP ${source.zipPath}: ${String(cause)}`),
      });

const readZip = (source: FunctionSourceZip): Effect.Effect<Uint8Array, Error> =>
  Effect.tryPromise({
    try: () => readFile(source.zipPath),
    catch: (cause) => new Error(`Failed to read function ZIP ${source.zipPath}: ${String(cause)}`),
  });

const uploadZip = (url: string, headers: Record<string, string> | undefined, body: Uint8Array) =>
  Effect.tryPromise({
    try: async () => {
      const uploadBody = new Uint8Array(body).buffer;
      const response = await fetch(url, { method: "PUT", headers, body: uploadBody });
      if (!response.ok) {
        const error = new Error(`Function ZIP upload failed with status ${response.status}: ${await response.text()}`) as Error & { statusCode: number };
        error.statusCode = response.status;
        throw error;
      }
    },
    catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
  });

// @crap-ignore: provider factory wraps lifecycle closures scored separately.
export const FunctionProvider = () =>
  Provider.effect(
    Function,
    Effect.gen(function* () {
      const clients = yield* makeScalewayClients;
      const nameOf = (id: string, name?: string) => physicalName(id, name, { maxLength: 63 });
      const toAttributes = (record: ScalewayFunctionRecord, hash: string): Function["Attributes"] =>
        omitUndefined({
          functionId: record.id,
          namespaceId: record.namespace_id,
          name: record.name,
          region: clients.region,
          runtime: record.runtime,
          handler: record.handler,
          status: record.status,
          url: record.domain_name ? `https://${record.domain_name}` : undefined,
          domainName: record.domain_name,
          sourceHash: hash,
          privacy: record.privacy,
          privateNetworkId: record.private_network_id,
        }) as Function["Attributes"];
      const waitForReady = (functionIdValue: string, hash: string, session: { note(message: string): Effect.Effect<void> }) =>
        Effect.gen(function* () {
          while (true) {
            const record = yield* clients.functions.getFunction(functionIdValue);
            const status = record.status?.toLowerCase();
            if (status === "ready") return toAttributes(record, hash);
            if (status === "error") {
              return yield* new FunctionDeployFailed({
                functionId: functionIdValue,
                status: record.status ?? "unknown",
                message: record.error_message ?? record.build_message ?? record.runtime_message,
              });
            }
            yield* session.note(`waiting function ready status=${record.status ?? "unknown"}`);
            yield* Effect.sleep("2 seconds");
          }
        });
      const inputFor = (id: string, news: FunctionProps, update: boolean, olds?: FunctionProps) =>
        Effect.gen(function* () {
          const name = yield* nameOf(id, news.name);
          return omitUndefined({
            name,
            ...(update ? {} : { namespace_id: yield* namespaceId(news.namespace) }),
            environment_variables: news.environmentVariables,
            secret_environment_variables: update
              ? updateSecrets(olds?.secretEnvironmentVariables, news.secretEnvironmentVariables)
              : unredactSecrets(news.secretEnvironmentVariables),
            min_scale: news.minScale,
            max_scale: news.maxScale,
            runtime: news.runtime,
            memory_limit: news.memoryLimit,
            timeout: news.timeout,
            redeploy: false,
            handler: news.handler,
            privacy: news.privacy,
            description: news.description,
            http_option: news.httpOption,
            sandbox: news.sandbox,
            tags: news.tags,
            private_network_id: yield* privateNetworkId(news.privateNetwork),
          });
        });
      const metadataEqual = (olds: FunctionProps, news: FunctionProps) =>
        olds.runtime === news.runtime &&
        olds.handler === news.handler &&
        olds.minScale === news.minScale &&
        olds.maxScale === news.maxScale &&
        olds.memoryLimit === news.memoryLimit &&
        olds.timeout === news.timeout &&
        olds.privacy === news.privacy &&
        olds.description === news.description &&
        olds.httpOption === news.httpOption &&
        olds.sandbox === news.sandbox &&
        recordEquals(olds.environmentVariables, news.environmentVariables) &&
        secretsEqual(olds.secretEnvironmentVariables, news.secretEnvironmentVariables) &&
        tagsEqual(olds.tags, news.tags);
      const deploySource = (functionIdValue: string, news: FunctionProps, hash: string, session: { note(message: string): Effect.Effect<void> }) =>
        Effect.gen(function* () {
          const zip = yield* readZip(news.source);
          const upload = yield* clients.functions.getFunctionUploadUrl(functionIdValue, zip.byteLength);
          yield* uploadZip(upload.url, upload.headers, zip).pipe(
            Effect.mapError((cause) => scalewayError({ operation: "PUT function upload-url", cause })),
          );
          yield* session.note(`Uploaded Scaleway function ZIP ${functionIdValue}`);
          const deployed = yield* clients.functions.deployFunction(functionIdValue);
          yield* session.note(`Deployed Scaleway function ${functionIdValue}`);
          return deployed.status?.toLowerCase() === "ready"
            ? toAttributes(deployed, hash)
            : yield* waitForReady(functionIdValue, hash, session);
        });

      return Function.Provider.of({
        stables: ["functionId", "namespaceId", "region"],
        diff: Effect.fnUntraced(function* ({ id, news, olds, output }) {
          if (!isResolved(news) || !output) return undefined;
          if ((yield* namespaceId(news.namespace)) !== output.namespaceId) return { action: "replace" } as const;
          const name = yield* nameOf(id, news.name);
          const resolvedPrivateNetworkId = yield* privateNetworkId(news.privateNetwork);
          if (output.name !== name || output.privateNetworkId !== resolvedPrivateNetworkId || !metadataEqual(olds, news) || output.sourceHash !== (yield* sourceHash(news.source))) return { action: "update" } as const;
          return { action: "noop" } as const;
        }),
        read: Effect.fnUntraced(function* ({ output }) {
          if (!output?.functionId) return undefined;
          return yield* clients.functions.getFunction(output.functionId).pipe(
            Effect.map((record) => toAttributes(record, output.sourceHash)),
            Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
          );
        }),
        reconcile: Effect.fnUntraced(function* ({ id, news, olds, output, session }) {
          const hash = yield* sourceHash(news.source);
          if (output?.functionId) {
            yield* clients.functions.updateFunction(output.functionId, yield* inputFor(id, news, true, olds));
            yield* session.note(`Updated Scaleway function ${output.functionId}`);
            if (output.sourceHash === hash) {
              const deployed = yield* clients.functions.deployFunction(output.functionId);
              yield* session.note(`Deployed Scaleway function ${output.functionId}`);
              return deployed.status?.toLowerCase() === "ready"
                ? toAttributes(deployed, hash)
                : yield* waitForReady(output.functionId, hash, session);
            }
            return yield* deploySource(output.functionId, news, hash, session);
          }
          const created = yield* clients.functions.createFunction(yield* inputFor(id, news, false));
          yield* session.note(`Created Scaleway function ${created.id}`);
          return yield* deploySource(created.id, news, hash, session);
        }),
        delete: Effect.fnUntraced(function* ({ output, session }) {
          yield* clients.functions
            .deleteFunction(output.functionId)
            .pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* session.note(`Deleted Scaleway function ${output.functionId}`);
        }),
      });
    }),
  );
