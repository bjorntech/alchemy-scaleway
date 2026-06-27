import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import { isResolved } from "alchemy/Diff";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  makeScalewayClients,
  type ScalewayContainerRecord,
  type ScalewayDomainRecord,
  type ScalewayTriggerRecord,
} from "./Clients.ts";
import { isNotFound, ScalewayError } from "./Errors.ts";
import {
  namespaceId,
  omitUndefined,
  physicalName,
  recordEquals,
  resolveRef,
  type NamedNamespace,
} from "./Internal.ts";
import type { Domain as DomainResource } from "./Domain.ts";
import type { Providers } from "./Providers.ts";
import {
  type CronTriggerSource,
  type Trigger as TriggerResource,
  type TriggerDestination,
  destinationConfig,
  destinationNeedsReplace,
  removed,
  sourceConfig,
  sourceNeedsReplace,
} from "./Trigger.ts";
import type { ContainerImage as ContainerImageResource } from "./ContainerImage.ts";

export type ContainerProtocol = "unknown_protocol" | "http1" | "h2c";
export type ContainerPrivacy = "public" | "private";
const CONTAINER_NAME_MAX_LENGTH = 34;

export interface ContainerScalingOption {
  concurrentRequestsThreshold?: number;
  cpuUsageThreshold?: number;
  memoryUsageThreshold?: number;
}

export type ContainerDomain = string | { hostname: string };

export type ContainerCron =
  | string
  | (Omit<CronTriggerSource, "type" | "schedule"> & {
      schedule: string;
      name?: string;
      description?: string;
      destination?: TriggerDestination;
    });

export type ContainerImageRef = string | ContainerImageResource["Attributes"]["ref"];

export const externalImage = (registry: string, repository: string, tag = "latest") => `${registry}/${repository}:${tag}`;
export const ghcrImage = (repository: string, tag = "latest") => externalImage("ghcr.io", repository, tag);
export const dockerHubImage = (repository: string, tag = "latest") => externalImage("docker.io", repository, tag);

export interface ContainerProps {
  namespace: NamedNamespace;
  name?: string;
  image: ContainerImageRef;
  /**
   * Resolved image digest used to force a redeploy when a moving tag (e.g. `latest`)
   * points at new content. Wire this to `ContainerImageMirror.digest` or
   * `ContainerImage.digest` to redeploy on content changes without changing `image`.
   */
  imageDigest?: string;
  environmentVariables?: Record<string, string>;
  secretEnvironmentVariables?: Record<string, string | Redacted.Redacted<string>>;
  minScale?: number;
  maxScale?: number;
  memoryLimitBytes?: number;
  mvcpuLimit?: number;
  /** Max request duration before the container is stopped, as a duration string (e.g. "300s"). */
  timeout?: string;
  privacy?: ContainerPrivacy;
  description?: string;
  scalingOption?: ContainerScalingOption;
  protocol?: ContainerProtocol;
  port?: number;
  httpsConnectionsOnly?: boolean;
  /** Custom domains to bind to this container. Standalone `Domain` remains available for explicit control. */
  domains?: ContainerDomain[];
  /** Cron triggers that invoke this container. Standalone `Trigger` remains available for explicit control. */
  crons?: ContainerCron[];
}

export type Container = Resource<
  "Scaleway.Container",
  ContainerProps,
  {
    containerId: string;
    namespaceId: string;
    name: string;
    image?: string;
    imageDigest?: string;
    region: string;
    projectId?: string;
    url?: string;
    publicEndpoint?: string;
    privacy?: string;
    status?: string;
    domains?: DomainResource["Attributes"][];
    cronTriggers?: TriggerResource["Attributes"][];
  },
  never,
  Providers
>;

export const Container = Resource<Container>("Scaleway.Container");

class ContainerDeployFailed extends Data.TaggedError("Scaleway.ContainerDeployFailed")<{
  containerId: string;
  status: string;
}> {}

const secretsEqual = (
  left: ContainerProps["secretEnvironmentVariables"],
  right: ContainerProps["secretEnvironmentVariables"],
) => recordEquals(unredactSecrets(left), unredactSecrets(right));

const unredactSecrets = (secrets: ContainerProps["secretEnvironmentVariables"]) =>
  secrets
    ? Object.fromEntries(
        Object.entries(secrets).map(([key, value]) => [
          key,
          Redacted.isRedacted(value) ? Redacted.value(value) : value,
        ]),
      )
    : undefined;

