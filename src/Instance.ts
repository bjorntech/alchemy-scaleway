import { Resource } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { createHash } from "node:crypto";
import { makeScalewayClients, type ScalewayInstanceRecord, type ScalewayInstanceVolumeRecord } from "./Clients.ts";
import { isNotFound } from "./Errors.ts";
import { omitUndefined, physicalName, projectId, resolveRef } from "./Internal.ts";
import type { FlexibleIp } from "./FlexibleIp.ts";
import type { Providers } from "./Providers.ts";
import type { SecurityGroup } from "./SecurityGroup.ts";

export type InstanceBootType = "local" | "bootscript" | "rescue";
export type InstanceDesiredState = "running" | "stopped";
export type InstancePublicIpRef = string | FlexibleIp;
export type InstanceSecurityGroupRef = string | SecurityGroup;

export interface InstanceVolume {
  id?: string;
  boot?: boolean;
  name?: string;
  size?: number;
  volumeType?: "l_ssd" | "scratch" | "sbs_volume" | "sbs_snapshot";
  baseSnapshot?: string;
  projectId?: string;
}

export interface InstanceProps {
  name?: string;
  zone?: string;
  projectId?: string;
  commercialType: string;
  image?: string;
  volumes?: Record<string, InstanceVolume>;
  tags?: string[];
  dynamicIpRequired?: boolean;
  routedIpEnabled?: boolean;
  publicIps?: InstancePublicIpRef[];
  bootType?: InstanceBootType;
  securityGroup?: InstanceSecurityGroupRef;
  placementGroupId?: string | null;
  protected?: boolean;
  desiredState?: InstanceDesiredState;
  /**
   * First-boot cloud-init user data. Written to Scaleway's `cloud-init` user-data
   * key before the first boot. The script itself is never returned in attributes;
   * only a SHA-256 hash is persisted for replacement diffing.
   */
  cloudInit?: string | Redacted.Redacted<string>;
}

export type Instance = Resource<
  "Scaleway.Instance",
  InstanceProps,
  {
    serverId: string;
    name: string;
    zone: string;
    projectId?: string;
    commercialType: string;
    imageId?: string;
    imageName?: string;
    state?: string;
    tags?: string[];
    dynamicIpRequired?: boolean;
    routedIpEnabled?: boolean;
    bootType?: string;
    protected?: boolean;
    publicIpIds?: string[];
    publicIpAddresses?: string[];
    securityGroupId?: string;
    placementGroupId?: string;
    dns?: string;
    volumes?: Record<string, InstanceVolume>;
    cloudInitHash?: string;
    createdVolumeIds?: string[];
  },
  never,
  Providers
>;

export const Instance = Resource<Instance>("Scaleway.Instance");

const stringsEqual = (left?: string[], right?: string[]) => JSON.stringify([...(left ?? [])].sort()) === JSON.stringify([...(right ?? [])].sort());
const withAlchemyTag = (id: string, tags: string[] | undefined) => [`alchemy:logical-id=${id}`, ...(tags ?? [])];
const zoneOf = (region: string, zone?: string) => zone ?? `${region}-1`;
const volumesInput = (volumes: Record<string, InstanceVolume> | undefined) =>
  Object.fromEntries(
    Object.entries(volumes ?? {}).map(([key, volume]) => [
      key,
      omitUndefined({
        id: volume.id,
        boot: volume.boot,
        name: volume.name,
        size: volume.size,
        volume_type: volume.volumeType,
        base_snapshot: volume.baseSnapshot,
        project: volume.projectId,
      }),
    ]),
  );
const volumeOutput = (volume: ScalewayInstanceVolumeRecord): InstanceVolume =>
  omitUndefined({
    id: volume.id,
    boot: volume.boot,
    name: volume.name ?? undefined,
    size: volume.size ?? undefined,
    volumeType: volume.volume_type as InstanceVolume["volumeType"],
    projectId: volume.project ?? undefined,
  }) as InstanceVolume;
const volumesOutput = (volumes: Record<string, ScalewayInstanceVolumeRecord> | undefined, requested?: Record<string, InstanceVolume>) =>
  Object.fromEntries(Object.entries(volumes ?? {}).map(([key, volume]) => [key, { ...requested?.[key], ...volumeOutput(volume) }]));
