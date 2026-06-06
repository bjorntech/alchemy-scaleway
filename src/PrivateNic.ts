import { Resource } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { makeScalewayClients, type ScalewayPrivateNicRecord } from "./Clients.ts";
import { isNotFound } from "./Errors.ts";
import { omitUndefined, resolveRef } from "./Internal.ts";
import type { PrivateNetwork } from "./PrivateNetwork.ts";
import type { Providers } from "./Providers.ts";

export type PrivateNicPrivateNetworkRef = string | PrivateNetwork;

export interface PrivateNicProps {
  zone?: string;
  serverId: string;
  privateNetwork: PrivateNicPrivateNetworkRef;
  tags?: string[];
  ipamIpIds?: string[];
}

export type PrivateNic = Resource<
  "Scaleway.PrivateNic",
  PrivateNicProps,
  {
    privateNicId: string;
    zone: string;
    serverId: string;
    privateNetworkId: string;
    macAddress?: string;
    state?: string;
    tags?: string[];
    ipamIpIds?: string[];
  },
  never,
  Providers
>;

export const PrivateNic = Resource<PrivateNic>("Scaleway.PrivateNic");

const stringsEqual = (left?: string[], right?: string[]) => JSON.stringify([...(left ?? [])].sort()) === JSON.stringify([...(right ?? [])].sort());
const withAlchemyTag = (id: string, tags: string[] | undefined) => [`alchemy:logical-id=${id}`, ...(tags ?? [])];
const zoneOf = (region: string, zone?: string) => !zone || zone === region ? `${region}-1` : zone;
const privateNetworkIdOf = (privateNetwork: PrivateNicPrivateNetworkRef) => {
  if (typeof privateNetwork === "string") return resolveRef(privateNetwork);
  return resolveRef(privateNetwork.privateNetworkId);
};

// @crap-ignore: provider factory wraps lifecycle closures scored separately.
export const PrivateNicProvider = () =>
  Provider.effect(
    PrivateNic,
    Effect.gen(function* () {
      const clients = yield* makeScalewayClients;
      const toAttributes = (record: ScalewayPrivateNicRecord, fallback: { zone: string; serverId?: string; privateNetworkId?: string }): PrivateNic["Attributes"] =>
        omitUndefined({
          privateNicId: record.id,
          zone: zoneOf(clients.region, record.zone ?? fallback.zone),
          serverId: record.server_id ?? fallback.serverId,
          privateNetworkId: record.private_network_id ?? fallback.privateNetworkId,
          macAddress: record.mac_address,
          state: record.state,
          tags: record.tags,
          ipamIpIds: record.ipam_ip_ids,
        }) as PrivateNic["Attributes"];

      return PrivateNic.Provider.of({
        stables: ["privateNicId", "zone", "serverId"],
        diff: Effect.fnUntraced(function* ({ id, news, output }) {
          if (!isResolved(news) || !output) return undefined;
          const privateNetworkId = yield* privateNetworkIdOf(news.privateNetwork);
          const zone = zoneOf(clients.region, news.zone);
          if (
            zoneOf(clients.region, output.zone) !== zone ||
            output.serverId !== undefined && output.serverId !== news.serverId ||
            output.privateNetworkId !== undefined && output.privateNetworkId !== privateNetworkId ||
            news.ipamIpIds !== undefined && !stringsEqual(output.ipamIpIds, news.ipamIpIds)
          ) return { action: "replace" } as const;
          if (!stringsEqual(output.tags, withAlchemyTag(id, news.tags))) return { action: "update" } as const;
          return undefined;
        }),
        read: Effect.fnUntraced(function* ({ output }) {
          if (!output?.privateNicId) return undefined;
          const zone = zoneOf(clients.region, output.zone);
          return yield* clients.instance.getPrivateNic({ zone, serverId: output.serverId, privateNicId: output.privateNicId }).pipe(
            Effect.map((record) => toAttributes(record, { zone, serverId: output.serverId, privateNetworkId: output.privateNetworkId })),
            Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
          );
        }),
        reconcile: Effect.fnUntraced(function* ({ id, news, output, session }) {
          const zone = zoneOf(clients.region, news.zone);
          const tags = withAlchemyTag(id, news.tags);
          const privateNetworkId = yield* privateNetworkIdOf(news.privateNetwork);
          const record = output?.privateNicId
            ? yield* clients.instance.updatePrivateNic({ zone, serverId: output.serverId, privateNicId: output.privateNicId, tags })
            : yield* clients.instance.createPrivateNic({ zone, serverId: news.serverId, private_network_id: privateNetworkId, tags, ipam_ip_ids: news.ipamIpIds });
          yield* session.note(`${output?.privateNicId ? "Updated" : "Created"} Scaleway private NIC ${record.id}`);
          return toAttributes(record, { zone, serverId: news.serverId, privateNetworkId });
        }),
        delete: Effect.fnUntraced(function* ({ output, session }) {
          yield* clients.instance.deletePrivateNic({ zone: zoneOf(clients.region, output.zone), serverId: output.serverId, privateNicId: output.privateNicId }).pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* session.note(`Deleted Scaleway private NIC ${output.privateNicId}`);
        }),
      });
    }),
  );