const containerUrl = (record: ScalewayContainerRecord) =>
  record.public_endpoint
    ? record.public_endpoint.startsWith("http")
      ? record.public_endpoint
      : `https://${record.public_endpoint}`
    : undefined;

function domainHostname(domain: ContainerDomain) {
  if (typeof domain === "string") return domain;
  return domain.hostname;
}

function cronSource(cron: ContainerCron): CronTriggerSource {
  if (typeof cron === "string") return { type: "cron", schedule: cron };
  return { ...cron, type: "cron" };
}

function cronName(cron: ContainerCron) {
  if (typeof cron === "string") return undefined;
  return cron.name;
}

function cronDescription(cron: ContainerCron) {
  if (typeof cron === "string") return undefined;
  return cron.description;
}

function cronDestination(cron: ContainerCron) {
  if (typeof cron === "string") return undefined;
  return cron.destination;
}

function containerPropsEqual(olds: ContainerProps, news: ContainerProps) {
  return containerShapeEqual(olds, news) && containerConfigEqual(olds, news);
}

function containerShapeEqual(olds: ContainerProps, news: ContainerProps) {
  return (
    olds.description === news.description &&
    olds.privacy === news.privacy &&
    olds.protocol === news.protocol &&
    olds.port === news.port &&
    olds.httpsConnectionsOnly === news.httpsConnectionsOnly
  );
}

function containerConfigEqual(olds: ContainerProps, news: ContainerProps) {
  return scalingEqual(olds, news) && environmentEqual(olds, news);
}

const imageRef = (image: ContainerImageRef) => resolveRef(image);
const diffImageRef = (image: ContainerImageRef) =>
  image === undefined ? Effect.succeed(undefined) : imageRef(image);

function scalingEqual(olds: ContainerProps, news: ContainerProps) {
  return (
    olds.minScale === news.minScale &&
    olds.maxScale === news.maxScale &&
    olds.memoryLimitBytes === news.memoryLimitBytes &&
    olds.mvcpuLimit === news.mvcpuLimit &&
    olds.timeout === news.timeout &&
    JSON.stringify(olds.scalingOption ?? {}) === JSON.stringify(news.scalingOption ?? {})
  );
}

function environmentEqual(olds: ContainerProps, news: ContainerProps) {
  return (
    recordEquals(olds.environmentVariables, news.environmentVariables) &&
    secretsEqual(olds.secretEnvironmentVariables, news.secretEnvironmentVariables)
  );
}

function companionPropsEqual(olds: ContainerProps, news: ContainerProps) {
  return (
    JSON.stringify(olds.domains ?? []) === JSON.stringify(news.domains ?? []) &&
    JSON.stringify(olds.crons ?? []) === JSON.stringify(news.crons ?? [])
  );
}

function companionsPresent(output: Container["Attributes"], news: ContainerProps) {
  return (
    (output.domains?.length ?? 0) === (news.domains?.length ?? 0) &&
    (output.cronTriggers?.length ?? 0) === (news.crons?.length ?? 0)
  );
}

function cronKey(cron: ContainerCron) {
  return JSON.stringify(cron);
}

function domainKey(domain: ContainerDomain) {
  return domainHostname(domain).toLowerCase();
}

function compact<T>(items: Array<T | undefined>) {
  return items.filter((item): item is T => item !== undefined);
}

const isTransientState = (error: unknown) =>
  String((error as { message?: unknown })?.message ?? "")
    .toLowerCase()
    .includes("transient state");

const retryTransient = <A>(effect: Effect.Effect<A, ScalewayError>, session: { note(message: string): Effect.Effect<void> }): Effect.Effect<A, ScalewayError> =>
  effect.pipe(
    Effect.catch((error) =>
      isTransientState(error)
        ? session.note("waiting container operation status=transient").pipe(Effect.flatMap(() => Effect.sleep("5 seconds")), Effect.flatMap(() => retryTransient(effect, session)))
        : Effect.fail(error),
    ),
  );

function assertUnique(keys: string[], label: string) {
  const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);
  if (duplicates.length > 0) throw new Error(`Duplicate ${label}: ${duplicates.join(", ")}`);
}

function matchCronIndex(
  olds: ContainerProps | undefined,
  cron: ContainerCron,
  fallbackIndex: number,
  consumedIndexes: Set<number>,
) {
  const exactIndex = olds?.crons?.findIndex(
    (oldCron, index) => !consumedIndexes.has(index) && cronKey(oldCron) === cronKey(cron),
  );
  if (exactIndex !== undefined && exactIndex >= 0) return exactIndex;
  if (!consumedIndexes.has(fallbackIndex)) return fallbackIndex;
  return -1;
}