const createdVolumeIds = (volumes: Record<string, ScalewayInstanceVolumeRecord> | undefined, requested?: Record<string, InstanceVolume>, previous?: string[]) => {
  const entries = Object.entries(volumes ?? {});
  if (previous) {
    const current = new Set(entries.map(([, volume]) => volume.id).filter(isString));
    return previous.filter((id) => current.has(id));
  }
  return entries.flatMap(([key, volume]) => volume.id && requested?.[key]?.id === undefined ? [volume.id] : []);
};
const createdSbsVolumeIds = (volumes: Record<string, InstanceVolume> | undefined, createdIds: string[] | undefined) => {
  const created = new Set(createdIds ?? []);
  return Object.values(volumes ?? {}).flatMap((volume) => volume.id && volume.volumeType === "sbs_volume" && created.has(volume.id) ? [volume.id] : []);
};
const replacementVolumeFields = ["id", "boot", "name", "size", "volumeType", "projectId"] as const;
const volumeChanged = (desired: InstanceVolume, current: InstanceVolume | undefined) =>
  desired.baseSnapshot !== current?.baseSnapshot || replacementVolumeFields.some((field) => desired[field] !== undefined && desired[field] !== current?.[field]);
const volumesNeedReplace = (desired: Record<string, InstanceVolume> | undefined, current: Record<string, InstanceVolume> | undefined) =>
  desired !== undefined && (!stringsEqual(Object.keys(desired), Object.keys(current ?? {})) || Object.entries(desired).some(([key, volume]) => volumeChanged(volume, current?.[key])));
const targetState = (state: InstanceDesiredState | undefined) => (state === "stopped" ? "stopped" : state);
const targetStateFor = (state: InstanceDesiredState | undefined, cloudInit: string | undefined) => targetState(state) ?? (cloudInit === undefined ? undefined : "running");
const publicIpIdOf = (publicIp: InstancePublicIpRef) => resolveRef(typeof publicIp === "string" ? publicIp : publicIp.ipId);
const securityGroupIdOf = (securityGroup: InstanceSecurityGroupRef) => {
  return resolveRef(typeof securityGroup === "string" ? securityGroup : securityGroup.securityGroupId);
};
const isString = (value: string | undefined): value is string => value !== undefined;
const isPreconditionError = (error: unknown) => String((error as { message?: unknown })?.message ?? "").toLowerCase().includes("precondition is not respected");
function managedPublicIpIdsFromRecord(record: ScalewayInstanceRecord) {
  return (record.public_ips ?? []).filter((ip) => ip.dynamic !== true).map((ip) => ip.id).filter(isString);
}
const cloudInitValue = (value: InstanceProps["cloudInit"]) => value === undefined ? undefined : Redacted.isRedacted(value) ? Redacted.value(value) : value;
const cloudInitHash = (value: InstanceProps["cloudInit"]) => {
  const unwrapped = cloudInitValue(value);
  return unwrapped === undefined ? undefined : `sha256:${createHash("sha256").update(unwrapped).digest("hex")}`;
};

