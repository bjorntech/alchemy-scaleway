import { Resource } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { makeScalewayClients, type ScalewaySecurityGroupRecord, type ScalewaySecurityGroupRuleRecord } from "./Clients.ts";
import { isNotFound } from "./Errors.ts";
import { omitUndefined, physicalName, projectId, projectInput, withManagedProjectDefault, type ProjectRef } from "./Internal.ts";
import type { Providers } from "./Providers.ts";

export type SecurityGroupPolicy = "accept" | "drop";
export type SecurityGroupProtocol = "TCP" | "UDP" | "ICMP" | "ANY";
export type SecurityGroupDirection = "inbound" | "outbound";
export type SecurityGroupAction = "accept" | "drop";

export interface SecurityGroupRule {
  protocol: SecurityGroupProtocol;
  direction?: SecurityGroupDirection;
  action?: SecurityGroupAction;
  ipRange?: string;
  port?: number;
  portRange?: { from: number; to: number };
}

export interface SecurityGroupProps {
  name?: string;
  zone?: string;
  project?: ProjectRef;
  description?: string;
  tags?: string[];
  inboundDefaultPolicy?: SecurityGroupPolicy;
  outboundDefaultPolicy?: SecurityGroupPolicy;
  stateful?: boolean;
  projectDefault?: boolean;
  rules?: SecurityGroupRule[];
}

export type SecurityGroup = Resource<
  "Scaleway.SecurityGroup",
  SecurityGroupProps,
  {
    securityGroupId: string;
    name: string;
    zone: string;
    projectId?: string;
    description?: string;
    tags?: string[];
    inboundDefaultPolicy?: string;
    outboundDefaultPolicy?: string;
    stateful?: boolean;
    projectDefault?: boolean;
    state?: string;
    rules: ScalewaySecurityGroupRuleRecord[];
  },
  never,
  Providers
>;

export const SecurityGroup = withManagedProjectDefault(Resource<SecurityGroup>("Scaleway.SecurityGroup"));

const stringsEqual = (left?: string[], right?: string[]) => JSON.stringify([...(left ?? [])].sort()) === JSON.stringify([...(right ?? [])].sort());
const withAlchemyTag = (id: string, tags: string[] | undefined) => [`alchemy:logical-id=${id}`, ...(tags ?? [])];
const zoneOf = (region: string, zone?: string) => !zone || zone === region ? `${region}-1` : zone;
const ruleInput = (rule: SecurityGroupRule, position: number): ScalewaySecurityGroupRuleRecord => {
  const from = rule.portRange?.from ?? rule.port;
  const to = rule.portRange?.to;
  return omitUndefined({
    protocol: rule.protocol,
    direction: rule.direction ?? "inbound",
    action: rule.action ?? "accept",
    ip_range: rule.ipRange ?? "0.0.0.0/0",
    dest_port_from: from,
    dest_port_to: to,
    position,
  }) as ScalewaySecurityGroupRuleRecord;
};
const rulesInput = (rules: SecurityGroupRule[] = []) => rules.map((rule, index) => ruleInput(rule, index + 1));
function comparableRule(rule: ScalewaySecurityGroupRuleRecord) {
  const destPortTo = rule.dest_port_to === rule.dest_port_from ? undefined : (rule.dest_port_to ?? undefined);
  return omitUndefined({
    protocol: rule.protocol,
    direction: rule.direction,
    action: rule.action,
    ip_range: rule.ip_range,
    dest_port_from: rule.dest_port_from,
    dest_port_to: destPortTo,
    position: rule.position,
  }) as ScalewaySecurityGroupRuleRecord;
}
function rulesKey(rules: ScalewaySecurityGroupRuleRecord[]) {
  return JSON.stringify(rules.filter((rule) => rule.editable !== false).map(comparableRule));
}
function rulesEqual(left: ScalewaySecurityGroupRuleRecord[] = [], right: ScalewaySecurityGroupRuleRecord[]) {
  return rulesKey(left) === rulesKey(right);
}

