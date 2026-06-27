import { Resource } from "alchemy";
import * as Bundle from "alchemy/Bundle";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { makeScalewayClients, type ScalewayFunctionRecord } from "./Clients.ts";
import type { ScalewayFunctionCronRecord, ScalewayFunctionDomainRecord } from "./Clients.ts";
import { isNotFound, ScalewayError, scalewayError } from "./Errors.ts";
import { omitUndefined, physicalName, recordEquals, resolveRef } from "./Internal.ts";
import type { FunctionCron as FunctionCronResource } from "./FunctionCron.ts";
import type { FunctionDomain as FunctionDomainResource } from "./FunctionDomain.ts";
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

export interface FunctionSourceBundle {
  main: string;
  hash?: string;
  build?: FunctionBuildOptions;
}

export interface FunctionBuildOptions extends Bundle.BundleExtraOptions {
  external?: string[];
  minify?: boolean;
  sourcemap?: boolean | "inline" | "hidden";
}

export type FunctionSource = FunctionSourceZip | FunctionSourceBundle;

export type FunctionDomain = string | { hostname: string };

export type FunctionCron = string | { schedule: string; args?: Record<string, unknown>; name?: string };

export interface FunctionProps {
  namespace: FunctionNamespaceRef;
  name?: string;
  runtime: string;
  handler?: string;
  source: FunctionSource;
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
  /** Custom domains to bind to this function. Standalone `FunctionDomain` remains available for explicit control. */
  domains?: FunctionDomain[];
  /** Cron triggers that invoke this function. Standalone `FunctionCron` remains available for explicit control. */
  crons?: FunctionCron[];
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
    domains?: FunctionDomainResource["Attributes"][];
    cronTriggers?: FunctionCronResource["Attributes"][];
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

const hashBytes = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");

const isZipSource = (source: FunctionSource): source is FunctionSourceZip => "zipPath" in source;

const sourceHash = (source: FunctionSource): Effect.Effect<string, Error> =>
  source.hash ? Effect.succeed(source.hash) : Effect.map(sourceArchive(source), (archive) => archive.hash);

const readZip = (source: FunctionSourceZip): Effect.Effect<Uint8Array, Error> =>
  Effect.tryPromise({
    try: () => readFile(source.zipPath),
    catch: (cause) => new Error(`Failed to read function ZIP ${source.zipPath}: ${String(cause)}`),
  });

const findBundleCwd = (entry: string) =>
  Effect.sync(() => {
    for (let current = dirname(entry); ; current = dirname(current)) {
      if (existsSync(join(current, "package.json"))) return current;
      if (dirname(current) === current) return process.cwd();
    }
  });

const zipCode = (content: string | Uint8Array, files?: ReadonlyArray<{ path: string; content: string | Uint8Array }>) =>
  Effect.tryPromise({
    try: async () => {
      const zip = new (await import("jszip")).default();
      const date = new Date("1980-01-01T00:00:00.000Z");
      zip.file("index.mjs", content, { date });
      for (const file of files ?? []) zip.file(file.path, file.content, { date });
      return new Uint8Array(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", platform: "UNIX" }));
    },
    catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
  });

const bundleSource = (source: FunctionSourceBundle): Effect.Effect<Uint8Array, Error> =>
  Effect.gen(function* () {
    const entry = yield* Effect.tryPromise({
      try: () => realpath(source.main),
      catch: (cause) => new Error(`Failed to resolve function entry ${source.main}: ${String(cause)}`),
    });
    const cwd = yield* findBundleCwd(entry);
    const output = yield* Bundle.build(
      {
        input: entry,
        cwd,
        external: source.build?.external,
        platform: "node",
      },
      {
        format: "esm",
        sourcemap: source.build?.sourcemap ?? true,
        minify: source.build?.minify ?? false,
        entryFileNames: "index.mjs",
        codeSplitting: false,
      },
      source.build,
    );
    const mainFile = output.files[0];
    const extraFiles = output.files
      .slice(1)
      .filter((file) => source.build?.sourcemap === true || source.build?.sourcemap === "hidden" || !file.path.endsWith(".map"))
      .map((file) => ({ path: file.path, content: file.content }));
    return yield* zipCode(mainFile.content, extraFiles.length > 0 ? extraFiles : undefined);
  }).pipe(Effect.mapError((cause) => cause instanceof Error ? cause : new Error(String(cause))));

const sourceArchive = (source: FunctionSource): Effect.Effect<{ body: Uint8Array; hash: string }, Error> =>
  Effect.gen(function* () {
    const body = yield* (isZipSource(source) ? readZip(source) : bundleSource(source));
    return { body, hash: source.hash ?? hashBytes(body) };
  });

function defaultHandler(source: FunctionSource) {
  return isZipSource(source) ? "handler.handle" : "index.handle";
}

function domainHostname(domain: FunctionDomain) {
  return typeof domain === "string" ? domain : domain.hostname;
}

function cronSchedule(cron: FunctionCron) {
  return typeof cron === "string" ? cron : cron.schedule;
}

function cronArgs(cron: FunctionCron) {
  return typeof cron === "string" ? undefined : cron.args;
}

function cronName(cron: FunctionCron) {
  return typeof cron === "string" ? undefined : cron.name;
}

function domainKey(domain: FunctionDomain) {
  return domainHostname(domain).toLowerCase();
}

function cronKey(cron: FunctionCron) {
  return JSON.stringify(cron);
}

function assertUnique(keys: string[], label: string) {
  const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);
  if (duplicates.length > 0) throw new Error(`Duplicate ${label}: ${duplicates.join(", ")}`);
}

function compact<T>(items: Array<T | undefined>) {
  return items.filter((item): item is T => item !== undefined);
}

function companionPropsEqual(olds: FunctionProps, news: FunctionProps) {
  return JSON.stringify(olds.domains ?? []) === JSON.stringify(news.domains ?? []) && JSON.stringify(olds.crons ?? []) === JSON.stringify(news.crons ?? []);
}

function companionsPresent(output: Function["Attributes"], news: FunctionProps) {
  return (output.domains?.length ?? 0) === (news.domains?.length ?? 0) && (output.cronTriggers?.length ?? 0) === (news.crons?.length ?? 0);
}

function isResourceAlreadyExists(error: unknown) {
  return error instanceof ScalewayError && error.statusCode === 409;
}

function cronMatches(record: ScalewayFunctionCronRecord, cron: FunctionCron) {
  return record.schedule === cronSchedule(cron) && record.name === cronName(cron) && JSON.stringify(record.args ?? {}) === JSON.stringify(cronArgs(cron) ?? {});
}

function cronNeedsReplace(existing: FunctionCronResource["Attributes"], cron: FunctionCron) {
  return (existing.args !== undefined && cronArgs(cron) === undefined) || (existing.name !== undefined && cronName(cron) === undefined);
}

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
      const toCronAttributes = (record: ScalewayFunctionCronRecord): FunctionCronResource["Attributes"] =>
        omitUndefined({
          cronId: record.id,
          functionId: record.function_id,
          schedule: record.schedule,
          args: record.args,
          name: record.name,
          status: record.status,
        }) as FunctionCronResource["Attributes"];
      const toDomainAttributes = (record: ScalewayFunctionDomainRecord): FunctionDomainResource["Attributes"] =>
        omitUndefined({
          domainId: record.id,
          functionId: record.function_id,
          hostname: record.hostname,
          url: record.url ?? `https://${record.hostname}`,
        }) as FunctionDomainResource["Attributes"];
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
      const waitForDeleted = (functionIdValue: string, session: { note(message: string): Effect.Effect<void> }) =>
        Effect.gen(function* () {
          while (true) {
            const record = yield* clients.functions.getFunction(functionIdValue).pipe(
              Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
            );
            if (!record) return;
            yield* session.note(`waiting function deletion status=${record.status ?? "unknown"}`);
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
            handler: news.handler ?? defaultHandler(news.source),
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
        (olds.handler ?? defaultHandler(olds.source)) === (news.handler ?? defaultHandler(news.source)) &&
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
      const waitForCronReady = (cronIdValue: string, session: { note(message: string): Effect.Effect<void> }) =>
        Effect.gen(function* () {
          while (true) {
            const record = yield* clients.functions.getCron(cronIdValue);
            const status = record.status?.toLowerCase();
            if (!status || status === "ready") return toCronAttributes(record);
            if (status === "error") throw new Error(`Scaleway function cron ${cronIdValue} entered error state`);
            yield* session.note(`waiting function cron ready status=${record.status ?? "unknown"}`);
            yield* Effect.sleep("1 second");
          }
        });
      const waitForDomainReady = (domainIdValue: string, session: { note(message: string): Effect.Effect<void> }) =>
        Effect.gen(function* () {
          while (true) {
            const record = yield* clients.functions.getDomain(domainIdValue);
            const status = record.status?.toLowerCase();
            if (!status || status === "ready") return toDomainAttributes(record);
            if (status === "error") throw new Error(record.error_message ?? `Scaleway function domain ${domainIdValue} entered error state`);
            yield* session.note(`waiting function domain ready status=${record.status ?? "unknown"}`);
            yield* Effect.sleep("3 seconds");
          }
        });
      const deploySource = (functionIdValue: string, archive: { body: Uint8Array; hash: string }, session: { note(message: string): Effect.Effect<void> }) =>
        Effect.gen(function* () {
          const upload = yield* clients.functions.getFunctionUploadUrl(functionIdValue, archive.body.byteLength);
          yield* uploadZip(upload.url, upload.headers, archive.body).pipe(
            Effect.mapError((cause) => scalewayError({ operation: "PUT function upload-url", cause })),
          );
          yield* session.note(`Uploaded Scaleway function ZIP ${functionIdValue}`);
          const deployed = yield* clients.functions.deployFunction(functionIdValue);
          yield* session.note(`Deployed Scaleway function ${functionIdValue}`);
          return deployed.status?.toLowerCase() === "ready"
            ? toAttributes(deployed, archive.hash)
            : yield* waitForReady(functionIdValue, archive.hash, session);
        });
      const provisionCompanions = (
        func: Function["Attributes"],
        news: FunctionProps,
        session: { note(message: string): Effect.Effect<void> },
      ) =>
        Effect.gen(function* () {
          assertUnique((news.domains ?? []).map(domainKey), "function domain");
          assertUnique((news.crons ?? []).map(cronKey), "function cron");
          const liveDomains = yield* clients.functions.listDomains(func.functionId);
          const liveCrons = yield* clients.functions.listCrons(func.functionId);
          const domains = yield* Effect.all(
            (news.domains ?? []).map((domain) =>
              Effect.gen(function* () {
                const hostname = domainHostname(domain);
                const existing = func.domains?.find((item) => item.hostname.toLowerCase() === hostname.toLowerCase());
                if (existing?.domainId) return existing;
                const live = liveDomains.find((item) => item.hostname.toLowerCase() === hostname.toLowerCase());
                if (live) return live.status?.toLowerCase() === "ready" ? toDomainAttributes(live) : yield* waitForDomainReady(live.id, session);
                const created = yield* clients.functions.createDomain({ function_id: func.functionId, hostname }).pipe(
                  Effect.catchIf(isResourceAlreadyExists, () =>
                    Effect.gen(function* () {
                      const recovered = (yield* clients.functions.listDomains(func.functionId)).find((item) => item.hostname.toLowerCase() === hostname.toLowerCase());
                      if (!recovered) return yield* Effect.fail(new Error(`Scaleway function domain ${hostname} already exists but could not be recovered`));
                      return recovered;
                    }),
                  ),
                );
                return created.status?.toLowerCase() === "ready" ? toDomainAttributes(created) : yield* waitForDomainReady(created.id, session);
              }),
            ),
          );
          yield* Effect.all(
            (func.domains ?? [])
              .filter((domain) => !(news.domains ?? []).some((desired) => domainKey(desired) === domain.hostname.toLowerCase()))
              .map((domain) => clients.functions.deleteDomain(domain.domainId).pipe(Effect.catchIf(isNotFound, () => Effect.void))),
          );
          const keptCronIndexes = new Set<number>();
          const cronTriggers = yield* Effect.all(
            (news.crons ?? []).map((cron, index) =>
              Effect.gen(function* () {
                const input = omitUndefined({
                  function_id: func.functionId,
                  schedule: cronSchedule(cron),
                  args: cronArgs(cron),
                  name: cronName(cron),
                });
                const existing = func.cronTriggers?.[index];
                keptCronIndexes.add(index);
                if (existing?.cronId) {
                  if (cronNeedsReplace(existing, cron)) {
                    yield* clients.functions.deleteCron(existing.cronId).pipe(Effect.catchIf(isNotFound, () => Effect.void));
                    const created = yield* clients.functions.createCron(input);
                    return created.status?.toLowerCase() === "ready" ? toCronAttributes(created) : yield* waitForCronReady(created.id, session);
                  }
                  const updated = yield* clients.functions.updateCron(existing.cronId, input);
                  return updated.status?.toLowerCase() === "ready" ? toCronAttributes(updated) : yield* waitForCronReady(existing.cronId, session);
                }
                const live = liveCrons.find((item) => cronMatches(item, cron));
                if (live) return live.status?.toLowerCase() === "ready" ? toCronAttributes(live) : yield* waitForCronReady(live.id, session);
                const created = yield* clients.functions.createCron(input);
                return created.status?.toLowerCase() === "ready" ? toCronAttributes(created) : yield* waitForCronReady(created.id, session);
              }),
            ),
          );
          yield* Effect.all(
            (func.cronTriggers ?? [])
              .filter((_, index) => !keptCronIndexes.has(index))
              .map((cron) => clients.functions.deleteCron(cron.cronId).pipe(Effect.catchIf(isNotFound, () => Effect.void))),
          );
          return omitUndefined({
            ...func,
            domains: domains.length > 0 ? domains : undefined,
            cronTriggers: cronTriggers.length > 0 ? cronTriggers : undefined,
          }) as Function["Attributes"];
        });

      return Function.Provider.of({
        stables: ["functionId", "namespaceId", "region", "url", "domainName"],
        list: () => Effect.succeed([]),
        diff: Effect.fnUntraced(function* ({ id, news, olds, output }) {
          if (!isResolved(news) || !output) return undefined;
          if ((yield* namespaceId(news.namespace)) !== output.namespaceId) return { action: "replace" } as const;
          const name = yield* nameOf(id, news.name);
          const resolvedPrivateNetworkId = yield* privateNetworkId(news.privateNetwork);
          if (output.name !== name || output.privateNetworkId !== resolvedPrivateNetworkId || !metadataEqual(olds, news) || !companionPropsEqual(olds, news) || !companionsPresent(output, news) || output.sourceHash !== (yield* sourceHash(news.source))) return { action: "update" } as const;
          return { action: "noop" } as const;
        }),
        read: Effect.fnUntraced(function* ({ output }) {
          if (!output?.functionId) return undefined;
          const func = yield* clients.functions.getFunction(output.functionId).pipe(
            Effect.map((record) => toAttributes(record, output.sourceHash)),
            Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
          );
          if (!func) return undefined;
          const domains = compact(yield* Effect.all((output.domains ?? []).map((domain) => clients.functions.getDomain(domain.domainId).pipe(Effect.map(toDomainAttributes), Effect.catchIf(isNotFound, () => Effect.succeed(undefined))))));
          const cronTriggers = compact(yield* Effect.all((output.cronTriggers ?? []).map((cron) => clients.functions.getCron(cron.cronId).pipe(Effect.map(toCronAttributes), Effect.catchIf(isNotFound, () => Effect.succeed(undefined))))));
          return omitUndefined({
            ...func,
            domains: domains.length > 0 ? domains : undefined,
            cronTriggers: cronTriggers.length > 0 ? cronTriggers : undefined,
          }) as Function["Attributes"];
        }),
        reconcile: Effect.fnUntraced(function* ({ id, news, olds, output, session }) {
          const hash = yield* sourceHash(news.source);
          if (output?.functionId) {
            yield* clients.functions.updateFunction(output.functionId, yield* inputFor(id, news, true, olds));
            yield* session.note(`Updated Scaleway function ${output.functionId}`);
            if (output.sourceHash === hash) {
              const deployed = yield* clients.functions.deployFunction(output.functionId);
              yield* session.note(`Deployed Scaleway function ${output.functionId}`);
              const ready = deployed.status?.toLowerCase() === "ready"
                ? toAttributes(deployed, hash)
                : yield* waitForReady(output.functionId, hash, session);
              return yield* provisionCompanions({ ...ready, domains: output.domains, cronTriggers: output.cronTriggers }, news, session);
            }
            const archive = yield* sourceArchive(news.source);
            const ready = yield* deploySource(output.functionId, archive, session);
            return yield* provisionCompanions({ ...ready, domains: output.domains, cronTriggers: output.cronTriggers }, news, session);
          }
          const created = yield* clients.functions.createFunction(yield* inputFor(id, news, false));
          yield* session.note(`Created Scaleway function ${created.id}`);
          const archive = yield* sourceArchive(news.source);
          const ready = yield* deploySource(created.id, archive, session);
          return yield* provisionCompanions(ready, news, session);
        }),
        delete: Effect.fnUntraced(function* ({ output, session }) {
          yield* Effect.all(
            (output.cronTriggers ?? []).map((cron) => clients.functions.deleteCron(cron.cronId).pipe(Effect.catchIf(isNotFound, () => Effect.void))),
          );
          yield* Effect.all(
            (output.domains ?? []).map((domain) => clients.functions.deleteDomain(domain.domainId).pipe(Effect.catchIf(isNotFound, () => Effect.void))),
          );
          yield* clients.functions
            .deleteFunction(output.functionId)
            .pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* waitForDeleted(output.functionId, session);
          yield* session.note(`Deleted Scaleway function ${output.functionId}`);
        }),
      });
    }),
  );
