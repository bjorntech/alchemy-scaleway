import { Resource } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
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
const replacementVolumeFields = ["id", "boot", "name", "size", "volumeType", "projectId"] as const;
const volumeChanged = (desired: InstanceVolume, current: InstanceVolume | undefined) =>
  desired.baseSnapshot !== current?.baseSnapshot || replacementVolumeFields.some((field) => desired[field] !== undefined && desired[field] !== current?.[field]);
const volumesNeedReplace = (desired: Record<string, InstanceVolume> | undefined, current: Record<string, InstanceVolume> | undefined) =>
  desired !== undefined && (!stringsEqual(Object.keys(desired), Object.keys(current ?? {})) || Object.entries(desired).some(([key, volume]) => volumeChanged(volume, current?.[key])));
const targetState = (state: InstanceDesiredState | undefined) => (state === "stopped" ? "stopped" : state);
const publicIpIdOf = (publicIp: InstancePublicIpRef) => resolveRef(typeof publicIp === "string" ? publicIp : publicIp.ipId);
const securityGroupIdOf = (securityGroup: InstanceSecurityGroupRef) => {
  return resolveRef(typeof securityGroup === "string" ? securityGroup : securityGroup.securityGroupId);
};
const isString = (value: string | undefined): value is string => value !== undefined;
function publicIpIdsFromRecord(record: ScalewayInstanceRecord) {
  return (record.public_ips ?? []).map((ip) => ip.id).filter(isString);
}

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
            if (stringsEqual(publicIpIdsFromRecord(record), publicIps)) return record;
            yield* Effect.sleep("2 seconds");
          }
          throw new Error(`Timed out waiting for Scaleway instance ${serverId} public IP attachments`);
        });
      const toAttributes = (record: ScalewayInstanceRecord, requestedVolumes?: Record<string, InstanceVolume>): Instance["Attributes"] =>
        omitUndefined({
          serverId: record.id,
          name: record.name,
          zone: record.zone ?? clients.region,
          projectId: record.project,
          commercialType: record.commercial_type,
          imageId: record.image?.id,
          imageName: record.image?.name,
          state: record.state,
          tags: record.tags,
          dynamicIpRequired: record.dynamic_ip_required,
          routedIpEnabled: record.routed_ip_enabled,
          bootType: record.boot_type,
          protected: record.protected,
          publicIpIds: record.public_ips?.map((ip) => ip.id).filter((id): id is string => id !== undefined),
          publicIpAddresses: record.public_ips?.map((ip) => ip.address).filter((address): address is string => address !== undefined),
          securityGroupId: record.security_group?.id,
          placementGroupId: record.placement_group?.id,
          dns: record.dns ?? undefined,
          volumes: volumesOutput(record.volumes, requestedVolumes),
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

          const name = yield* nameOf(id, news.name);
          const publicIpIds = news.publicIps === undefined ? output.publicIpIds : yield* publicIpIdsOf(news.publicIps);
          const securityGroupId = news.securityGroup === undefined ? output.securityGroupId : yield* securityGroupIdOf(news.securityGroup);
          const placementGroupId = news.placementGroupId === null ? undefined : (news.placementGroupId ?? output.placementGroupId);
          const desiredState = targetState(news.desiredState);
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
            Effect.map((record) => toAttributes(record, output.volumes)),
            Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
          );
        }),
        reconcile: Effect.fnUntraced(function* ({ id, news, output, session }) {
          const zone = zoneOf(clients.region, news.zone);
          const name = yield* nameOf(id, news.name);
          const publicIps = news.publicIps === undefined ? undefined : yield* publicIpIdsOf(news.publicIps);
          const securityGroup = news.securityGroup === undefined ? undefined : yield* securityGroupIdOf(news.securityGroup);
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
          if (output?.serverId && publicIps !== undefined) {
            const currentPublicIps = publicIpIdsFromRecord(record);
            for (const publicIp of currentPublicIps.filter((publicIp) => !publicIps.includes(publicIp))) {
              yield* clients.instance.updateFlexibleIp({ zone, ip: publicIp, server: null });
            }
            for (const publicIp of publicIps.filter((publicIp) => !currentPublicIps.includes(publicIp))) {
              yield* clients.instance.updateFlexibleIp({ zone, ip: publicIp, server: record.id });
            }
            record = yield* waitForPublicIps(zone, record.id, publicIps);
          }
          const desiredState = targetState(news.desiredState);
          if (desiredState === "running" && record.state !== "running") {
            yield* clients.instance.instanceAction({ zone, serverId: record.id, action: "poweron" });
            record = yield* waitForState(zone, record.id, "running");
          }
          if (desiredState === "stopped" && record.state !== "stopped") {
            yield* clients.instance.instanceAction({ zone, serverId: record.id, action: "poweroff" });
            record = yield* waitForState(zone, record.id, "stopped");
          }
          yield* session.note(`${output?.serverId ? "Updated" : "Created"} Scaleway instance ${record.id}`);
          return toAttributes(record, news.volumes);
        }),
        delete: Effect.fnUntraced(function* ({ output, session }) {
          yield* clients.instance.updateInstance({ zone: output.zone, serverId: output.serverId, protected: false }).pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* clients.instance.deleteInstance({ zone: output.zone, serverId: output.serverId }).pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* session.note(`Deleted Scaleway instance ${output.serverId}`);
        }),
      });
    }),
  );
