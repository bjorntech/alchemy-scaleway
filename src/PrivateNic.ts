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
const zoneOf = (region: string, zone?: string) => zone ?? `${region}-1`;
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
      const toAttributes = (record: ScalewayPrivateNicRecord): PrivateNic["Attributes"] =>
        omitUndefined({
          privateNicId: record.id,
          zone: record.zone ?? clients.region,
          serverId: record.server_id,
          privateNetworkId: record.private_network_id,
          macAddress: record.mac_address,
          state: record.state,
          tags: record.tags,
          ipamIpIds: record.ipam_ip_ids,
        }) as PrivateNic["Attributes"];

      return PrivateNic.Provider.of({
        stables: ["privateNicId", "zone", "serverId", "privateNetworkId"],
        diff: Effect.fnUntraced(function* ({ id, news, output }) {
          if (!isResolved(news) || !output) return undefined;
          const privateNetworkId = yield* privateNetworkIdOf(news.privateNetwork);
          if (output.zone !== zoneOf(clients.region, news.zone) || output.serverId !== news.serverId || output.privateNetworkId !== privateNetworkId || !stringsEqual(output.ipamIpIds, news.ipamIpIds)) return { action: "replace" } as const;
          if (!stringsEqual(output.tags, withAlchemyTag(id, news.tags))) return { action: "update" } as const;
          return undefined;
        }),
        read: Effect.fnUntraced(function* ({ output }) {
          if (!output?.privateNicId) return undefined;
          return yield* clients.instance.getPrivateNic({ zone: output.zone, serverId: output.serverId, privateNicId: output.privateNicId }).pipe(
            Effect.map(toAttributes),
            Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
          );
        }),
        reconcile: Effect.fnUntraced(function* ({ id, news, output, session }) {
          const zone = zoneOf(clients.region, news.zone);
          const tags = withAlchemyTag(id, news.tags);
          const record = output?.privateNicId
            ? yield* clients.instance.updatePrivateNic({ zone, serverId: output.serverId, privateNicId: output.privateNicId, tags })
            : yield* clients.instance.createPrivateNic({ zone, serverId: news.serverId, private_network_id: yield* privateNetworkIdOf(news.privateNetwork), tags, ipam_ip_ids: news.ipamIpIds });
          yield* session.note(`${output?.privateNicId ? "Updated" : "Created"} Scaleway private NIC ${record.id}`);
          return toAttributes(record);
        }),
        delete: Effect.fnUntraced(function* ({ output, session }) {
          yield* clients.instance.deletePrivateNic({ zone: output.zone, serverId: output.serverId, privateNicId: output.privateNicId }).pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* session.note(`Deleted Scaleway private NIC ${output.privateNicId}`);
        }),
      });
    }),
  );
