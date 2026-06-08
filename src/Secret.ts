import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import { isResolved } from "alchemy/Diff";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Buffer } from "node:buffer";
import {
  makeScalewayClients,
  type ScalewaySecretEphemeralPolicy,
  type ScalewaySecretRecord,
  type ScalewaySecretVersionRecord,
} from "./Clients.ts";
import { isNotFound } from "./Errors.ts";
import { omitUndefined, physicalName, projectId, projectInput, withManagedProjectDefault, type ProjectRef } from "./Internal.ts";
import type { Providers } from "./Providers.ts";

export type SecretType =
  | "opaque"
  | "certificate"
  | "key_value"
  | "basic_credentials"
  | "database_credentials"
  | "ssh_key";

export interface SecretEphemeralPolicy {
  timeToLive?: string;
  expiresOnceAccessed?: boolean;
  action?: "delete" | "disable";
}

export interface SecretProps {
  name?: string;
  project?: ProjectRef;
  description?: string;
  tags?: string[];
  type?: SecretType;
  path?: string;
  keyId?: string;
  protected?: boolean;
  ephemeralPolicy?: SecretEphemeralPolicy;
  value?: Redacted.Redacted<string>;
  versionDescription?: string;
  disablePrevious?: boolean;
}

export type Secret = Resource<
  "Scaleway.Secret",
  SecretProps,
  {
    secretId: string;
    secretName: string;
    projectId: string;
    region: string;
    description?: string;
    tags?: string[];
    type?: string;
    path?: string;
    protected?: boolean;
    status?: string;
    versionCount?: number;
    latestRevision?: number;
    latestVersionStatus?: string;
    keyId?: string;
  },
  never,
  Providers
>;

export const Secret = withManagedProjectDefault(Resource<Secret>("Scaleway.Secret"));

const DEFAULT_TYPE: SecretType = "opaque";
const DEFAULT_PATH = "/";

const valueOf = (value: Redacted.Redacted<string> | undefined) =>
  value === undefined ? undefined : Redacted.value(value);

const valueChanged = (olds: SecretProps, news: SecretProps) =>
  valueOf(olds.value) !== valueOf(news.value);

const tagsEqual = (olds: string[] | undefined, news: string[] | undefined) =>
  JSON.stringify(olds ?? []) === JSON.stringify(news ?? []);

const policyEqual = (
  olds: SecretEphemeralPolicy | undefined,
  news: SecretEphemeralPolicy | undefined,
) => JSON.stringify(olds ?? {}) === JSON.stringify(news ?? {});

const apiPolicy = (
  policy: SecretEphemeralPolicy | undefined,
): ScalewaySecretEphemeralPolicy | undefined =>
  policy
    ? omitUndefined({
        time_to_live: policy.timeToLive,
        expires_once_accessed: policy.expiresOnceAccessed,
        action: policy.action,
      })
    : undefined;

function encodedValue(value: Redacted.Redacted<string>) {
  return Buffer.from(Redacted.value(value), "utf8").toString("base64");
}

