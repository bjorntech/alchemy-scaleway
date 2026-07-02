import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Output from "alchemy/Output";
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
    if (typeof ref === "object" && ref !== null && "projectId" in ref) {
      return yield* resolveRef((ref as { projectId: unknown }).projectId);
    }
    if (!Output.isOutput(ref)) throw new Error("Expected a string or Alchemy Output reference.");
    const accessor = yield* (ref as Output.Output<string, never>).asEffect();
    return yield* accessor;
  });

export const namespaceId = (namespace: NamedNamespace) => {
  return resolveRef(typeof namespace === "string" ? namespace : namespace.namespaceId);
};

// Scheduling-only anchor for child resources whose cloud API serializes against
// the parent's own update (e.g. Scaleway rejects a function/container config
// change while one of its domains is mid-create). Returning the parent's
// non-stable `status` output keeps a real Alchemy upstream edge: because
// `status` is not in the parent's `stables`, the planner cannot materialize the
// whole-resource reference into plain stable values, so the child waits for the
// parent's reconcile to finish instead of running concurrently against the
// parent's stable identity alone. A string ref (raw id) has no resource to wait
// on and yields `undefined`.
export const parentReadiness = (ref: unknown): unknown =>
  ref !== null && typeof ref === "object" ? (ref as { status?: unknown }).status : undefined;

const defaultProjectId = () =>
  Effect.gen(function* () {
    const credentials = yield* ScalewayCredentials;
    if (!credentials.projectId)
      throw new Error("Scaleway projectId is required for this resource.");
    return credentials.projectId;
  });

const projectIdField = (explicit: unknown) =>
  isManagedProjectDefault(explicit)
    ? explicit.projectId
    :
  typeof explicit === "object" && explicit !== null && "projectId" in explicit
    ? (explicit as { projectId: unknown }).projectId
    : explicit;

const optionalResolvedRef = (ref: unknown) =>
  resolveRef(ref).pipe(Effect.map((value) => value || undefined));

const persistedManagedProjectId = (): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const stack = yield* Stack;
    const managedProject = singleManagedProject(stack);
    if (!managedProject) return undefined;
    const state = yield* yield* State;
    const persisted = yield* state.get({
      stack: stack.name,
      stage: stack.stage,
      fqn: managedProject.FQN,
    });
    const persistedProjectId = (persisted as { attr?: { projectId?: unknown } } | undefined)?.attr?.projectId;
    return persistedProjectId === undefined ? undefined : yield* optionalResolvedRef(persistedProjectId);
  }) as Effect.Effect<string | undefined>;

const explicitProjectId = (explicit: unknown): Effect.Effect<string | undefined> => {
  const field = projectIdField(explicit);
  if (field !== undefined) return optionalResolvedRef(field);
  return isManagedProjectDefault(explicit) ? persistedManagedProjectId() : Effect.succeed(undefined);
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

// Like `projectId` but never falls back to credentials' default project.
// Used by Object Storage, where an unset project means "the API key's
// preferred project" and must stay undefined for backward compatibility.
export const optionalProjectId = (explicit?: unknown, existing?: string): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const managedExisting = existingManagedProjectId(explicit, existing);
    if (managedExisting) return managedExisting;
    return yield* explicitOrExistingProjectId(explicit, existing);
  }) as Effect.Effect<string | undefined>;

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
