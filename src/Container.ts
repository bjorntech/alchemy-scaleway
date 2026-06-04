import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import { isResolved } from "alchemy/Diff";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { makeScalewayClients, type ScalewayContainerRecord } from "./Clients.ts";
import { isNotFound } from "./Errors.ts";
import { namespaceId, omitUndefined, physicalName, recordEquals, type NamedNamespace } from "./Internal.ts";
import type { Providers } from "./Providers.ts";

export type ContainerProtocol = "unknown_protocol" | "http1" | "h2c";
export type ContainerPrivacy = "public" | "private";
export type ContainerHttpOption = "enabled" | "redirected";

export interface SecretEnvironmentVariable {
  key: string;
  value: string;
}

export interface ContainerProps {
  namespace: NamedNamespace;
  name?: string;
  registryImage: string;
  environmentVariables?: Record<string, string>;
  secretEnvironmentVariables?: ReadonlyArray<SecretEnvironmentVariable>;
  minScale?: number;
  maxScale?: number;
  memoryLimit?: number;
  cpuLimit?: number;
  timeout?: number;
  privacy?: ContainerPrivacy;
  description?: string;
  maxConcurrency?: number;
  protocol?: ContainerProtocol;
  port?: number;
  httpOption?: ContainerHttpOption;
}

export type Container = Resource<
  "Scaleway.Container",
  ContainerProps,
  {
    containerId: string;
    namespaceId: string;
    name: string;
    registryImage?: string;
    region: string;
    projectId?: string;
    url?: string;
    domainName?: string;
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
  left: ReadonlyArray<SecretEnvironmentVariable> | undefined,
  right: ReadonlyArray<SecretEnvironmentVariable> | undefined,
) => JSON.stringify(left ?? []) === JSON.stringify(right ?? []);

const containerUrl = (record: ScalewayContainerRecord) =>
  record.endpoint ??
  (record.domain_name
    ? record.domain_name.startsWith("http")
      ? record.domain_name
      : `https://${record.domain_name}`
    : undefined);

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
          registryImage: record.registry_image,
          region: clients.region,
          projectId: record.project_id,
          url: containerUrl(record),
          domainName: record.domain_name,
          privacy: record.privacy,
        }) as Container["Attributes"];

      const waitForReady = (containerIdValue: string, attempts = 30): Effect.Effect<Container["Attributes"], unknown> =>
        Effect.gen(function* () {
          for (let attempt = 0; attempt < attempts; attempt++) {
            const record = yield* clients.containers.getContainer(containerIdValue);
            const status = record.status?.toLowerCase();
            if (status === "error" || status === "failed") {
              return yield* new ContainerDeployFailed({ containerId: containerIdValue, status: record.status ?? "unknown" });
            }
            if (containerUrl(record) || status === "ready") return toAttributes(record);
            yield* Effect.sleep("2 seconds");
          }
          throw new Error(`Timed out waiting for Scaleway container ${containerIdValue}`);
        });

      const inputFor = (id: string, news: ContainerProps) =>
        Effect.gen(function* () {
          const resolvedNamespaceId = yield* namespaceId(news.namespace);
          return omitUndefined({
            namespace_id: resolvedNamespaceId,
            name: yield* nameOf(id, news.name),
            registry_image: news.registryImage,
            environment_variables: news.environmentVariables,
            secret_environment_variables: news.secretEnvironmentVariables,
            min_scale: news.minScale,
            max_scale: news.maxScale,
            memory_limit: news.memoryLimit,
            cpu_limit: news.cpuLimit,
            timeout: news.timeout,
            privacy: news.privacy,
            description: news.description,
            max_concurrency: news.maxConcurrency,
            protocol: news.protocol,
            port: news.port,
            http_option: news.httpOption,
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
            olds.registryImage !== news.registryImage ||
            olds.description !== news.description ||
            olds.minScale !== news.minScale ||
            olds.maxScale !== news.maxScale ||
            olds.memoryLimit !== news.memoryLimit ||
            olds.cpuLimit !== news.cpuLimit ||
            olds.timeout !== news.timeout ||
            olds.privacy !== news.privacy ||
            olds.maxConcurrency !== news.maxConcurrency ||
            olds.protocol !== news.protocol ||
            olds.port !== news.port ||
            olds.httpOption !== news.httpOption ||
            !recordEquals(olds.environmentVariables, news.environmentVariables) ||
            !secretsEqual(olds.secretEnvironmentVariables, news.secretEnvironmentVariables)
          ) return { action: "update" } as const;
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
          const input = yield* inputFor(id, news);
          if (output?.containerId) {
            yield* clients.containers.updateContainer(output.containerId, input);
            yield* session.note(`Updated Scaleway container ${output.containerId}`);
            yield* clients.containers.deployContainer(output.containerId);
            yield* session.note(`Triggered deployment for Scaleway container ${output.containerId}`);
            return yield* waitForReady(output.containerId);
          }
          const created = yield* clients.containers.createContainer(input);
          yield* session.note(`Created Scaleway container ${created.id}`);
          yield* clients.containers.deployContainer(created.id);
          yield* session.note(`Triggered deployment for Scaleway container ${created.id}`);
          return yield* waitForReady(created.id);
        }),
        delete: Effect.fnUntraced(function* ({ output, session }) {
          yield* clients.containers.deleteContainer(output.containerId).pipe(
            Effect.catchIf(isNotFound, () => Effect.void),
          );
          yield* session.note(`Deleted Scaleway container ${output.containerId}`);
        }),
      });
    }),
  );