// @crap-ignore: provider factory wraps lifecycle closures scored separately.
export const SecretProvider = () =>
  Provider.effect(
    Secret,
    Effect.gen(function* () {
      const clients = yield* makeScalewayClients;
      const nameOf = (id: string, name?: string) => physicalName(id, name, { maxLength: 255 });
      const toAttributes = (
        record: ScalewaySecretRecord,
        version?: ScalewaySecretVersionRecord,
      ): Secret["Attributes"] =>
        omitUndefined({
          secretId: record.id,
          secretName: record.name,
          projectId: record.project_id,
          region: clients.region,
          description: record.description ?? undefined,
          tags: record.tags,
          type: record.type,
          path: record.path,
          protected: record.protected,
          status: record.status,
          versionCount: record.version_count,
          latestRevision: version?.revision,
          latestVersionStatus: version?.status,
          keyId: record.key_id ?? undefined,
        }) as Secret["Attributes"];

      const latestVersion = (secretId: string) =>
        clients.secretManager
          .getVersion(secretId, "latest")
          .pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));

      const createVersion = (secretId: string, news: SecretProps) =>
        news.value === undefined
          ? Effect.succeed(undefined)
          : clients.secretManager.createVersion(
              secretId,
              omitUndefined({
                data: encodedValue(news.value),
                description: news.versionDescription,
                disable_previous: news.disablePrevious ?? true,
              }),
            );

      const syncVersion = (secretId: string, olds: SecretProps | undefined, news: SecretProps) =>
        valueChanged(olds ?? {}, news)
          ? news.value === undefined
            ? latestVersion(secretId)
            : createVersion(secretId, news)
          : latestVersion(secretId);

      const syncProtection = (record: ScalewaySecretRecord, protect: boolean | undefined) => {
        if (protect === undefined || record.protected === protect) return Effect.succeed(record);
        return protect
          ? clients.secretManager.protectSecret(record.id)
          : clients.secretManager.unprotectSecret(record.id);
      };

      return Secret.Provider.of({
        stables: ["secretId", "projectId", "region"],
        diff: Effect.fnUntraced(function* ({ id, news, olds, output }) {
          if (!isResolved(news) || !output) return undefined;
          const resolvedProjectId = yield* projectId(projectInput(news), output.projectId);
          if (resolvedProjectId !== output.projectId) return { action: "replace" } as const;
          if ((olds.type ?? DEFAULT_TYPE) !== (news.type ?? DEFAULT_TYPE)) {
            return { action: "replace" } as const;
          }
          if (olds.keyId !== news.keyId) return { action: "replace" } as const;
          const name = yield* nameOf(id, news.name);
          if (
            output.secretName !== name ||
            olds.description !== news.description ||
            !tagsEqual(olds.tags, news.tags) ||
            (olds.path ?? DEFAULT_PATH) !== (news.path ?? DEFAULT_PATH) ||
            olds.protected !== news.protected ||
            !policyEqual(olds.ephemeralPolicy, news.ephemeralPolicy) ||
            valueChanged(olds, news)
          ) {
            return { action: "update" } as const;
          }
          return { action: "update" } as const;
        }),
        read: Effect.fnUntraced(function* ({ output }) {
          if (!output?.secretId) return undefined;
          const record = yield* clients.secretManager
            .getSecret(output.secretId)
            .pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
          if (!record) return undefined;
          return toAttributes(record, yield* latestVersion(record.id));
        }),
        reconcile: Effect.fnUntraced(function* ({ id, news, olds, output, session }) {
          if (output?.secretId) {
            const updated = yield* clients.secretManager.updateSecret(
              output.secretId,
              omitUndefined({
                name: yield* nameOf(id, news.name),
                description: news.description,
                tags: news.tags,
                path: news.path,
                ephemeral_policy: apiPolicy(news.ephemeralPolicy),
              }),
            );
            const protectedSecret = yield* syncProtection(updated, news.protected);
            const version = yield* syncVersion(output.secretId, olds, news);
            const current = version?.latest
              ? yield* clients.secretManager.getSecret(output.secretId)
              : protectedSecret;
            yield* session.note(`Updated Scaleway secret ${output.secretId}`);
            return toAttributes(current, version);
          }

          const created = yield* clients.secretManager.createSecret(
            omitUndefined({
              name: yield* nameOf(id, news.name),
              project_id: yield* projectId(projectInput(news), output?.projectId),
              description: news.description,
              tags: news.tags,
              type: news.type ?? DEFAULT_TYPE,
              path: news.path ?? DEFAULT_PATH,
              key_id: news.keyId,
              protected: news.protected,
              ephemeral_policy: apiPolicy(news.ephemeralPolicy),
            }),
          );
          const version = yield* createVersion(created.id, news);
          const current = version ? yield* clients.secretManager.getSecret(created.id) : created;
          yield* session.note(`Created Scaleway secret ${created.id}`);
          return toAttributes(current, version);
        }),
        delete: Effect.fnUntraced(function* ({ output, session }) {
          if (output.protected) {
            yield* clients.secretManager
              .unprotectSecret(output.secretId)
              .pipe(Effect.catchIf(isNotFound, () => Effect.void));
          }
          const versions = yield* clients.secretManager
            .listVersions(output.secretId)
            .pipe(Effect.catchIf(isNotFound, () => Effect.succeed([])));
          for (const version of versions) {
            yield* clients.secretManager
              .deleteVersion(output.secretId, version.revision)
              .pipe(Effect.catchIf(isNotFound, () => Effect.void));
          }
          yield* clients.secretManager
            .deleteSecret(output.secretId)
            .pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* session.note(`Deleted Scaleway secret ${output.secretId}`);
        }),
      });
    }),
  );
