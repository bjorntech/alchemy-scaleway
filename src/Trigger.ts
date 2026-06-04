import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import { isResolved } from "alchemy/Diff";
import * as Effect from "effect/Effect";
import {
  makeScalewayClients,
  type ScalewayCreateTriggerInput,
  type ScalewayTriggerRecord,
} from "./Clients.ts";
import { isNotFound } from "./Errors.ts";
import { omitUndefined, physicalName, resolveRef } from "./Internal.ts";
import type { Container } from "./Container.ts";
import type { Providers } from "./Providers.ts";

export type ContainerRef = string | Container;

export type TriggerSourceType = "cron" | "sqs" | "nats";
export type TriggerHttpMethod = "get" | "post" | "put" | "patch" | "delete";

const DEFAULT_TIMEZONE = "UTC";

/** Where the container is invoked from when the trigger fires. */
export interface TriggerDestination {
  /** Custom HTTP path to call on the container (e.g. "/my-trigger"). */
  httpPath?: string;
  /** HTTP method used to invoke the container. */
  httpMethod?: TriggerHttpMethod;
}

/** Scheduled (cron) source. */
export interface CronTriggerSource {
  type: "cron";
  /** UNIX cron schedule (e.g. "0 * * * *"). */
  schedule: string;
  /** tz database timezone for the schedule (e.g. "Europe/Paris"). Defaults to "UTC". */
  timezone?: string;
  /** Body sent to the container when the trigger fires. */
  body?: string;
  /** Headers sent to the container when the trigger fires. */
  headers?: Record<string, string>;
}

/** SQS queue source (Scaleway Messaging & Queuing or AWS-compatible SQS). */
export interface SqsTriggerSource {
  type: "sqs";
  queueUrl: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  endpoint?: string;
}

/** NATS subject source. */
export interface NatsTriggerSource {
  type: "nats";
  serverUrls: string[];
  subject: string;
  /** Contents of a NATS credentials file used to authenticate. */
  credentialsFileContent?: string;
}

export type TriggerSource = CronTriggerSource | SqsTriggerSource | NatsTriggerSource;

export interface TriggerProps {
  container: ContainerRef;
  /** Exactly one source — cron, sqs, or nats — drives the trigger. */
  source: TriggerSource;
  name?: string;
  description?: string;
  destination?: TriggerDestination;
}

export type Trigger = Resource<
  "Scaleway.Trigger",
  TriggerProps,
  {
    triggerId: string;
    containerId: string;
    sourceType: TriggerSourceType;
    name?: string;
    status?: string;
    /** cron sources only */
    schedule?: string;
    timezone?: string;
    /** sqs sources only */
    queueUrl?: string;
    /** nats sources only */
    subject?: string;
  },
  never,
  Providers
>;

export const Trigger = Resource<Trigger>("Scaleway.Trigger");

const containerId = (container: ContainerRef) => {
  return resolveRef(typeof container === "string" ? container : container.containerId);
};

const destinationConfig = (destination: TriggerDestination | undefined) =>
  destination
    ? {
        destination_config: omitUndefined({
          http_path: destination.httpPath,
          http_method: destination.httpMethod,
        }),
      }
    : {};

const sourceConfig = (source: TriggerSource): Partial<ScalewayCreateTriggerInput> => {
  switch (source.type) {
    case "cron":
      return {
        cron_config: omitUndefined({
          schedule: source.schedule,
          timezone: source.timezone ?? DEFAULT_TIMEZONE,
          body: source.body,
          headers: source.headers,
        }) as ScalewayTriggerRecord["cron_config"] & { schedule: string },
      };
    case "sqs":
      return {
        sqs_config: omitUndefined({
          queue_url: source.queueUrl,
          access_key_id: source.accessKeyId,
          secret_access_key: source.secretAccessKey,
          region: source.region,
          endpoint: source.endpoint,
        }),
      };
    case "nats":
      return {
        nats_config: omitUndefined({
          server_urls: source.serverUrls,
          subject: source.subject,
          credentials_file_content: source.credentialsFileContent,
        }),
      };
  }
};

function removed(oldValue: unknown, newValue: unknown) {
  if (newValue !== undefined) return false;
  return oldValue !== undefined;
}

const anyRemoved = (pairs: ReadonlyArray<readonly [unknown, unknown]>) =>
  pairs.some(([oldValue, newValue]) => removed(oldValue, newValue));

const destinationNeedsReplace = (olds: TriggerDestination | undefined, news: TriggerDestination | undefined) =>
  anyRemoved([
    [olds, news],
    [olds?.httpPath, news?.httpPath],
    [olds?.httpMethod, news?.httpMethod],
  ]);

