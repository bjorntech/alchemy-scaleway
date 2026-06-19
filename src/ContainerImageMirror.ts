import { Resource } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { ScalewayCredentials } from "./Credentials.ts";
import { physicalName, resolveRef } from "./Internal.ts";
import {
  copyImage,
  resolveSourceDigest,
  type ImageCopyRequest,
  type ImageCopyResult,
  type RegistryAuth,
} from "./RegistryClient.ts";
import type {
  ContainerImageRegistryAuth,
  ContainerImageRegistryRef,
} from "./ContainerImage.ts";
import type { Providers } from "./Providers.ts";

export interface ContainerImageMirrorProps {
  /** Target Scaleway Container Registry namespace or `host/namespace` prefix. */
  registry: ContainerImageRegistryRef;
  /** Source image reference, e.g. `ghcr.io/acme/api:1.4.2` or `docker.io/library/nginx@sha256:...`. */
  source: string;
  /** Pull credentials for a private source registry. */
  sourceAuth?: ContainerImageRegistryAuth;
  /** Push credentials for the target registry. Defaults to the Scaleway secret key for `.scw.cloud` registries. */
  auth?: ContainerImageRegistryAuth;
  /** Destination repository. Defaults to the last path segment of the source image. */
  repository?: string;
  /** Destination tag. Defaults to the source tag, or `latest` when the source is digest-pinned. */
  tag?: string;
  /**
   * Copy all platform variants in a multi-arch manifest list. Defaults to `true`
   * so amd64 + arm64 images keep their manifest list.
   */
  allPlatforms?: boolean;
}

export type ContainerImageMirror = Resource<
  "Scaleway.ContainerImageMirror",
  ContainerImageMirrorProps,
  {
    ref: string;
    stableRef: string;
    registry: string;
    repository: string;
    tag: string;
    source: string;
    digest: string;
  },
  never,
  Providers
>;

export const ContainerImageMirror = Resource<ContainerImageMirror>("Scaleway.ContainerImageMirror");

/**
 * Image copy engine seam. The default implementation copies images using the
 * pure-TypeScript Registry v2 client; tests can substitute a fake.
 */
export interface ContainerImageMirrorEngine {
  resolveSourceDigest(source: string, auth?: RegistryAuth): Effect.Effect<string, Error, never>;
  copy(request: ImageCopyRequest): Effect.Effect<ImageCopyResult, Error, never>;
}

const toError = (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause)));

const defaultEngine: ContainerImageMirrorEngine = {
  resolveSourceDigest: (source, auth) =>
    Effect.tryPromise({ try: () => resolveSourceDigest(source, auth), catch: toError }),
  copy: (request) => Effect.tryPromise({ try: () => copyImage(request), catch: toError }),
};

let engine = defaultEngine;

export const setContainerImageMirrorEngine = (next: ContainerImageMirrorEngine) => {
  engine = next;
};

export const resetContainerImageMirrorEngine = () => {
  engine = defaultEngine;
};

const parseSourceRepository = (source: string) => {
  const withoutDigest = source.split("@")[0];
  const lastSlash = withoutDigest.lastIndexOf("/");
  const afterSlash = withoutDigest.slice(lastSlash + 1);
  const colon = afterSlash.lastIndexOf(":");
  const name = colon >= 0 ? withoutDigest.slice(0, lastSlash + 1) + afterSlash.slice(0, colon) : withoutDigest;
  return name.split("/").filter(Boolean).pop() ?? name;
};

const parseSourceTag = (source: string) => {
  if (source.includes("@")) return undefined;
  const lastSlash = source.lastIndexOf("/");
  const afterSlash = source.slice(lastSlash + 1);
  const colon = afterSlash.lastIndexOf(":");
  return colon >= 0 ? afterSlash.slice(colon + 1) : undefined;
};

const registryPrefix = (registry: ContainerImageRegistryRef) =>
  typeof registry === "string" ? Effect.succeed(registry) : resolveRef(registry.imagePrefix);