// @crap-ignore: provider factory wraps lifecycle closures scored separately.
export const SecurityGroupProvider = () =>
  Provider.effect(
    SecurityGroup,
    Effect.gen(function* () {
      const clients = yield* makeScalewayClients;
      const nameOf = (id: string, name?: string) => physicalName(id, name, { maxLength: 255 });
      const toAttributes = (record: ScalewaySecurityGroupRecord, rules: ScalewaySecurityGroupRuleRecord[] = []): SecurityGroup["Attributes"] =>
        omitUndefined({
          securityGroupId: record.id,
          name: record.name,
          zone: zoneOf(clients.region, record.zone),
          projectId: record.project,
          description: record.description ?? undefined,
          tags: record.tags,
          inboundDefaultPolicy: record.inbound_default_policy,
          outboundDefaultPolicy: record.outbound_default_policy,
          stateful: record.stateful,
          projectDefault: record.project_default,
          state: record.state,
          rules: rules.filter((rule) => rule.editable !== false),
        }) as SecurityGroup["Attributes"];

      return SecurityGroup.Provider.of({
        stables: ["securityGroupId", "zone", "projectId"],
        diff: Effect.fnUntraced(function* ({ id, news, output }) {
          if (!isResolved(news) || !output) return undefined;
          if (zoneOf(clients.region, output.zone) !== zoneOf(clients.region, news.zone)) return { action: "replace" } as const;
          if (output.projectId !== (yield* projectId(projectInput(news), output.projectId))) return { action: "replace" } as const;
          const name = yield* nameOf(id, news.name);
          const tags = withAlchemyTag(id, news.tags);
          const rules = rulesInput(news.rules);
          if (
            output.name !== name ||
            output.description !== news.description ||
            !stringsEqual(output.tags, tags) ||
            output.inboundDefaultPolicy !== (news.inboundDefaultPolicy ?? "drop") ||
            output.outboundDefaultPolicy !== (news.outboundDefaultPolicy ?? "accept") ||
            output.stateful !== (news.stateful ?? true) ||
            output.projectDefault !== (news.projectDefault ?? false) ||
            !rulesEqual(output.rules, rules)
          ) return { action: "update" } as const;
          return { action: "noop" } as const;
        }),
        read: Effect.fnUntraced(function* ({ output }) {
          if (!output?.securityGroupId) return undefined;
          const zone = zoneOf(clients.region, output.zone);
          const securityGroupId = output.securityGroupId;
          return yield* clients.instance.getSecurityGroup({ zone, securityGroupId }).pipe(
            Effect.flatMap((record) => clients.instance.listSecurityGroupRules({ zone, securityGroupId }).pipe(Effect.map((rules) => toAttributes(record, rules)))),
            Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
          );
        }),
        reconcile: Effect.fnUntraced(function* ({ id, news, output, session }) {
          const zone = zoneOf(clients.region, news.zone);
          const name = yield* nameOf(id, news.name);
          const mutableInput = {
            name,
            description: news.description,
            tags: withAlchemyTag(id, news.tags),
            inbound_default_policy: news.inboundDefaultPolicy ?? "drop",
            outbound_default_policy: news.outboundDefaultPolicy ?? "accept",
            stateful: news.stateful ?? true,
            project_default: news.projectDefault ?? false,
          };
          const record = output?.securityGroupId
            ? yield* clients.instance.updateSecurityGroup({ zone, securityGroupId: output.securityGroupId, ...mutableInput, description: news.description ?? null })
            : yield* clients.instance.createSecurityGroup({ zone, project: yield* projectId(projectInput(news), output?.projectId), ...mutableInput });
          const rules = yield* clients.instance.setSecurityGroupRules({ zone, securityGroupId: record.id, rules: rulesInput(news.rules) });
          yield* session.note(`${output?.securityGroupId ? "Updated" : "Created"} Scaleway security group ${record.id}`);
          return toAttributes(record, rules);
        }),
        delete: Effect.fnUntraced(function* ({ output, session }) {
          yield* clients.instance.deleteSecurityGroup({ zone: zoneOf(clients.region, output.zone), securityGroupId: output.securityGroupId }).pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* session.note(`Deleted Scaleway security group ${output.securityGroupId}`);
        }),
      });
    }),
  );
