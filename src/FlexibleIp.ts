import { Resource } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { makeScalewayClients, type ScalewayFlexibleIpRecord } from "./Clients.ts";
import { isNotFound } from "./Errors.ts";
import { omitUndefined, projectId } from "./Internal.ts";
import type { Providers } from "./Providers.ts";

export type FlexibleIpType = "routed_ipv4" | "routed_ipv6";

export interface FlexibleIpProps {
  zone?: string;
  projectId?: string;
  tags?: string[];
  serverId?: string;
  type?: FlexibleIpType;
  reverse?: string;
}

export type FlexibleIp = Resource<
  "Scaleway.FlexibleIp",
  FlexibleIpProps,
  {
    ipId: string;
    address: string;
    zone: string;
    projectId?: string;
    tags?: string[];
    serverId?: string;
    type?: string;
    reverse?: string;
    state?: string;
    prefix?: string;
    ipamId?: string;
  },
  never,
  Providers
>;

export const FlexibleIp = Resource<FlexibleIp>("Scaleway.FlexibleIp");

const stringsEqual = (left?: string[], right?: string[]) => JSON.stringify([...(left ?? [])].sort()) === JSON.stringify([...(right ?? [])].sort());
const withAlchemyTag = (id: string, tags: string[] | undefined) => [`alchemy:logical-id=${id}`, ...(tags ?? [])];
const zoneOf = (region: string, zone?: string) => zone ?? `${region}-1`;

// @crap-ignore: provider factory wraps lifecycle closures scored separately.
export const FlexibleIpProvider = () =>
  Provider.effect(
    FlexibleIp,
    Effect.gen(function* () {
      const clients = yield* makeScalewayClients;
      const toAttributes = (record: ScalewayFlexibleIpRecord): FlexibleIp["Attributes"] =>
        omitUndefined({
          ipId: record.id,
          address: record.address,
          zone: record.zone ?? clients.region,
          projectId: record.project,
          tags: record.tags,
          serverId: record.server?.id,
          type: record.type,
          reverse: record.reverse,
          state: record.state,
          prefix: record.prefix,
          ipamId: record.ipam_id,
        }) as FlexibleIp["Attributes"];

      return FlexibleIp.Provider.of({
        stables: ["ipId", "address", "zone", "projectId"],
        diff: Effect.fnUntraced(function* ({ id, news, output }) {
          if (!isResolved(news) || !output) return undefined;
          if (output.zone !== zoneOf(clients.region, news.zone) || output.type !== (news.type ?? "routed_ipv4")) return { action: "replace" } as const;
          if (output.projectId !== (yield* projectId(news.projectId))) return { action: "replace" } as const;
          if (!stringsEqual(output.tags, withAlchemyTag(id, news.tags)) || output.serverId !== news.serverId || output.reverse !== news.reverse) return { action: "update" } as const;
          return undefined;
        }),
        read: Effect.fnUntraced(function* ({ output }) {
          if (!output?.ipId) return undefined;
          return yield* clients.instance.getFlexibleIp({ zone: output.zone, ip: output.ipId }).pipe(
            Effect.map(toAttributes),
            Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
          );
        }),
        reconcile: Effect.fnUntraced(function* ({ id, news, output, session }) {
          const zone = zoneOf(clients.region, news.zone);
          const tags = withAlchemyTag(id, news.tags);
          let record: ScalewayFlexibleIpRecord;
          if (output?.ipId) {
            record = yield* clients.instance.updateFlexibleIp({ zone, ip: output.ipId, tags, server: news.serverId ?? null, reverse: news.reverse ?? null });
          } else {
            record = yield* clients.instance.createFlexibleIp({ zone, project: yield* projectId(news.projectId), tags, server: news.serverId, type: news.type ?? "routed_ipv4" });
            if (news.reverse !== undefined) {
              record = yield* clients.instance.updateFlexibleIp({ zone, ip: record.id, tags, server: news.serverId ?? null, reverse: news.reverse });
            }
          }
          yield* session.note(`${output?.ipId ? "Updated" : "Created"} Scaleway flexible IP ${record.id}`);
          return toAttributes(record);
        }),
        delete: Effect.fnUntraced(function* ({ output, session }) {
          yield* clients.instance.deleteFlexibleIp({ zone: output.zone, ip: output.ipId }).pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* session.note(`Deleted Scaleway flexible IP ${output.ipId}`);
        }),
      });
    }),
  );
