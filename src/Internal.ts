import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import { createPhysicalName } from "alchemy";
import { toFqn } from "alchemy/FQN";
import { CurrentNamespace } from "alchemy/Namespace";
import { Stack } from "alchemy/Stack";
import { State } from "alchemy/State";
import type { Namespace } from "./Namespace.ts";
import type { Project } from "./Project.ts";
import { ScalewayCredentials } from "./Credentials.ts";

export type NamedNamespace = string | Namespace;
export type ProjectRef = string | Project;
export type ProjectScopedProps = { project?: unknown; projectId?: unknown };

export interface ScalewayProviderConfigService {
  project?: ProjectRef;
}

export class ScalewayProviderConfig extends Context.Service<
  ScalewayProviderConfig,
  ScalewayProviderConfigService
>()("Scaleway.ProviderConfig") {}

const managedProjectDefaultKey = "__scalewayManagedProjectDefault";

type ManagedProjectDefault = {
  [managedProjectDefaultKey]: true;
  projectId: unknown;
};

const isManagedProjectDefault = (value: unknown): value is ManagedProjectDefault =>
  typeof value === "object" &&
  value !== null &&
  managedProjectDefaultKey in value &&
  (value as Record<string, unknown>)[managedProjectDefaultKey] === true;

export const omitUndefined = <T extends Record<string, unknown>>(value: T) =>
  Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as Partial<T>;

export const recordEquals = (
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined,
) => {
  const leftEntries = Object.entries(left ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
};

export const defaultName = (
  id: string,
  options: {
    maxLength?: number;
    suffixLength?: number;
    lowercase?: boolean;
    delimiter?: string;
    sanitize?: (name: string) => string;
  } = {},
) =>
  createPhysicalName({
    id,
    maxLength: options.maxLength,
    suffixLength: options.suffixLength,
    lowercase: options.lowercase ?? true,
    delimiter: options.delimiter,
  }).pipe(Effect.map((name) => options.sanitize?.(name) ?? name));

export const physicalName = (
  id: string,
  name: string | undefined,
  options?: Parameters<typeof defaultName>[1],
) => (name ? Effect.succeed(name) : defaultName(id, options));

// Read a resource attribute that may arrive as a raw id (caller passed a
// string), an already-resolved string (inside reconcile/diff, where Alchemy
// has resolved `news`), or an unresolved Output accessor.
export const resolveRef = (ref: unknown): Effect.Effect<string> =>
  Effect.gen(function* () {
    if (typeof ref === "string") return ref;
    const accessor = yield* (
      ref as { asEffect(): Effect.Effect<Effect.Effect<string>> }
    ).asEffect();
    return yield* accessor;
  });

export const namespaceId = (namespace: NamedNamespace) => {
  return resolveRef(typeof namespace === "string" ? namespace : namespace.namespaceId);
};

const defaultProjectId = () =>
  Effect.gen(function* () {
    const credentials = yield* ScalewayCredentials;
    if (!credentials.projectId)
      throw new Error("Scaleway projectId is required for this resource.");
    return credentials.projectId;
  });

const projectIdField = (explicit: unknown) =>
  typeof explicit === "object" && explicit !== null && "projectId" in explicit
    ? (explicit as { projectId: unknown }).projectId
    : explicit;

const optionalResolvedRef = (ref: unknown) =>
  resolveRef(ref).pipe(Effect.map((value) => value || undefined));

const explicitProjectId = (explicit: unknown) => {
  const field = projectIdField(explicit);
  return field === undefined
    ? Effect.succeed(undefined)
    : optionalResolvedRef(field);
};

const singleManagedProject = (stack: { resources: Record<string, unknown> }) => {
  const projects = Object.values(stack.resources).filter(
    (resource) => typeof resource === "object" && resource !== null && (resource as { Type?: unknown }).Type === "Scaleway.Project",
  );
  if (projects.length === 0) return undefined;
  if (projects.length > 1) {
    throw new Error("Multiple Scaleway.Project resources are declared; pass project explicitly.");
  }
  return projects[0] as Project;
};

const managedProjectDefault = (stack: { resources: Record<string, unknown> }) =>
  ({
    [managedProjectDefaultKey]: true,
    get projectId() {
      return singleManagedProject(stack)?.projectId;
    },
  }) satisfies ManagedProjectDefault;

const assertNoLegacyProjectId = (props: ProjectScopedProps) => {
  if ("projectId" in props) {
    throw new Error("Use the project prop instead of projectId for Scaleway resource inputs.");
  }
};

export const projectInput = (props: ProjectScopedProps) => {
  assertNoLegacyProjectId(props);
  return props.project;
};

export const storedProjectInput = (props: ProjectScopedProps) => props.project ?? props.projectId;

export const withManagedProjectDefault = <ResourceClass extends { (id: string, props: any): Effect.Effect<any> }>(
  resource: ResourceClass,
): ResourceClass =>
  Object.assign(
    (id: string, props: any) =>
      Effect.gen(function* () {
        const resolvedProps = Effect.isEffect(props) ? yield* props : props;
        const stack = yield* Stack;
        const namespace = yield* CurrentNamespace;
        const state = yield* yield* State;
        const existing = yield* state.get({
          stack: stack.name,
          stage: stack.stage,
          fqn: toFqn(namespace, id),
        });
        if (resolvedProps && typeof resolvedProps === "object") {
          assertNoLegacyProjectId(resolvedProps);
        }
        if (!existing && resolvedProps && typeof resolvedProps === "object" && !("project" in resolvedProps)) {
          const config = yield* Effect.serviceOption(ScalewayProviderConfig);
          const configuredProject = config._tag === "Some" ? config.value.project : undefined;
          return yield* resource(id, {
            ...resolvedProps,
            project: configuredProject ?? managedProjectDefault(stack),
          });
        }
        return yield* resource(id, resolvedProps);
      }),
    resource,
  ) as ResourceClass;

const configuredProjectId = () =>
  Effect.gen(function* () {
    const config = yield* Effect.serviceOption(ScalewayProviderConfig);
    if (config._tag === "None" || !config.value.project) return undefined;
    return yield* explicitProjectId(config.value.project);
  });

const existingManagedProjectId = (explicit: unknown, existing?: string) =>
  isManagedProjectDefault(explicit) ? existing : undefined;

const explicitOrExistingProjectId = (explicit: unknown, existing?: string) =>
  Effect.gen(function* () {
    return (yield* explicitProjectId(explicit)) ?? existing;
  });

const configuredOrDefaultProjectId = () =>
  Effect.gen(function* () {
    return (yield* configuredProjectId()) ?? (yield* defaultProjectId());
  });

export const projectId = (explicit?: unknown, existing?: string) =>
  Effect.gen(function* () {
    const managedExisting = existingManagedProjectId(explicit, existing);
    if (managedExisting) return managedExisting;
    const resolved = yield* explicitOrExistingProjectId(explicit, existing);
    if (resolved) return resolved;
    return yield* configuredOrDefaultProjectId();
  });

export const credentialsProjectId = (explicit?: unknown) =>
  Effect.gen(function* () {
    return (yield* explicitProjectId(explicit)) ?? (yield* defaultProjectId());
  });

export const withAlchemyTags = (id: string, tags?: Record<string, string>) => ({
  ...tags,
  "alchemy:logical-id": id,
});

export const hasAlchemyTags = (id: string, tags: Record<string, string> | undefined) =>
  tags?.["alchemy:logical-id"] === id;
