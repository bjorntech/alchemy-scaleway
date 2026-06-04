import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import {
  AuthError,
  AuthProviderLayer,
  type ConfigureContext,
} from "alchemy/Auth/AuthProvider";
import { CredentialsStore, displayRedacted } from "alchemy/Auth/Credentials";
import { getEnv, getEnvRedacted, retryOnce } from "alchemy/Auth/Env";
import * as Clank from "alchemy/Util/Clank";

export const SCALEWAY_AUTH_PROVIDER_NAME = "Scaleway";
export const SCALEWAY_AUTH_STORAGE_KEY = "scaleway-stored";

export type ScalewayAuthConfig = { method: "env" } | { method: "stored" };

export interface ScalewayStoredCredentials {
  accessKey?: string;
  secretKey: string;
  projectId?: string;
  region?: string;
  apiUrl?: string;
}

export interface ScalewayResolvedCredentials {
  method: ScalewayAuthConfig["method"];
  accessKey?: string;
  secretKey: Redacted.Redacted<string>;
  projectId?: string;
  region: string;
  apiUrl: string;
  source: { type: ScalewayAuthConfig["method"] };
}

const DEFAULT_API_URL = "https://api.scaleway.com";
const DEFAULT_REGION = "fr-par";

const isRegion = (value: string) => /^[a-z]{2}-[a-z]+$/.test(value);

const validateRegion = (region: string) =>
  isRegion(region)
    ? Effect.succeed(region)
    : Effect.fail(
        new AuthError({
          message:
            "Invalid Scaleway region. Use a region slug like fr-par, nl-ams, pl-waw, or it-mil.",
        }),
      );

const toAuthError = (message: string) => (cause: unknown) =>
  new AuthError({
    message,
    cause,
  });

export const resolveFromEnv = (): Effect.Effect<ScalewayResolvedCredentials, AuthError> =>
  Effect.gen(function* () {
    const secretKey = yield* getEnvRedacted("SCW_SECRET_KEY");
    if (!secretKey) {
      return yield* new AuthError({
        message: "Scaleway env credentials not found. Set SCW_SECRET_KEY.",
      });
    }

    const region = yield* validateRegion((yield* getEnv("SCW_DEFAULT_REGION")) ?? DEFAULT_REGION);
    return {
      method: "env",
      accessKey: (yield* getEnv("SCW_ACCESS_KEY")) ?? undefined,
      secretKey,
      projectId: (yield* getEnv("SCW_DEFAULT_PROJECT_ID")) ?? undefined,
      region,
      apiUrl: (yield* getEnv("SCW_API_URL")) ?? DEFAULT_API_URL,
      source: { type: "env" },
    };
  });

export const resolveFromStored = (
  creds: ScalewayStoredCredentials | undefined,
): Effect.Effect<ScalewayResolvedCredentials, AuthError> =>
  Effect.gen(function* () {
    if (!creds) {
      return yield* new AuthError({
        message: "Scaleway stored credentials not found. Run: alchemy login --configure",
      });
    }
    const region = yield* validateRegion(creds.region ?? DEFAULT_REGION);
    return {
      method: "stored",
      accessKey: creds.accessKey,
      secretKey: Redacted.make(creds.secretKey),
      projectId: creds.projectId,
      region,
      apiUrl: creds.apiUrl ?? DEFAULT_API_URL,
      source: { type: "stored" },
    };
  });

export const ScalewayAuth = AuthProviderLayer<
  ScalewayAuthConfig,
  ScalewayResolvedCredentials
