import { Resource } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
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
const dockerLoginLocks = new Map<string, Promise<void>>();
const dockerLoggedIn = new Set<string>();
const dockerRegistryRetryDelays = [250, 1_000, 2_000];
const dockerPushLocks = new Map<string, Promise<void>>();

export const setContainerImageCommandRunner = (runner: ContainerImageCommandRunner) => {
  runContainerImageCommand = runner;
};

export const resetContainerImageCommandRunner = () => {
  runContainerImageCommand = defaultRunContainerImageCommand;
  dockerLoginLocks.clear();
  dockerLoggedIn.clear();
  dockerPushLocks.clear();
};

function isTransientDockerRegistryError(error: unknown) {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  if (message === "eof") return true;
  return [
    "500 internal server error",
    "502 bad gateway",
    "client.timeout exceeded while awaiting headers",
    "request canceled",
    "request cancelled",
    "connection reset",
    "connection refused",
    "econnreset",
    "econnrefused",
    "etimedout",
    "i/o timeout",
    "tls handshake timeout",
    "unexpected eof",
    " eof",
    ": eof",
  ].some((needle) => message.includes(needle));
}

async function runDockerRegistryCommandWithRetry(command: ContainerImageCommand) {
  let lastError: unknown;
  for (const delay of [0, ...dockerRegistryRetryDelays]) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      await Effect.runPromise(runContainerImageCommand(command));
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientDockerRegistryError(error)) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

const runDockerLoginOnce = (key: string, command: ContainerImageCommand) =>
  Effect.tryPromise({
    try: () => {
      const previous = dockerLoginLocks.get(key) ?? Promise.resolve();
      const current = previous
        .catch(() => undefined)
        .then(() => {
          if (dockerLoggedIn.has(key)) return undefined;
          return runDockerRegistryCommandWithRetry(command).then(() => {
            dockerLoggedIn.add(key);
          });
        });
      const tracked = current.finally(() => {
        if (dockerLoginLocks.get(key) === tracked) dockerLoginLocks.delete(key);
      });
      dockerLoginLocks.set(key, tracked);
      return current;
    },
    catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
  });

const runDockerPushQueued = (key: string, command: ContainerImageCommand) =>
  Effect.tryPromise({
    try: () => {
      const previous = dockerPushLocks.get(key) ?? Promise.resolve();
      const current = previous.catch(() => undefined).then(() => runDockerRegistryCommandWithRetry(command));
      const tracked = current.finally(() => {
        if (dockerPushLocks.get(key) === tracked) dockerPushLocks.delete(key);
      });
      dockerPushLocks.set(key, tracked);
      return current;
    },
    catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
  });

const sortedEntries = (path: string): Effect.Effect<{ name: string }[], Error, never> =>
  Effect.tryPromise({
    try: async () => (await readdir(path, { withFileTypes: true })).map((entry) => ({ name: entry.name })).sort((a, b) => a.name.localeCompare(b.name)),
    catch: (cause) => new Error(`Failed to read Docker context ${path}: ${String(cause)}`),
  });

interface DockerIgnoreRule {
  pattern: string;
  negated: boolean;
  directoryOnly: boolean;
  regex: RegExp;
}

const toDockerPath = (path: string) => path.split(sep).join("/");

const regexEscape = (value: string) => value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
const globTokenRegex = (token: string) =>
  token === "**" ? ".*" : token === "*" ? "[^/]*" : token === "?" ? "[^/]" : regexEscape(token);

const globRegex = (pattern: string) =>
  new RegExp(`^${pattern.match(/\*\*|\*|\?|[^*?]+/g)?.map(globTokenRegex).join("") ?? ""}$`);

const parseDockerIgnore = (content: string): DockerIgnoreRule[] =>
  content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .flatMap((line) => {
      const negated = line.startsWith("!");
      const raw = negated ? line.slice(1).trim() : line;
      const directoryOnly = raw.endsWith("/");
      const pattern = raw.replace(/^\/+/, "").replace(/\/+$/, "");
      return pattern && pattern !== "." ? [{ pattern, negated, directoryOnly, regex: globRegex(pattern) }] : [];
    });

const readDockerIgnore = (contextRoot: string): Effect.Effect<DockerIgnoreRule[], Error, never> =>
  Effect.tryPromise({
    try: async () => {
      try {
        return parseDockerIgnore(await readFile(join(contextRoot, ".dockerignore"), "utf8"));
      } catch (cause) {
        if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return [];
        throw cause;
      }
    },
    catch: (cause) => new Error(`Failed to read Docker ignore file ${join(contextRoot, ".dockerignore")}: ${String(cause)}`),
  });

const pathParts = (path: string) => path.split("/").filter(Boolean);

const matchesRulePattern = (rule: DockerIgnoreRule, path: string) => {
  if (rule.pattern.includes("/")) return rule.regex.test(path);
  return pathParts(path).some((part) => rule.regex.test(part));
};

const directoryPrefixes = (path: string, isDirectory: boolean) => {
  const parts = pathParts(path);
  const last = isDirectory ? parts.length : parts.length - 1;
  return Array.from({ length: Math.max(last, 0) }, (_, index) => parts.slice(0, index + 1).join("/"));
};

const matchesRule = (rule: DockerIgnoreRule, path: string, isDirectory: boolean) =>
  rule.directoryOnly
    ? directoryPrefixes(path, isDirectory).some((prefix) => matchesRulePattern(rule, prefix))
    : matchesRulePattern(rule, path);