const sourceNeedsReplace = (olds: TriggerSource, news: TriggerSource) => {
  if (olds.type !== news.type) return true;
  switch (olds.type) {
    case "cron":
      return anyRemoved([
        [olds.body, (news as CronTriggerSource).body],
        [olds.headers, (news as CronTriggerSource).headers],
      ]);
    case "sqs":
      return anyRemoved([
        [olds.region, (news as SqsTriggerSource).region],
        [olds.endpoint, (news as SqsTriggerSource).endpoint],
      ]);
    case "nats":
      return removed(olds.credentialsFileContent, (news as NatsTriggerSource).credentialsFileContent);
  }
};

// @crap-ignore: provider factory wraps lifecycle closures scored separately.
export const TriggerProvider = () =>
  Provider.effect(
    Trigger,
    Effect.gen(function* () {
      const clients = yield* makeScalewayClients;
      const nameOf = (id: string, name?: string) => physicalName(id, name, { maxLength: 63 });
      const toAttributes = (record: ScalewayTriggerRecord): Trigger["Attributes"] =>
        omitUndefined({
          triggerId: record.id,
          containerId: record.container_id,
          sourceType: record.source_type as TriggerSourceType,
          name: record.name,
          status: record.status,
          schedule: record.cron_config?.schedule,
          timezone: record.cron_config?.timezone,
          queueUrl: record.sqs_config?.queue_url,
          subject: record.nats_config?.subject,
        }) as Trigger["Attributes"];
      const waitForReady = (
        triggerIdValue: string,
        attempts = 20,
      ): Effect.Effect<Trigger["Attributes"], unknown> =>
        Effect.gen(function* () {
          for (let attempt = 0; attempt < attempts; attempt++) {
            const record = yield* clients.containers.getTrigger(triggerIdValue);
            const status = record.status?.toLowerCase();
            if (!status || status === "ready") return toAttributes(record);
            if (status === "error")
              throw new Error(`Scaleway trigger ${triggerIdValue} entered error state`);
            yield* Effect.sleep("1 second");
          }
          throw new Error(`Timed out waiting for Scaleway trigger ${triggerIdValue}`);
        });

      return Trigger.Provider.of({
        stables: ["triggerId", "containerId", "sourceType"],
        diff: Effect.fnUntraced(function* ({ id, news, olds, output }) {
          if (!isResolved(news) || !output) return undefined;
          const resolvedContainerId = yield* containerId(news.container);
          // Container and source type are identity; the source kind cannot change in place.
          if (
            resolvedContainerId !== output.containerId ||
            removed(olds.description, news.description) ||
            destinationNeedsReplace(olds.destination, news.destination) ||
            sourceNeedsReplace(olds.source, news.source)
          ) {
            return { action: "replace" } as const;
          }
          const name = yield* nameOf(id, news.name);
          if (
            output.name !== name ||
            olds.description !== news.description ||
            JSON.stringify(olds.destination ?? {}) !== JSON.stringify(news.destination ?? {}) ||
            JSON.stringify(olds.source) !== JSON.stringify(news.source)
          )
            return { action: "update" } as const;
          return undefined;
        }),
        read: Effect.fnUntraced(function* ({ output }) {
          if (!output?.triggerId) return undefined;
          return yield* clients.containers.getTrigger(output.triggerId).pipe(
            Effect.map(toAttributes),
            Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
          );
        }),
        reconcile: Effect.fnUntraced(function* ({ id, news, output, session }) {
          const name = yield* nameOf(id, news.name);
          const common = omitUndefined({ name, description: news.description });
          if (output?.triggerId) {
            const updated = yield* clients.containers.updateTrigger(output.triggerId, {
              ...common,
              ...destinationConfig(news.destination),
              ...sourceConfig(news.source),
            });
            yield* session.note(`Updated Scaleway trigger ${output.triggerId}`);
            return updated.status?.toLowerCase() === "ready"
              ? toAttributes(updated)
              : yield* waitForReady(output.triggerId);
          }
          const created = yield* clients.containers.createTrigger({
            container_id: yield* containerId(news.container),
            name,
            description: news.description,
            ...destinationConfig(news.destination),
            ...sourceConfig(news.source),
          });
          yield* session.note(`Created Scaleway trigger ${created.id}`);
          return yield* waitForReady(created.id);
        }),
        delete: Effect.fnUntraced(function* ({ output, session }) {
          yield* clients.containers
            .deleteTrigger(output.triggerId)
            .pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* session.note(`Deleted Scaleway trigger ${output.triggerId}`);
        }),
      });
    }),
  );
