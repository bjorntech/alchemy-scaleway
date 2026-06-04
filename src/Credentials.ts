import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { getAuthProvider } from "alchemy/Auth/AuthProvider";
import { ALCHEMY_PROFILE, Profile } from "alchemy/Auth/Profile";
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
  ScalewayCredentialsService
>()("Scaleway.Credentials") {}

export const fromAuthProvider = () =>
  Layer.effect(
    ScalewayCredentials,
    Effect.gen(function* () {
      const profile = yield* Profile;
      const auth = yield* getAuthProvider<ScalewayAuthConfig, ScalewayResolvedCredentials>(
        SCALEWAY_AUTH_PROVIDER_NAME,
      );
      const profileName = yield* ALCHEMY_PROFILE;
      const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));
      const resolved = yield* profile
        .loadOrConfigure(auth, profileName, { ci })
        .pipe(Effect.flatMap((config) => auth.read(profileName, config)));
      return createScalewayCredentials(resolved);
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