>()(
  SCALEWAY_AUTH_PROVIDER_NAME,
  Effect.gen(function* () {
    const store = yield* CredentialsStore;

    const promptStored = Effect.fnUntraced(function* (profileName: string) {
      const secretKey = yield* Clank.password({
        message: "Scaleway Secret Key",
        validate: (value) => (value.length === 0 ? "Required" : undefined),
      }).pipe(retryOnce);
      const accessKey = yield* Clank.text({
        message: "Scaleway Access Key (optional, for Object Storage)",
        placeholder: (yield* getEnv("SCW_ACCESS_KEY")) ?? "",
      }).pipe(retryOnce);
      const projectId = yield* Clank.text({
        message: "Scaleway Project ID (optional, required for Containers unless passed per resource)",
        placeholder: (yield* getEnv("SCW_DEFAULT_PROJECT_ID")) ?? "",
      }).pipe(retryOnce);
      const region = yield* Clank.text({
        message: "Scaleway Region",
        placeholder: (yield* getEnv("SCW_DEFAULT_REGION")) ?? DEFAULT_REGION,
        validate: (value) => (value.length === 0 || isRegion(value) ? undefined : "Expected a region slug like fr-par"),
      }).pipe(retryOnce);

      yield* store.write<ScalewayStoredCredentials>(profileName, SCALEWAY_AUTH_STORAGE_KEY, {
        secretKey,
        accessKey: accessKey || undefined,
        projectId: projectId || undefined,
        region: region || DEFAULT_REGION,
      });
      yield* Clank.success("Scaleway: credentials saved.");
      return { method: "stored" as const };
    });

    const configureCredentials = (profileName: string, ctx: ConfigureContext) =>
      Effect.gen(function* () {
        if (ctx.ci) return { method: "env" as const };
        const method = yield* Clank.select({
          message: "Scaleway authentication method",
          options: [
            { value: "env" as const, label: "Environment Variables", hint: "SCW_SECRET_KEY + optional SCW_ACCESS_KEY/PROJECT_ID/REGION" },
            { value: "stored" as const, label: "Stored Credentials", hint: "enter interactively, stored in ~/.alchemy/credentials" },
          ],
        }).pipe(retryOnce);
        return yield* Match.value(method).pipe(
          Match.when("env", () => Effect.succeed({ method: "env" as const })),
          Match.when("stored", () => promptStored(profileName)),
          Match.exhaustive,
        );
      }).pipe(
        Effect.mapError(
          (e) =>
            new AuthError({
              message: `Failed to configure Scaleway credentials: ${e instanceof Error ? e.message : String(e)}`,
            }),
        ),
      );

    const read = (profileName: string, config: ScalewayAuthConfig) =>
      Match.value(config).pipe(
        Match.when({ method: "env" }, () => resolveFromEnv()),
        Match.when({ method: "stored" }, () =>
          store.read<ScalewayStoredCredentials>(profileName, SCALEWAY_AUTH_STORAGE_KEY).pipe(
            Effect.mapError(toAuthError("Failed to read Scaleway stored credentials")),
            Effect.flatMap(resolveFromStored),
          ),
        ),
        Match.exhaustive,
      );

    const login = (profileName: string, config: ScalewayAuthConfig) =>
      Match.value(config)
        .pipe(
          Match.when({ method: "env" }, () => resolveFromEnv().pipe(Effect.asVoid)),
          Match.when({ method: "stored" }, () =>
            store.read<ScalewayStoredCredentials>(profileName, SCALEWAY_AUTH_STORAGE_KEY).pipe(
              Effect.mapError(toAuthError("Failed to read Scaleway stored credentials")),
              Effect.flatMap((creds) => (creds ? Effect.void : promptStored(profileName).pipe(Effect.asVoid))),
            ),
          ),
          Match.exhaustive,
        )
        .pipe(Effect.mapError((error) => (error instanceof AuthError ? error : toAuthError("Scaleway login failed")(error))));

    const logout = (profileName: string, config: ScalewayAuthConfig) =>
      Match.value(config)
        .pipe(
          Match.when({ method: "env" }, () => Effect.void),
          Match.when({ method: "stored" }, () =>
            store.delete(profileName, SCALEWAY_AUTH_STORAGE_KEY).pipe(
              Effect.mapError(toAuthError("Failed to delete Scaleway stored credentials")),
              Effect.andThen(Clank.success("Scaleway: stored credentials removed")),
            ),
          ),
          Match.exhaustive,
        )
        .pipe(Effect.mapError((error) => (error instanceof AuthError ? error : toAuthError("Scaleway logout failed")(error))));

    const prettyPrint = (profileName: string, config: ScalewayAuthConfig) =>
      read(profileName, config).pipe(
        Effect.tap((credentials) =>
          Effect.all([
            Console.log(`  region: ${credentials.region}`),
            credentials.projectId ? Console.log(`  projectId: ${credentials.projectId}`) : Effect.void,
            credentials.accessKey ? Console.log(`  accessKey: ${credentials.accessKey}`) : Effect.void,
            Console.log(`  secretKey: ${displayRedacted(credentials.secretKey)}`),
          ]),
        ),
        Effect.catch((error) => Console.error(`  Failed to retrieve credentials: ${error}`)),
      );

    return { configure: configureCredentials, login, logout, prettyPrint, read };
  }),
);
