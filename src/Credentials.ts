import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { AuthError, AuthProviders } from "alchemy/Auth/AuthProvider";
import { ProfileStore } from "alchemy/Auth/Profile";
import {
  deferUntilFirstUse,
  orDieCredentialsUnavailable,
  resolveProviderConfig,
} from "alchemy/Auth/Resolve";
import {
  SCALEWAY_AUTH_PROVIDER_NAME,
  type ScalewayAuthConfig,
  type ScalewayResolvedCredentials,
} from "./AuthProvider.ts";

export interface ScalewayCredentialsService {
  accessKey?: string;
  secretKey: Redacted.Redacted<string>;
  projectId?: string;
  region: string;
  apiUrl: string;
}

export class ScalewayCredentials extends Context.Service<
  ScalewayCredentials,
  Effect.Effect<ScalewayCredentialsService>
>()("Scaleway.Credentials") {}

const resolveScalewayCredentials: Effect.Effect<
  ScalewayCredentialsService,
  AuthError,
  AuthProviders | ProfileStore
> = resolveProviderConfig<
  ScalewayAuthConfig,
  ScalewayResolvedCredentials
>(SCALEWAY_AUTH_PROVIDER_NAME).pipe(
  Effect.flatMap(({ profileName, resolve }) =>
    resolve.pipe(
      Effect.map(createScalewayCredentials),
      Effect.mapError(
        (error) =>
          new AuthError({
            message: `Failed to resolve Scaleway credentials from ${profileName === undefined ? "the CI environment" : `profile '${profileName}'`}: ${error.message}`,
            cause: error,
          }),
      ),
    ),
  ),
  Effect.mapError(
    (error) =>
      new AuthError({
        message: `Failed to resolve Scaleway credentials: ${error.message}`,
        cause: error,
      }),
  ),
);

export const fromAuthProvider = () =>
  Layer.effect(
    ScalewayCredentials,
    Effect.gen(function* () {
      const resolve = yield* deferUntilFirstUse(resolveScalewayCredentials);
      return yield* resolve.pipe(
        orDieCredentialsUnavailable(SCALEWAY_AUTH_PROVIDER_NAME),
        Effect.cached,
      );
    }),
  );

export function createScalewayCredentials(
  credentials: ScalewayResolvedCredentials,
): ScalewayCredentialsService {
  return {
    accessKey: credentials.accessKey,
    secretKey: credentials.secretKey,
    projectId: credentials.projectId,
    region: credentials.region,
    apiUrl: credentials.apiUrl,
  };
}
