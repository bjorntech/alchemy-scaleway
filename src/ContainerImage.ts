import { Resource } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { ScalewayCredentials } from "./Credentials.ts";
import { physicalName, resolveRef } from "./Internal.ts";
import type { Providers } from "./Providers.ts";
import type { RegistryNamespace } from "./RegistryNamespace.ts";

export type ContainerImageRegistryRef = string | RegistryNamespace;

export interface ContainerImageProps {
  registry: ContainerImageRegistryRef;
  auth?: ContainerImageRegistryAuth;
  context: string;
  dockerfile?: string;
  repository?: string;
  tag?: string;
  buildArgs?: Record<string, string>;
  target?: string;
  /** Docker build platform. Defaults to `linux/amd64` for Scaleway Serverless Containers. */
  platform?: string;
  cwd?: string;
}

export interface ContainerImageRegistryAuth {
  username: string;
  password: string | Redacted.Redacted<string>;
}

export type ContainerImage = Resource<
  "Scaleway.ContainerImage",
  ContainerImageProps,
  {
    ref: string;
    stableRef: string;
    registry: string;
    repository: string;
    tag: string;
    digest: string;
  },
  never,
  Providers
>;

export const ContainerImage = Resource<ContainerImage>("Scaleway.ContainerImage");

export interface ContainerImageCommand {
  command: string;
  args: string[];
  cwd: string;
  stdin?: string;
}

export type ContainerImageCommandRunner = (command: ContainerImageCommand) => Effect.Effect<void, Error, never>;

const sanitizedArgs = (args: string[]) =>
  args.map((arg, index) => {
    if (args[index - 1] !== "--build-arg") return arg;
    const key = arg.split("=")[0] ?? "ARG";
    return `${key}=<redacted>`;
  });

const defaultRunContainerImageCommand: ContainerImageCommandRunner = ({ command, args, cwd, stdin }) =>
  Effect.try({
    try: () => {
      const result = spawnSync(command, args, {
        cwd,
        input: stdin,
        encoding: "utf8",
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      });
      if (result.status !== 0) {
        const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
        throw new Error(`${command} ${sanitizedArgs(args).join(" ")} failed${output ? `: ${output}` : ""}`);
      }
    },
    catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
  });

let runContainerImageCommand = defaultRunContainerImageCommand;

export const setContainerImageCommandRunner = (runner: ContainerImageCommandRunner) => {
  runContainerImageCommand = runner;
};

export const resetContainerImageCommandRunner = () => {
  runContainerImageCommand = defaultRunContainerImageCommand;
};

const sortedEntries = (path: string): Effect.Effect<{ name: string }[], Error, never> =>
  Effect.tryPromise({
    try: async () => (await readdir(path, { withFileTypes: true })).map((entry) => ({ name: entry.name })).sort((a, b) => a.name.localeCompare(b.name)),
    catch: (cause) => new Error(`Failed to read Docker context ${path}: ${String(cause)}`),
  });

const hashPath = (hash: ReturnType<typeof createHash>, path: string): Effect.Effect<void, Error, never> =>
  Effect.gen(function* () {
    const info = yield* Effect.tryPromise({
      try: () => stat(path),
      catch: (cause) => new Error(`Failed to stat Docker context path ${path}: ${String(cause)}`),
    });
    if (info.isDirectory()) {
      for (const entry of yield* sortedEntries(path)) {
        yield* hashPath(hash, join(path, entry.name));
      }
      return;
    }
    if (!info.isFile()) return;
    hash.update(path);
    hash.update(yield* Effect.tryPromise({
      try: () => readFile(path),
      catch: (cause) => new Error(`Failed to read Docker context file ${path}: ${String(cause)}`),
    }));
  });

const sourceHash = (props: ContainerImageProps): Effect.Effect<string, Error, never> =>
  Effect.gen(function* () {
    const cwd = props.cwd ?? process.cwd();
    const hash = createHash("sha256");
    hash.update(JSON.stringify(props.buildArgs ?? {}));
    hash.update(props.target ?? "");
    hash.update(props.platform ?? "linux/amd64");
    yield* hashPath(hash, resolve(cwd, props.context));
    if (props.dockerfile) yield* hashPath(hash, resolve(cwd, props.dockerfile));
    return `sha256:${hash.digest("hex")}`;
  });