// @crap-ignore: provider factory wraps lifecycle closures scored separately.
export const InstanceProvider = () =>
  Provider.effect(
    Instance,
    Effect.gen(function* () {
      const clients = yield* makeScalewayClients;
      const nameOf = (id: string, name?: string) => physicalName(id, name, { maxLength: 255 });
      const publicIpIdsOf = (refs: InstancePublicIpRef[] | undefined) => Effect.all((refs ?? []).map(publicIpIdOf));
      const waitForState = (zone: string, serverId: string, state: string, attempts = 20) =>
        Effect.gen(function* () {
          for (let attempt = 0; attempt < attempts; attempt++) {
            const record = yield* clients.instance.getInstance({ zone, serverId });
            if (record.state === state) return record;
            yield* Effect.sleep("1 second");
          }
          throw new Error(`Timed out waiting for Scaleway instance ${serverId} to become ${state}`);
        });
      const waitForPublicIps = (zone: string, serverId: string, publicIps: string[], attempts = 20) =>
        Effect.gen(function* () {
          for (let attempt = 0; attempt < attempts; attempt++) {
            const record = yield* clients.instance.getInstance({ zone, serverId });
            if (stringsEqual(managedPublicIpIdsFromRecord(record), publicIps)) return record;
            yield* Effect.sleep("2 seconds");
          }
          throw new Error(`Timed out waiting for Scaleway instance ${serverId} public IP attachments`);
        });
      const waitForDeleted = (zone: string, serverId: string, attempts = 60) =>
        Effect.gen(function* () {
          for (let attempt = 0; attempt < attempts; attempt++) {
            const existing = yield* clients.instance.getInstance({ zone, serverId }).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
            if (!existing) return;
            yield* Effect.sleep("1 second");
          }
          throw new Error(`Timed out waiting for Scaleway instance ${serverId} to be deleted`);
        });
      const retryDeleteVolume = (zone: string, volumeId: string, attempts = 30): Effect.Effect<void, unknown> =>
        clients.instance.deleteVolume({ zone, volumeId }).pipe(
          Effect.catchIf(isNotFound, () => Effect.void),
          Effect.catchIf((error) => attempts > 1 && isPreconditionError(error), () => Effect.sleep("2 seconds").pipe(Effect.flatMap(() => retryDeleteVolume(zone, volumeId, attempts - 1)))),
        );
      const toAttributes = (record: ScalewayInstanceRecord, requestedVolumes?: Record<string, InstanceVolume>, requestedImage?: string, requestedCloudInitHash?: string, previousCreatedVolumeIds?: string[]): Instance["Attributes"] =>
        omitUndefined({
          serverId: record.id,
          name: record.name,
          zone: record.zone ?? clients.region,
          projectId: record.project,
          commercialType: record.commercial_type,
          imageId: record.image?.id,
          imageName: requestedImage ?? record.image?.name,
          state: record.state,
          tags: record.tags,
          dynamicIpRequired: record.dynamic_ip_required,
          routedIpEnabled: record.routed_ip_enabled,
          bootType: record.boot_type,
          protected: record.protected,
          publicIpIds: managedPublicIpIdsFromRecord(record),
          publicIpAddresses: record.public_ips?.map((ip) => ip.address).filter((address): address is string => address !== undefined),
          securityGroupId: record.security_group?.id,
          placementGroupId: record.placement_group?.id,
          dns: record.dns ?? undefined,
          volumes: volumesOutput(record.volumes, requestedVolumes),
          cloudInitHash: requestedCloudInitHash,
          createdVolumeIds: createdVolumeIds(record.volumes, requestedVolumes, previousCreatedVolumeIds),
        }) as Instance["Attributes"];

      return Instance.Provider.of({
        stables: ["serverId", "zone", "projectId"],
        diff: Effect.fnUntraced(function* ({ id, news, output }) {
          if (!isResolved(news) || !output) return undefined;
          if (output.zone !== zoneOf(clients.region, news.zone)) return { action: "replace" } as const;
          if (output.projectId !== (yield* projectId(news.projectId))) return { action: "replace" } as const;
          if (output.commercialType !== news.commercialType) return { action: "replace" } as const;
          if (news.image && output.imageName !== news.image && output.imageId !== news.image) return { action: "replace" } as const;
          if (volumesNeedReplace(news.volumes, output.volumes)) return { action: "replace" } as const;
          if (cloudInitHash(news.cloudInit) !== output.cloudInitHash) return { action: "replace" } as const;

          const name = yield* nameOf(id, news.name);
          const publicIpIds = news.publicIps === undefined ? output.publicIpIds : yield* publicIpIdsOf(news.publicIps);
          const securityGroupId = news.securityGroup === undefined ? output.securityGroupId : yield* securityGroupIdOf(news.securityGroup);
          const placementGroupId = news.placementGroupId === null ? undefined : (news.placementGroupId ?? output.placementGroupId);
          const desiredState = targetStateFor(news.desiredState, cloudInitValue(news.cloudInit));
          if (news.routedIpEnabled === false && output.routedIpEnabled) throw new Error("Scaleway routed IP mode cannot be disabled once enabled.");
          if (
            output.name !== name ||
            !stringsEqual(output.tags, withAlchemyTag(id, news.tags)) ||
            news.dynamicIpRequired !== undefined && output.dynamicIpRequired !== news.dynamicIpRequired ||
            news.routedIpEnabled !== undefined && output.routedIpEnabled !== news.routedIpEnabled ||
            output.bootType !== (news.bootType ?? output.bootType) ||
            output.protected !== (news.protected ?? false) ||
            !stringsEqual(output.publicIpIds, publicIpIds) ||
            output.securityGroupId !== securityGroupId ||
            output.placementGroupId !== placementGroupId ||
            (desiredState !== undefined && output.state !== desiredState)
          ) return { action: "update" } as const;
          return undefined;
        }),
        read: Effect.fnUntraced(function* ({ output }) {
          if (!output?.serverId) return undefined;
          return yield* clients.instance.getInstance({ zone: output.zone, serverId: output.serverId }).pipe(
            Effect.map((record) => toAttributes(record, output.volumes, output.imageName, output.cloudInitHash, output.createdVolumeIds)),
            Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
          );
        }),
        reconcile: Effect.fnUntraced(function* ({ id, news, output, session }) {
          const zone = zoneOf(clients.region, news.zone);
          const name = yield* nameOf(id, news.name);
          const publicIps = news.publicIps === undefined ? undefined : yield* publicIpIdsOf(news.publicIps);
          const securityGroup = news.securityGroup === undefined ? undefined : yield* securityGroupIdOf(news.securityGroup);
          const init = cloudInitValue(news.cloudInit);
          const initHash = cloudInitHash(news.cloudInit);
          let record = output?.serverId
            ? yield* clients.instance.updateInstance({
                zone,
                serverId: output.serverId,
                name,
                tags: withAlchemyTag(id, news.tags),
                dynamic_ip_required: news.dynamicIpRequired,
                routed_ip_enabled: news.routedIpEnabled,
                boot_type: news.bootType,
                security_group: securityGroup ? { id: securityGroup } : undefined,
                placement_group: news.placementGroupId,
                protected: news.protected ?? false,
              })
            : yield* clients.instance.createInstance({
                zone,
                name,
                project: yield* projectId(news.projectId),
                commercial_type: news.commercialType,
                image: news.image,
                volumes: news.volumes ? volumesInput(news.volumes) : undefined,
                tags: withAlchemyTag(id, news.tags),
                dynamic_ip_required: news.dynamicIpRequired,
                routed_ip_enabled: news.routedIpEnabled,
                public_ips: publicIps,
                boot_type: news.bootType,
                security_group: typeof securityGroup === "string" ? securityGroup : undefined,
                placement_group: news.placementGroupId,
                protected: news.protected ?? false,
              });
          if (!output?.serverId && init !== undefined) {
            yield* clients.instance.setInstanceUserData({ zone, serverId: record.id, key: "cloud-init", value: init });
          }
          const desiredState = targetStateFor(news.desiredState, init);
          if (desiredState === "stopped" && record.state !== "stopped") {
            yield* clients.instance.instanceAction({ zone, serverId: record.id, action: "poweroff" }).pipe(Effect.catchIf(isPreconditionError, () => Effect.void));
            record = yield* waitForState(zone, record.id, "stopped", 60);
          }
          if (output?.serverId && publicIps !== undefined) {
            const currentPublicIps = managedPublicIpIdsFromRecord(record);
            for (const publicIp of currentPublicIps.filter((publicIp) => !publicIps.includes(publicIp))) {
              yield* clients.instance.updateFlexibleIp({ zone, ip: publicIp, server: null });
            }
            for (const publicIp of publicIps.filter((publicIp) => !currentPublicIps.includes(publicIp))) {
              yield* clients.instance.updateFlexibleIp({ zone, ip: publicIp, server: record.id });
            }
            record = yield* waitForPublicIps(zone, record.id, publicIps);
          }
          if (desiredState === "running" && record.state !== "running") {
            yield* clients.instance.instanceAction({ zone, serverId: record.id, action: "poweron" });
            record = yield* waitForState(zone, record.id, "running");
          }
          yield* session.note(`${output?.serverId ? "Updated" : "Created"} Scaleway instance ${record.id}`);
          return toAttributes(record, news.volumes, news.image, initHash);
        }),
        delete: Effect.fnUntraced(function* ({ output, session }) {
          const current = yield* clients.instance.getInstance({ zone: output.zone, serverId: output.serverId }).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
          const volumesToDelete = createdSbsVolumeIds(output.volumes, output.createdVolumeIds);
          if (current) {
            yield* clients.instance.updateInstance({ zone: output.zone, serverId: output.serverId, protected: false }).pipe(Effect.catchIf(isNotFound, () => Effect.void));
            for (const publicIp of managedPublicIpIdsFromRecord(current)) {
              yield* clients.instance.updateFlexibleIp({ zone: output.zone, ip: publicIp, server: null }).pipe(Effect.catchIf(isNotFound, () => Effect.void));
            }
            if (current.state === "stopped" || current.state === "stopped in place") {
              yield* clients.instance.deleteInstance({ zone: output.zone, serverId: output.serverId }).pipe(Effect.catchIf(isNotFound, () => Effect.void));
            } else {
              yield* clients.instance.instanceAction({ zone: output.zone, serverId: output.serverId, action: "terminate" }).pipe(Effect.catchIf(isNotFound, () => Effect.void));
            }
            yield* waitForDeleted(output.zone, output.serverId).pipe(Effect.catchIf(isNotFound, () => Effect.void));
          } else {
            yield* clients.instance.deleteInstance({ zone: output.zone, serverId: output.serverId }).pipe(Effect.catchIf(isNotFound, () => Effect.void));
          }
          for (const volumeId of volumesToDelete) {
            yield* retryDeleteVolume(output.zone, volumeId);
          }
          yield* session.note(`Deleted Scaleway instance ${output.serverId}`);
        }),
      });
    }),
  );
