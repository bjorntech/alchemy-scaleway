import { Resource } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { makeScalewayClients, type ScalewayVpcRecord } from "./Clients.ts";
import { isNotFound } from "./Errors.ts";
import { omitUndefined, physicalName, projectId } from "./Internal.ts";
import type { Providers } from "./Providers.ts";

export interface VpcProps {
  name?: string;
  projectId?: string;
  tags?: string[];
  routing?: boolean;
  customRoutesPropagation?: boolean;
}

export type Vpc = Resource<
  "Scaleway.Vpc",
  VpcProps,
  {
    vpcId: string;
    name: string;
    projectId: string;
    region: string;
    tags?: string[];
    routing?: boolean;
    customRoutesPropagation?: boolean;
  },
  never,
  Providers
>;

export const Vpc = Resource<Vpc>("Scaleway.Vpc");

const tagsEqual = (left?: string[], right?: string[]) =>
  JSON.stringify([...(left ?? [])].sort()) === JSON.stringify([...(right ?? [])].sort());

const withAlchemyTag = (id: string, tags: string[] | undefined) => [
  `alchemy:logical-id=${id}`,
  ...(tags ?? []),
];

// @crap-ignore: provider factory wraps lifecycle closures scored separately.
export const VpcProvider = () =>
  Provider.effect(
    Vpc,
    Effect.gen(function* () {
      const clients = yield* makeScalewayClients;
      const nameOf = (id: string, name?: string) => physicalName(id, name, { maxLength: 255 });
      const toAttributes = (record: ScalewayVpcRecord): Vpc["Attributes"] =>
        omitUndefined({
          vpcId: record.id,
          name: record.name,
          projectId: record.project_id,
          region: clients.region,
          tags: record.tags,
          routing: record.routing_enabled,
          customRoutesPropagation: record.custom_routes_propagation_enabled,
        }) as Vpc["Attributes"];

      return Vpc.Provider.of({
        stables: ["vpcId", "projectId", "region"],
        diff: Effect.fnUntraced(function* ({ id, news, output }) {
          if (!isResolved(news) || !output) return undefined;
          if ((yield* projectId(news.projectId)) !== output.projectId) {
            return { action: "replace" } as const;
          }
          const name = yield* nameOf(id, news.name);
          const tags = withAlchemyTag(id, news.tags);
          if (
            output.name !== name ||
            !tagsEqual(output.tags, tags) ||
            (news.routing !== undefined && output.routing !== news.routing) ||
            (news.customRoutesPropagation !== undefined &&
              output.customRoutesPropagation !== news.customRoutesPropagation)
          ) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        read: Effect.fnUntraced(function* ({ output }) {
          if (!output?.vpcId) return undefined;
          return yield* clients.vpc.getVpc(output.vpcId).pipe(
            Effect.map(toAttributes),
            Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
          );
        }),
        reconcile: Effect.fnUntraced(function* ({ id, news, output, session }) {
          const name = yield* nameOf(id, news.name);
          const tags = withAlchemyTag(id, news.tags);
          let record = output?.vpcId
            ? yield* clients.vpc.updateVpc(output.vpcId, { name, tags })
            : yield* clients.vpc.createVpc({
                name,
                project_id: yield* projectId(news.projectId),
                tags,
              });

          if (news.routing === true && record.routing_enabled !== true) {
            record = yield* clients.vpc.enableVpcRouting(record.id);
          }
          if (news.routing === false && record.routing_enabled === true) {
            throw new Error("Scaleway VPC routing cannot be disabled once enabled.");
          }
          if (
            news.customRoutesPropagation === true &&
            record.custom_routes_propagation_enabled !== true
          ) {
            record = yield* clients.vpc.enableVpcCustomRoutesPropagation(record.id);
          }
          if (
            news.customRoutesPropagation === false &&
            record.custom_routes_propagation_enabled === true
          ) {
            throw new Error("Scaleway VPC custom routes propagation cannot be disabled once enabled.");
          }
          yield* session.note(`${output?.vpcId ? "Updated" : "Created"} Scaleway VPC ${record.id}`);
          return toAttributes(record);
        }),
        delete: Effect.fnUntraced(function* ({ output, session }) {
          yield* clients.vpc.deleteVpc(output.vpcId).pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* session.note(`Deleted Scaleway VPC ${output.vpcId}`);
        }),
      });
    }),
  );