const registryPrefix = (registry: ContainerImageRegistryRef) =>
  typeof registry === "string" ? Effect.succeed(registry) : resolveRef(registry.imagePrefix);

const imageRef = (registry: string, repository: string, tag: string) => `${registry}/${repository}:${tag}`;

const contentTag = (tag: string, digest: string) => {
  const suffix = digest.replace(/^sha256:/, "").slice(0, 12);
  return `${tag.slice(0, 128 - suffix.length - 1)}-${suffix}`;
};

const registryHost = (registry: string) => registry.split("/")[0] ?? registry;

const isScalewayRegistry = (registry: string) => registryHost(registry).endsWith(".scw.cloud");

const registryLogin = (
  registry: string,
  auth: ContainerImageRegistryAuth | undefined,
  scalewaySecretKey: Redacted.Redacted<string>,
) => {
  if (auth) {
    return {
      username: auth.username,
      password: Redacted.isRedacted(auth.password) ? Redacted.value(auth.password) : auth.password,
    };
  }
  if (isScalewayRegistry(registry)) {
    return { username: "nologin", password: Redacted.value(scalewaySecretKey) };
  }
  return undefined;
};

const buildArgs = (args: Record<string, string> | undefined) =>
  Object.entries(args ?? {}).flatMap(([key, value]) => ["--build-arg", `${key}=${value}`]);

// @crap-ignore: provider factory wraps lifecycle closures scored separately.
export const ContainerImageProvider = () =>
  Provider.effect(
    ContainerImage,
    Effect.gen(function* () {
      const credentials = yield* ScalewayCredentials;
      const repositoryName = (id: string, repository?: string) => physicalName(id, repository, { maxLength: 63 });

      return ContainerImage.Provider.of({
        stables: [],
        diff: Effect.fnUntraced(function* ({ id, news, output }) {
          if (!isResolved(news) || !output) return undefined;
          const registry = yield* registryPrefix(news.registry);
          const repository = yield* repositoryName(id, news.repository);
          const requestedTag = news.tag ?? "latest";
          const digest = yield* sourceHash(news);
          const tag = contentTag(requestedTag, digest);
          if (output.ref !== imageRef(registry, repository, tag) || output.digest !== digest) {
            return { action: "update" } as const;
          }
          return { action: "noop" } as const;
        }),
        read: Effect.fnUntraced(function* ({ output }) {
          return output;
        }),
        reconcile: Effect.fnUntraced(function* ({ id, news, session }) {
          const cwd = news.cwd ?? process.cwd();
          const registry = yield* registryPrefix(news.registry);
          const repository = yield* repositoryName(id, news.repository);
          const requestedTag = news.tag ?? "latest";
          const digest = yield* sourceHash(news);
          const tag = contentTag(requestedTag, digest);
          const ref = imageRef(registry, repository, tag);
          const stableRef = imageRef(registry, repository, requestedTag);
          const dockerfile = news.dockerfile ?? join(news.context, "Dockerfile");
          const login = registryLogin(registry, news.auth, credentials.secretKey);
          const dockerBuildArgs = [
            "build",
            "-f",
            dockerfile,
            "-t",
            ref,
            "-t",
            stableRef,
            ...buildArgs(news.buildArgs),
            ...(news.target ? ["--target", news.target] : []),
            "--platform",
            news.platform ?? "linux/amd64",
            news.context,
          ];

          if (login) {
            yield* runContainerImageCommand({
              command: "docker",
              args: ["login", registryHost(registry), "-u", login.username, "--password-stdin"],
              cwd,
              stdin: `${login.password}\n`,
            });
          }
          yield* session.note(`Building Scaleway container image ${ref}`);
          yield* runContainerImageCommand({ command: "docker", args: dockerBuildArgs, cwd });
          yield* session.note(`Pushing Scaleway container image ${ref}`);
          yield* runContainerImageCommand({ command: "docker", args: ["push", ref], cwd });
          yield* runContainerImageCommand({ command: "docker", args: ["push", stableRef], cwd });

          return { ref, stableRef, registry, repository, tag, digest };
        }),
        delete: Effect.fnUntraced(function* ({ output, session }) {
          yield* session.note(`Retained Scaleway container image ${output.ref}`);
        }),
      });
    }),
  );