const isIgnored = (rules: DockerIgnoreRule[], path: string, isDirectory: boolean) => {
  let ignored = false;
  for (const rule of rules) {
    if (matchesRule(rule, path, isDirectory)) ignored = !rule.negated;
  }
  return ignored;
};

const hasNegatedDescendantRule = (rules: DockerIgnoreRule[], path: string) =>
  rules.some((rule) => rule.negated && rule.pattern.includes("/") && rule.pattern.startsWith(`${path}/`));

const hashPath = (
  hash: ReturnType<typeof createHash>,
  contextRoot: string,
  path: string,
  rules: DockerIgnoreRule[],
): Effect.Effect<void, Error, never> =>
  Effect.gen(function* () {
    const info = yield* Effect.tryPromise({
      try: () => lstat(path),
      catch: (cause) => new Error(`Failed to stat Docker context path ${path}: ${String(cause)}`),
    });
    const relativePath = toDockerPath(relative(contextRoot, path));
    if (relativePath && isIgnored(rules, relativePath, info.isDirectory())) {
      if (!info.isDirectory() || !hasNegatedDescendantRule(rules, relativePath)) return;
    }
    if (info.isDirectory()) {
      for (const entry of yield* sortedEntries(path)) {
        yield* hashPath(hash, contextRoot, join(path, entry.name), rules);
      }
      return;
    }
    hash.update(relativePath || ".");
    if (info.isSymbolicLink()) {
      hash.update("symlink");
      hash.update(yield* Effect.tryPromise({
        try: () => readlink(path),
        catch: (cause) => new Error(`Failed to read Docker context symlink ${path}: ${String(cause)}`),
      }));
      return;
    }
    if (!info.isFile()) return;
    hash.update("file");
    hash.update(yield* Effect.tryPromise({
      try: () => readFile(path),
      catch: (cause) => new Error(`Failed to read Docker context file ${path}: ${String(cause)}`),
    }));
  });

const pathExists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

/**
 * Preserves existing cwd-relative `dockerfile` behavior when that path exists,
 * then falls back to context-relative resolution for Docker CLI ergonomics.
 */
const resolveDockerfile = (
  cwd: string,
  context: string,
  dockerfile: string,
): Effect.Effect<string, Error, never> =>
  Effect.tryPromise({
    try: async () => {
      const cwdCandidate = resolve(cwd, dockerfile);
      if (await pathExists(cwdCandidate)) return cwdCandidate;
      const contextCandidate = resolve(cwd, context, dockerfile);
      if (contextCandidate !== cwdCandidate && (await pathExists(contextCandidate))) return contextCandidate;
      throw new Error(
        `Dockerfile ${dockerfile} not found relative to context (${contextCandidate})${
          cwdCandidate !== contextCandidate ? ` or working directory (${cwdCandidate})` : ""
        }`,
      );
    },
    catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
  });

const sourceHash = (props: ContainerImageProps): Effect.Effect<string, Error, never> =>
  Effect.gen(function* () {
    const cwd = props.cwd ?? process.cwd();
    const contextRoot = resolve(cwd, props.context);
    const ignoreRules = yield* readDockerIgnore(contextRoot);
    const hash = createHash("sha256");
    hash.update(JSON.stringify(props.buildArgs ?? {}));
    hash.update(props.target ?? "");
    hash.update(props.platform ?? "linux/amd64");
    yield* hashPath(hash, contextRoot, contextRoot, ignoreRules);
    if (props.dockerfile) {
      const dockerfilePath = yield* resolveDockerfile(cwd, props.context, props.dockerfile);
      if (toDockerPath(relative(contextRoot, dockerfilePath)).startsWith("..")) hash.update(`dockerfile:${toDockerPath(relative(cwd, dockerfilePath))}`);
      yield* hashPath(hash, contextRoot, dockerfilePath, []);
    }
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
        stables: ["ref", "stableRef", "registry", "repository", "tag", "digest"],
        list: () => Effect.succeed([]),
        diff: Effect.fnUntraced(function* ({ id, news, output }) {
          if (!isResolved(news) || !output) return undefined;
          const registry = yield* registryPrefix(news.registry);
          const repository = yield* repositoryName(id, news.repository);
          const requestedTag = news.tag ?? "latest";
          const digest = yield* sourceHash(news);
          const tag = contentTag(requestedTag, digest);
          const nextRef = imageRef(registry, repository, tag);
          if (output.ref !== nextRef || output.digest !== digest) {
            return {
              action: "update",
              stables: ["stableRef", "registry", "repository"],
            } as const;
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
          const dockerfile = news.dockerfile
            ? yield* resolveDockerfile(cwd, news.context, news.dockerfile)
            : join(news.context, "Dockerfile");
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
            yield* runDockerLoginOnce(`${registryHost(registry)}:${login.username}`, {
              command: "docker",
              args: ["login", registryHost(registry), "-u", login.username, "--password-stdin"],
              cwd,
              stdin: `${login.password}\n`,
            });
          }
          yield* session.note(`Building Scaleway container image ${ref}`);
          yield* runContainerImageCommand({ command: "docker", args: dockerBuildArgs, cwd });
          yield* session.note(`Pushing Scaleway container image ${ref}`);
          yield* runDockerPushQueued(registryHost(registry), { command: "docker", args: ["push", ref], cwd });
          yield* runDockerPushQueued(registryHost(registry), { command: "docker", args: ["push", stableRef], cwd });

          return { ref, stableRef, registry, repository, tag, digest };
        }),
        delete: Effect.fnUntraced(function* ({ output, session }) {
          yield* session.note(`Retained Scaleway container image ${output.ref}`);
        }),
      });
    }),
  );
