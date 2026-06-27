import { Resource } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { makeScalewayClients, type ScalewayVpcRouteRecord } from "./Clients.ts";
import { isNotFound } from "./Errors.ts";
import { omitUndefined, resolveRef } from "./Internal.ts";
import type { PrivateNetwork } from "./PrivateNetwork.ts";
import type { Providers } from "./Providers.ts";
import type { Vpc } from "./Vpc.ts";
import type { VpcConnector } from "./VpcConnector.ts";

export type VpcRouteVpcRef = string | Vpc;
export type VpcRoutePrivateNetworkRef = string | PrivateNetwork;
export type VpcRouteConnectorRef = string | VpcConnector;

export type VpcRouteNextHop =
  | { type: "resource"; resourceId: string }
  | { type: "privateNetwork"; privateNetwork: VpcRoutePrivateNetworkRef }
  | { type: "vpcConnector"; vpcConnector: VpcRouteConnectorRef };

export interface VpcRouteProps {
  vpc: VpcRouteVpcRef;
  destination: string;
  nextHop: VpcRouteNextHop;
  description?: string;
  tags?: string[];
}

export type VpcRoute = Resource<
  "Scaleway.VpcRoute",
  VpcRouteProps,
  {
    routeId: string;
    region: string;
    vpcId: string;
    destination: string;
    nextHopResourceId?: string;
    nextHopPrivateNetworkId?: string;
    nextHopVpcConnectorId?: string;
    description?: string;
    tags?: string[];
    readOnly?: boolean;
    type?: string;
  },
  never,
  Providers
>;

export const VpcRoute = Resource<VpcRoute>("Scaleway.VpcRoute");

const stringsEqual = (left?: string[], right?: string[]) =>
  JSON.stringify([...(left ?? [])].sort()) === JSON.stringify([...(right ?? [])].sort());
const withAlchemyTag = (id: string, tags: string[] | undefined) => [
  `alchemy:logical-id=${id}`,
  ...(tags ?? []),
];
const vpcIdOf = (vpc: VpcRouteVpcRef) => resolveRef(typeof vpc === "string" ? vpc : vpc.vpcId);
const privateNetworkIdOf = (privateNetwork: VpcRoutePrivateNetworkRef) =>
  resolveRef(typeof privateNetwork === "string" ? privateNetwork : privateNetwork.privateNetworkId);
const vpcConnectorIdOf = (vpcConnector: VpcRouteConnectorRef) =>
  resolveRef(typeof vpcConnector === "string" ? vpcConnector : vpcConnector.vpcConnectorId);
const nextHopInput = (nextHop: VpcRouteNextHop) =>
  Effect.gen(function* () {
    if (nextHop.type === "resource") return { nexthop_resource_id: nextHop.resourceId };
    if (nextHop.type === "privateNetwork") {
      return { nexthop_private_network_id: yield* privateNetworkIdOf(nextHop.privateNetwork) };
    }
    return { nexthop_vpc_connector_id: yield* vpcConnectorIdOf(nextHop.vpcConnector) };
  });

// @crap-ignore: provider factory wraps lifecycle closures scored separately.
export const VpcRouteProvider = () =>
  Provider.effect(
    VpcRoute,
    Effect.gen(function* () {
      const clients = yield* makeScalewayClients;
      const toAttributes = (record: ScalewayVpcRouteRecord): VpcRoute["Attributes"] =>
        omitUndefined({
          routeId: record.id,
          region: clients.region,
          vpcId: record.vpc_id,
          destination: record.destination,
          nextHopResourceId: record.nexthop_resource_id ?? undefined,
          nextHopPrivateNetworkId: record.nexthop_private_network_id ?? undefined,
          nextHopVpcConnectorId: record.nexthop_vpc_connector_id ?? undefined,
          description: record.description,
          tags: record.tags,
          readOnly: record.is_read_only,
          type: record.type,
        }) as VpcRoute["Attributes"];

      return VpcRoute.Provider.of({
        stables: ["routeId", "region", "vpcId"],
        list: () => Effect.succeed([]),
        diff: Effect.fnUntraced(function* ({ id, news, output }) {
          if (!isResolved(news) || !output) return undefined;
          const vpcId = yield* vpcIdOf(news.vpc);
          if (output.vpcId !== vpcId) return { action: "replace" } as const;
          const tags = withAlchemyTag(id, news.tags);
          const nextHop = yield* nextHopInput(news.nextHop);
          if (
            output.destination !== news.destination ||
            output.description !== news.description ||
            !stringsEqual(output.tags, tags) ||
            output.nextHopResourceId !== nextHop.nexthop_resource_id ||
            output.nextHopPrivateNetworkId !== nextHop.nexthop_private_network_id ||
            output.nextHopVpcConnectorId !== nextHop.nexthop_vpc_connector_id
          ) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        read: Effect.fnUntraced(function* ({ output }) {
          if (!output?.routeId) return undefined;
          return yield* clients.vpc.getRoute(output.routeId).pipe(
            Effect.map(toAttributes),
            Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
          );
        }),
        reconcile: Effect.fnUntraced(function* ({ id, news, output, session }) {
          const tags = withAlchemyTag(id, news.tags);
          const nextHop = yield* nextHopInput(news.nextHop);
          const input = {
            description: news.description,
            tags,
            destination: news.destination,
            ...nextHop,
          };
          const updateInput = {
            description: news.description ?? null,
            tags,
            destination: news.destination,
            nexthop_resource_id: nextHop.nexthop_resource_id ?? null,
            nexthop_private_network_id: nextHop.nexthop_private_network_id ?? null,
            nexthop_vpc_connector_id: nextHop.nexthop_vpc_connector_id ?? null,
          };
          const record = output?.routeId
            ? yield* clients.vpc.updateRoute(output.routeId, updateInput)
            : yield* clients.vpc.createRoute({
                ...input,
                vpc_id: yield* vpcIdOf(news.vpc),
              });
          yield* session.note(`${output?.routeId ? "Updated" : "Created"} Scaleway VPC route ${record.id}`);
          return toAttributes(record);
        }),
        delete: Effect.fnUntraced(function* ({ output, session }) {
          yield* clients.vpc.deleteRoute(output.routeId).pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* session.note(`Deleted Scaleway VPC route ${output.routeId}`);
        }),
      });
    }),
  );