const imageRef = (registry: string, repository: string, tag: string) => `${registry}/${repository}:${tag}`;

const contentTag = (tag: string, digest: string) => {
  const suffix = digest.replace(/^sha256:/, "").slice(0, 12);
  return `${tag.slice(0, 128 - suffix.length - 1)}-${suffix}`;
};

const registryHost = (registry: string) => registry.split("/")[0] ?? registry;

const isScalewayRegistry = (registry: string) => registryHost(registry).endsWith(".scw.cloud");

const resolveAuth = (auth: ContainerImageRegistryAuth | undefined): RegistryAuth | undefined =>
  auth
    ? {
        username: auth.username,
        password: Redacted.isRedacted(auth.password) ? Redacted.value(auth.password) : auth.password,
      }
    : undefined;

const destinationAuth = (
  registry: string,
  auth: ContainerImageRegistryAuth | undefined,
  scalewaySecretKey: Redacted.Redacted<string>,
): RegistryAuth | undefined => {
  const explicit = resolveAuth(auth);
  if (explicit) return explicit;
  if (isScalewayRegistry(registry)) return { username: "nologin", password: Redacted.value(scalewaySecretKey) };
  return undefined;
};

// @crap-ignore: provider factory wraps lifecycle closures scored separately.
export const ContainerImageMirrorProvider = () =>
  Provider.effect(
    ContainerImageMirror,
    Effect.gen(function* () {
      const scalewayCredentials = yield* ScalewayCredentials;

      const resolved = (id: string, news: ContainerImageMirrorProps) =>
        Effect.gen(function* () {
          const registry = yield* registryPrefix(news.registry);
          const repository = yield* physicalName(id, news.repository ?? parseSourceRepository(news.source), {
            maxLength: 63,
          });
          const requestedTag = news.tag ?? parseSourceTag(news.source) ?? "latest";
          return { registry, repository, requestedTag };
        });

      return ContainerImageMirror.Provider.of({
        stables: [],
        diff: Effect.fnUntraced(function* ({ id, news, output }) {
          if (!isResolved(news) || !output) return undefined;
          const { registry, repository, requestedTag } = yield* resolved(id, news);
          const digest = yield* engine.resolveSourceDigest(news.source, resolveAuth(news.sourceAuth));
          const tag = contentTag(requestedTag, digest);
          if (
            output.ref !== imageRef(registry, repository, tag) ||
            output.stableRef !== imageRef(registry, repository, requestedTag) ||
            output.digest !== digest ||
            output.source !== news.source
          ) {
            return { action: "update" } as const;
          }
          return { action: "noop" } as const;
        }),
        read: Effect.fnUntraced(function* ({ output }) {
          return output;
        }),
        reconcile: Effect.fnUntraced(function* ({ id, news, session }) {
          const { registry, repository, requestedTag } = yield* resolved(id, news);
          const digest = yield* engine.resolveSourceDigest(news.source, resolveAuth(news.sourceAuth));
          const tag = contentTag(requestedTag, digest);
          const ref = imageRef(registry, repository, tag);
          const stableRef = imageRef(registry, repository, requestedTag);

          yield* session.note(`Mirroring ${news.source} to ${ref}`);
          const result = yield* engine.copy({
            source: news.source,
            sourceAuth: resolveAuth(news.sourceAuth),
            destination: `${registry}/${repository}`,
            destAuth: destinationAuth(registry, news.auth, scalewayCredentials.secretKey),
            destTags: [tag, requestedTag],
            allPlatforms: news.allPlatforms ?? true,
          });
          yield* session.note(`Mirrored ${news.source} (${result.platforms} image manifest(s)) to ${ref}`);

          return { ref, stableRef, registry, repository, tag, source: news.source, digest: result.digest };
        }),
        delete: Effect.fnUntraced(function* ({ output, session }) {
          yield* session.note(`Retained mirrored container image ${output.ref}`);
        }),
      });
    }),
  );
