import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import { isResolved } from "alchemy/Diff";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { makeScalewayClients, type ScalewayContainerRecord } from "./Clients.ts";
import { isNotFound } from "./Errors.ts";
import {
  namespaceId,
  omitUndefined,
  physicalName,
  recordEquals,
  type NamedNamespace,
} from "./Internal.ts";
import type { Providers } from "./Providers.ts";

export type ContainerProtocol = "unknown_protocol" | "http1" | "h2c";
export type ContainerPrivacy = "public" | "private";

export interface ContainerScalingOption {
  concurrentRequestsThreshold?: number;
  cpuUsageThreshold?: number;
  memoryUsageThreshold?: number;
}

export interface ContainerProps {
  namespace: NamedNamespace;
  name?: string;
  image: string;
  environmentVariables?: Record<string, string>;
  secretEnvironmentVariables?: Record<string, string>;
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
}

export type Container = Resource<
  "Scaleway.Container",
  ContainerProps,
  {
    containerId: string;
    namespaceId: string;
    name: string;
    image?: string;
    region: string;
    projectId?: string;
    url?: string;
    publicEndpoint?: string;
    privacy?: string;
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
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined,
) => recordEquals(left, right);

const containerUrl = (record: ScalewayContainerRecord) =>
  record.public_endpoint
    ? record.public_endpoint.startsWith("http")
      ? record.public_endpoint
      : `https://${record.public_endpoint}`
    : undefined;

// @crap-ignore: provider factory wraps lifecycle closures scored separately.
export const ContainerProvider = () =>
  Provider.effect(
    Container,
    Effect.gen(function* () {
      const clients = yield* makeScalewayClients;
      const nameOf = (id: string, name?: string) => physicalName(id, name, { maxLength: 63 });
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
        }) as Container["Attributes"];

      const waitForReady = (
        containerIdValue: string,
        attempts = 30,
      ): Effect.Effect<Container["Attributes"], unknown> =>
        Effect.gen(function* () {
          for (let attempt = 0; attempt < attempts; attempt++) {
            const record = yield* clients.containers.getContainer(containerIdValue);
            const status = record.status?.toLowerCase();
            if (status === "error" || status === "failed") {
              return yield* new ContainerDeployFailed({
                containerId: containerIdValue,
                status: record.status ?? "unknown",
              });
            }
            if (containerUrl(record) || status === "ready") return toAttributes(record);
            yield* Effect.sleep("2 seconds");
          }
          throw new Error(`Timed out waiting for Scaleway container ${containerIdValue}`);
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
            image: news.image,
            environment_variables: news.environmentVariables,
            secret_environment_variables: news.secretEnvironmentVariables,
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

      return Container.Provider.of({
        stables: ["containerId", "namespaceId", "region", "projectId"],
        diff: Effect.fnUntraced(function* ({ id, news, olds, output }) {
          if (!isResolved(news) || !output) return undefined;
          const resolvedNamespaceId = yield* namespaceId(news.namespace);
          if (resolvedNamespaceId !== output.namespaceId) return { action: "replace" } as const;
          const name = yield* nameOf(id, news.name);
          if (
            output.name !== name ||
            olds.image !== news.image ||
            olds.description !== news.description ||
            olds.minScale !== news.minScale ||
            olds.maxScale !== news.maxScale ||
            olds.memoryLimitBytes !== news.memoryLimitBytes ||
            olds.mvcpuLimit !== news.mvcpuLimit ||
            olds.timeout !== news.timeout ||
            olds.privacy !== news.privacy ||
            olds.protocol !== news.protocol ||
            olds.port !== news.port ||
            olds.httpsConnectionsOnly !== news.httpsConnectionsOnly ||
            JSON.stringify(olds.scalingOption ?? {}) !== JSON.stringify(news.scalingOption ?? {}) ||
            !recordEquals(olds.environmentVariables, news.environmentVariables) ||
            !secretsEqual(olds.secretEnvironmentVariables, news.secretEnvironmentVariables)
          )
            return { action: "update" } as const;
          return undefined;
        }),
        read: Effect.fnUntraced(function* ({ output }) {
          if (!output?.containerId) return undefined;
          return yield* clients.containers.getContainer(output.containerId).pipe(
            Effect.map(toAttributes),
            Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
          );
        }),
        reconcile: Effect.fnUntraced(function* ({ id, news, output, session }) {
          // In v1, Create/Update automatically deploy the container; no separate deploy call.
          if (output?.containerId) {
            const input = yield* inputFor(id, news, true);
            yield* clients.containers.updateContainer(output.containerId, input);
            yield* session.note(`Updated Scaleway container ${output.containerId}`);
            return yield* waitForReady(output.containerId);
          }
          const input = yield* inputFor(id, news, false);
          const created = yield* clients.containers.createContainer(input);
          yield* session.note(`Created Scaleway container ${created.id}`);
          return yield* waitForReady(created.id);
        }),
        delete: Effect.fnUntraced(function* ({ output, session }) {
          yield* clients.containers
            .deleteContainer(output.containerId)
            .pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* session.note(`Deleted Scaleway container ${output.containerId}`);
        }),
      });
    }),
  );
