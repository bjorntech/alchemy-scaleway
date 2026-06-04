import * as Effect from "effect/Effect";
import { createPhysicalName } from "alchemy";
import type { Namespace } from "./Namespace.ts";
import { ScalewayCredentials } from "./Credentials.ts";

export type NamedNamespace = string | Namespace;

export const omitUndefined = <T extends Record<string, unknown>>(value: T) =>
  Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as Partial<T>;

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
    const accessor = yield* (ref as { asEffect(): Effect.Effect<Effect.Effect<string>> }).asEffect();
    return yield* accessor;
  });

export const namespaceId = (namespace: NamedNamespace) => {
  return resolveRef(typeof namespace === "string" ? namespace : namespace.namespaceId);
};

export const projectId = (explicit?: string) =>
  Effect.gen(function* () {
    if (explicit) return explicit;
    const credentials = yield* ScalewayCredentials;
    if (!credentials.projectId) throw new Error("Scaleway projectId is required for this resource.");
    return credentials.projectId;
  });

export const withAlchemyTags = (id: string, tags?: Record<string, string>) => ({
  ...tags,
  "alchemy:logical-id": id,
});

export const hasAlchemyTags = (id: string, tags: Record<string, string> | undefined) =>
  tags?.["alchemy:logical-id"] === id;