function cronNeedsReplace(oldCron: ContainerCron | undefined, newCron: ContainerCron) {
  if (!oldCron) return false;
  return (
    removed(cronDescription(oldCron), cronDescription(newCron)) ||
    destinationNeedsReplace(cronDestination(oldCron), cronDestination(newCron)) ||
    sourceNeedsReplace(cronSource(oldCron), cronSource(newCron))
  );
}

// @crap-ignore: provider factory wraps lifecycle closures scored separately.
export const ContainerProvider = () =>
  Provider.effect(
    Container,
    Effect.gen(function* () {
      const clients = yield* makeScalewayClients;
      const nameOf = (id: string, name?: string) =>
        Effect.gen(function* () {
          if (name && [...name].length > CONTAINER_NAME_MAX_LENGTH) {
            return yield* Effect.fail(
              new Error(
                `Scaleway container name must be ${CONTAINER_NAME_MAX_LENGTH} characters or fewer`,
              ),
            );
          }
          return yield* physicalName(id, name, { maxLength: CONTAINER_NAME_MAX_LENGTH });
        });
      const toAttributes = (record: ScalewayContainerRecord): Container["Attributes"] =>
        omitUndefined({
          containerId: record.id,
          namespaceId: record.namespace_id,
          name: record.name,
          image: record.image,
          region: clients.region,
          projectId: record.project_id,
          url: containerUrl(record),
          publicEndpoint: record.public_endpoint,
          privacy: record.privacy,
          status: record.status,
        }) as Container["Attributes"];
      const toDomainAttributes = (record: ScalewayDomainRecord): DomainResource["Attributes"] =>
        omitUndefined({
          domainId: record.id,
          containerId: record.container_id,
          hostname: record.hostname,
          url: `https://${record.hostname}`,
        }) as DomainResource["Attributes"];
      const toTriggerAttributes = (record: ScalewayTriggerRecord): TriggerResource["Attributes"] =>
        omitUndefined({
          triggerId: record.id,
          containerId: record.container_id,
          sourceType: record.source_type,
          name: record.name,
          status: record.status,
          schedule: record.cron_config?.schedule,
          timezone: record.cron_config?.timezone,
        }) as TriggerResource["Attributes"];

      const waitForReady = (
        containerIdValue: string,
        session: { note(message: string): Effect.Effect<void> },
      ): Effect.Effect<Container["Attributes"], unknown> =>
        Effect.gen(function* () {
          while (true) {
            const record = yield* clients.containers.getContainer(containerIdValue);
            const status = record.status?.toLowerCase();
            if (status === "error" || status === "failed") {
              return yield* new ContainerDeployFailed({
                containerId: containerIdValue,
                status: record.status ?? "unknown",
              });
            }
            if (containerUrl(record) || status === "ready") return toAttributes(record);
            yield* session.note(`waiting container ready status=${record.status ?? "unknown"}`);
            yield* Effect.sleep("2 seconds");
          }
        });

      const waitForDomainReady = (domainIdValue: string, session: { note(message: string): Effect.Effect<void> }) =>
        Effect.gen(function* () {
          while (true) {
            const record = yield* clients.containers.getDomain(domainIdValue);
            const status = record.status?.toLowerCase();
            if (!status || status === "ready") return toDomainAttributes(record);
            if (status === "error")
              throw new Error(
                record.error_message ?? `Scaleway domain ${domainIdValue} entered error state`,
              );
            yield* session.note(`waiting domain ready status=${record.status ?? "unknown"}`);
            yield* Effect.sleep("3 seconds");
          }
        });

      const waitForTriggerReady = (triggerIdValue: string, session: { note(message: string): Effect.Effect<void> }) =>
        Effect.gen(function* () {
          while (true) {
            const record = yield* clients.containers.getTrigger(triggerIdValue);
            const status = record.status?.toLowerCase();
            if (!status || status === "ready") return toTriggerAttributes(record);
            if (status === "error")
              throw new Error(`Scaleway trigger ${triggerIdValue} entered error state`);
            yield* session.note(`waiting trigger ready status=${record.status ?? "unknown"}`);
            yield* Effect.sleep("1 second");
          }
        });

      // CreateContainer takes namespace_id/name; UpdateContainer accepts neither.
      // UpdateContainer also uses the singular `https_connection_only` key, whereas
      // Create uses `https_connections_only`.
      const inputFor = (id: string, news: ContainerProps, update: boolean) =>
        Effect.gen(function* () {
          const resolvedNamespaceId = yield* namespaceId(news.namespace);
          const name = yield* nameOf(id, news.name);
          return omitUndefined({
            ...(update ? {} : { namespace_id: resolvedNamespaceId, name }),
            image: yield* imageRef(news.image),
            environment_variables: news.environmentVariables,
            secret_environment_variables: unredactSecrets(news.secretEnvironmentVariables),
            min_scale: news.minScale,
            max_scale: news.maxScale,
            memory_limit_bytes: news.memoryLimitBytes,
            mvcpu_limit: news.mvcpuLimit,
            timeout: news.timeout,
            privacy: news.privacy,
            description: news.description,
            protocol: news.protocol,
            port: news.port,
            [update ? "https_connection_only" : "https_connections_only"]:
              news.httpsConnectionsOnly,
            scaling_option: news.scalingOption
              ? omitUndefined({
                  concurrent_requests_threshold: news.scalingOption.concurrentRequestsThreshold,
                  cpu_usage_threshold: news.scalingOption.cpuUsageThreshold,
                  memory_usage_threshold: news.scalingOption.memoryUsageThreshold,
                })
              : undefined,
          });
        });

      const provisionCompanions = (
        container: Container["Attributes"],
        olds: ContainerProps | undefined,
        news: ContainerProps,
        session: { note(message: string): Effect.Effect<void> },
      ) =>
        Effect.gen(function* () {
          assertUnique((news.domains ?? []).map(domainKey), "container domain");
          assertUnique((news.crons ?? []).map(cronKey), "container cron");
          const domains = yield* Effect.all(
            (news.domains ?? []).map((domain) =>
              Effect.gen(function* () {
                const hostname = domainHostname(domain);
                const existing = container.domains?.find(
                  (item) => item.hostname.toLowerCase() === hostname.toLowerCase(),
                );
                if (existing?.domainId) return existing;
                const created = yield* clients.containers.createDomain({
                  container_id: container.containerId,
                  hostname,
                });
                return yield* waitForDomainReady(created.id, session);
              }),
            ),
          );
          yield* Effect.all(
            (container.domains ?? [])
              .filter(
                (domain) =>
                  !(news.domains ?? []).some(
                    (desired) => domainKey(desired) === domain.hostname.toLowerCase(),
                  ),
              )
              .map((domain) =>
                clients.containers
                  .deleteDomain(domain.domainId)
                  .pipe(Effect.catchIf(isNotFound, () => Effect.void)),
              ),
          );
          const keptCronIndexes = new Set<number>();
          const cronTriggers = yield* Effect.all(
            (news.crons ?? []).map((cron, index) =>
              Effect.gen(function* () {
                const common = omitUndefined({
                  name: cronName(cron),
                  description: cronDescription(cron),
                });
                const input = {
                  ...common,
                  ...destinationConfig(cronDestination(cron)),
                  ...sourceConfig(cronSource(cron)),
                };
                const matchedIndex = matchCronIndex(olds, cron, index, keptCronIndexes);
                const existing = container.cronTriggers?.[matchedIndex];
                const oldCron = olds?.crons?.[matchedIndex];
                if (matchedIndex >= 0) keptCronIndexes.add(matchedIndex);
                const replace = existing?.triggerId && cronNeedsReplace(oldCron, cron);
                if (replace) {
                  yield* clients.containers
                    .deleteTrigger(existing.triggerId)
                    .pipe(Effect.catchIf(isNotFound, () => Effect.void));
                } else if (existing?.triggerId) {
                  const updated = yield* clients.containers.updateTrigger(
                    existing.triggerId,
                    input,
                  );
                  return updated.status?.toLowerCase() === "ready"
                    ? toTriggerAttributes(updated)
                    : yield* waitForTriggerReady(existing.triggerId, session);
                }
                const created = yield* clients.containers.createTrigger({
                  container_id: container.containerId,
                  ...input,
                });
                return created.status?.toLowerCase() === "ready"
                  ? toTriggerAttributes(created)
                  : yield* waitForTriggerReady(created.id, session);
              }),
            ),
          );
          yield* Effect.all(
            (container.cronTriggers ?? [])
              .filter((_, index) => !keptCronIndexes.has(index))
              .map((trigger) =>
                clients.containers
                  .deleteTrigger(trigger.triggerId)
                  .pipe(Effect.catchIf(isNotFound, () => Effect.void)),
              ),
          );
          return omitUndefined({
            ...container,
            domains: domains.length > 0 ? domains : undefined,
            cronTriggers: cronTriggers.length > 0 ? cronTriggers : undefined,
          }) as Container["Attributes"];
        });

      return Container.Provider.of({
        stables: ["containerId", "namespaceId", "region", "projectId", "url", "publicEndpoint"],
        list: () => Effect.succeed([]),
        diff: Effect.fnUntraced(function* ({ id, news, olds, output }) {
          if (!isResolved(news) || !output) return undefined;
          const resolvedNamespaceId = yield* namespaceId(news.namespace);
          if (resolvedNamespaceId !== output.namespaceId) return { action: "replace" } as const;
          const name = yield* nameOf(id, news.name);
          const resolvedImage = yield* diffImageRef(news.image);
          if (
            output.name !== name ||
            resolvedImage === undefined ||
            output.image !== resolvedImage ||
            output.imageDigest !== news.imageDigest ||
            !containerPropsEqual(olds, news) ||
            !companionPropsEqual(olds, news) ||
            !companionsPresent(output, news)
          )
            return { action: "update" } as const;
          return undefined;
        }),
        read: Effect.fnUntraced(function* ({ output }) {
          if (!output?.containerId) return undefined;
          const container = yield* clients.containers.getContainer(output.containerId).pipe(
            Effect.map(toAttributes),
            Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
          );
          if (!container) return undefined;
          const domains = compact(
            yield* Effect.all(
              (output.domains ?? []).map((domain) =>
                clients.containers.getDomain(domain.domainId).pipe(
                  Effect.map(toDomainAttributes),
                  Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
                ),
              ),
            ),
          );
          const cronTriggers = compact(
            yield* Effect.all(
              (output.cronTriggers ?? []).map((trigger) =>
                clients.containers.getTrigger(trigger.triggerId).pipe(
                  Effect.map(toTriggerAttributes),
                  Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
                ),
              ),
            ),
          );
          return omitUndefined({
            ...container,
            imageDigest: output.imageDigest,
            domains: domains.length > 0 ? domains : undefined,
            cronTriggers: cronTriggers.length > 0 ? cronTriggers : undefined,
          }) as Container["Attributes"];
        }),
        reconcile: Effect.fnUntraced(function* ({ id, news, olds, output, session }) {
          // In v1, Create/Update automatically deploy the container; no separate deploy call.
          if (output?.containerId) {
            const ready = yield* Effect.gen(function* () {
              const input = yield* inputFor(id, news, true);
              if (
                olds &&
                containerPropsEqual(olds, news) &&
                output.image === input.image &&
                output.imageDigest === news.imageDigest
              )
                return toAttributes(yield* clients.containers.getContainer(output.containerId));
              yield* retryTransient(clients.containers.updateContainer(output.containerId, input), session);
              yield* session.note(`Updated Scaleway container ${output.containerId}`);
              return yield* waitForReady(output.containerId, session);
            });
            return yield* provisionCompanions(
              { ...ready, imageDigest: news.imageDigest, domains: output.domains, cronTriggers: output.cronTriggers },
              olds,
              news,
              session,
            );
          }
          const input = yield* inputFor(id, news, false);
          const created = yield* retryTransient(clients.containers.createContainer(input), session);
          yield* session.note(`Created Scaleway container ${created.id}`);
          const ready = yield* waitForReady(created.id, session);
          return yield* provisionCompanions({ ...ready, imageDigest: news.imageDigest }, undefined, news, session);
        }),
        delete: Effect.fnUntraced(function* ({ output, session }) {
          yield* Effect.all(
            (output.cronTriggers ?? []).map((trigger) =>
              clients.containers
                .deleteTrigger(trigger.triggerId)
                .pipe(Effect.catchIf(isNotFound, () => Effect.void)),
            ),
          );
          yield* Effect.all(
            (output.domains ?? []).map((domain) =>
              clients.containers
                .deleteDomain(domain.domainId)
                .pipe(Effect.catchIf(isNotFound, () => Effect.void)),
            ),
          );
          yield* clients.containers
            .deleteContainer(output.containerId)
            .pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* session.note(`Deleted Scaleway container ${output.containerId}`);
        }),
      });
    }),
  );
