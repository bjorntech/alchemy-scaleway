import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  AuthError,
  AuthProviderLayer,
  type ConfigureField,
  type ConfigureMethod,
  type ProviderDetails,
} from "alchemy/Auth/AuthProvider";
import { CredentialsStore, displayRedacted } from "alchemy/Auth/Credentials";
import { getEnv, getEnvRedacted, mapPromptCancellation } from "alchemy/Auth/Env";
import { storedSecret, storedValueText, validateFieldValues } from "alchemy/Auth/StoredAuthProvider";
import * as Interaction from "alchemy/Interaction";

export const SCALEWAY_AUTH_PROVIDER_NAME = "Scaleway";
export const SCALEWAY_AUTH_STORAGE_KEY = "scaleway-stored";

export const ScalewayAuthConfigSchema = Schema.Union([
  Schema.Struct({ method: Schema.Literal("env") }),
  Schema.Struct({ method: Schema.Literal("stored") }),
]);

export type ScalewayAuthConfig = typeof ScalewayAuthConfigSchema.Type;

export const ScalewayStoredCredentialsSchema = Schema.Struct({
  accessKey: Schema.optional(Schema.String),
  secretKey: Schema.NonEmptyString,
  projectId: Schema.optional(Schema.String),
  region: Schema.optional(Schema.String),
  apiUrl: Schema.optional(Schema.String),
});

export type ScalewayStoredCredentials = typeof ScalewayStoredCredentialsSchema.Type;

export interface ScalewayResolvedCredentials {
  method: ScalewayAuthConfig["method"];
  accessKey?: string;
  secretKey: Redacted.Redacted<string>;
  projectId?: string;
  region: string;
  apiUrl: string;
  source: { type: ScalewayAuthConfig["method"] | "env" };
}

const DEFAULT_API_URL = "https://api.scaleway.com";
const DEFAULT_REGION = "fr-par";

const isRegion = (value: string) => /^[a-z]{2}-[a-z]+$/.test(value);

const quoteShellArgument = (value: string) =>
  /^[A-Za-z0-9._-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'"'"'`)}'`;

const reconfigureHint = (profileName: string) =>
  `Run \`alchemy profile edit --profile ${quoteShellArgument(profileName)} --reconfigure ${SCALEWAY_AUTH_PROVIDER_NAME}\` to reconfigure.`;

const validateRegion = (region: string) =>
  isRegion(region)
    ? Effect.succeed(region)
    : Effect.fail(
        new AuthError({
          message:
            "Invalid Scaleway region. Use a region slug like fr-par, nl-ams, pl-waw, or it-mil.",
        }),
      );

/**
 * `--set` fields for `alchemy profile edit --add Scaleway --method stored`.
 * Each maps to the stored credential property of the same name.
 */
export const scalewayStoredFields: ReadonlyArray<ConfigureField> = [
  { name: "secretKey", label: "Scaleway Secret Key", secret: true },
  {
    name: "accessKey",
    label: "Scaleway Access Key",
    description: "Required for Object Storage.",
    secret: true,
    optional: true,
  },
  {
    name: "projectId",
    label: "Scaleway Project ID",
    description: "Required for Containers unless passed per resource.",
    optional: true,
  },
  {
    name: "region",
    label: "Scaleway Region",
    defaultValue: DEFAULT_REGION,
    validate: (value) => (isRegion(value) ? undefined : "Expected a region slug like fr-par"),
  },
  { name: "apiUrl", label: "Scaleway API URL", placeholder: DEFAULT_API_URL, optional: true },
];

/**
 * Flag-driven configuration: `stored` persists the `--set` fields to the
 * profile's credentials file; `env` reads the `SCW_*` variables at use time.
 */
export const scalewayConfigureMethods: ReadonlyArray<ConfigureMethod> = [
  { method: "stored", fields: scalewayStoredFields },
  { method: "env", fields: [] },
];

const toAuthError = (message: string) => (cause: unknown) =>
  new AuthError({ message, cause });

export const scalewayDetails = (
  credentials: ScalewayResolvedCredentials,
): ProviderDetails => ({
  lines: [
    { key: "region", value: credentials.region },
    ...(credentials.projectId
      ? [{ key: "projectId", value: credentials.projectId }]
      : []),
    ...(credentials.accessKey
      ? [
          {
            key: "accessKey",
            value: displayRedacted(Redacted.make(credentials.accessKey)),
          },
        ]
      : []),
    { key: "secretKey", value: displayRedacted(credentials.secretKey) },
  ],
});

export const resolveFromEnv = (): Effect.Effect<ScalewayResolvedCredentials, AuthError> =>
  Effect.gen(function* () {
    const secretKey = yield* getEnvRedacted("SCW_SECRET_KEY");
    if (!secretKey) {
      return yield* new AuthError({
        message: "Scaleway env credentials not found. Set SCW_SECRET_KEY.",
      });
    }
    if (Redacted.value(secretKey).length === 0) {
      return yield* new AuthError({
        message: "Scaleway env credentials not found. Set SCW_SECRET_KEY.",
      });
    }

    const region = yield* validateRegion(
      (yield* getEnv("SCW_DEFAULT_REGION")) ?? DEFAULT_REGION,
    );
    return {
      method: "env" as const,
      accessKey: (yield* getEnv("SCW_ACCESS_KEY")) ?? undefined,
      secretKey,
      projectId: (yield* getEnv("SCW_DEFAULT_PROJECT_ID")) ?? undefined,
      region,
      apiUrl: (yield* getEnv("SCW_API_URL")) ?? DEFAULT_API_URL,
      source: { type: "env" as const },
    };
  });

export const resolveFromStored = (
  creds: ScalewayStoredCredentials | undefined,
  profileName = "default",
): Effect.Effect<ScalewayResolvedCredentials, AuthError> =>
  Effect.gen(function* () {
    if (!creds) {
      return yield* new AuthError({
        message: `Scaleway stored credentials not found. ${reconfigureHint(profileName)}`,
      });
    }
    const region = yield* validateRegion(creds.region ?? DEFAULT_REGION);
    return {
      method: "stored" as const,
      accessKey: creds.accessKey,
      secretKey: Redacted.make(creds.secretKey),
      projectId: creds.projectId,
      region,
      apiUrl: creds.apiUrl ?? DEFAULT_API_URL,
      source: { type: "stored" as const },
    };
  });

export const ScalewayAuth = AuthProviderLayer<
  ScalewayAuthConfig,
  ScalewayResolvedCredentials
>()(
  SCALEWAY_AUTH_PROVIDER_NAME,
  Effect.gen(function* () {
    const store = yield* CredentialsStore;
    const interaction = Interaction.accessors;

    const promptStoredFields = Effect.gen(function* () {
      const secretKey = yield* interaction.prompt
          .password({
            message: "Scaleway Secret Key",
            validate: (value) => (value.length === 0 ? "Required" : undefined),
          })
          .pipe(mapPromptCancellation);
      const accessKey = yield* interaction.prompt
          .text({
            message: "Scaleway Access Key (optional, for Object Storage)",
            placeholder: (yield* getEnv("SCW_ACCESS_KEY")) ?? "",
          })
          .pipe(mapPromptCancellation);
      const projectId = yield* interaction.prompt
          .text({
            message:
              "Scaleway Project ID (optional, required for Containers unless passed per resource)",
            placeholder: (yield* getEnv("SCW_DEFAULT_PROJECT_ID")) ?? "",
          })
          .pipe(mapPromptCancellation);
      const region = yield* interaction.prompt
          .text({
            message: "Scaleway Region",
            placeholder: (yield* getEnv("SCW_DEFAULT_REGION")) ?? DEFAULT_REGION,
            validate: (value) =>
              value.length === 0 || isRegion(value)
                ? undefined
                : "Expected a region slug like fr-par",
          })
          .pipe(mapPromptCancellation);

      return {
        secretKey,
        accessKey: accessKey || undefined,
        projectId: projectId || undefined,
        region: region || DEFAULT_REGION,
      };
    });

    const promptStored = (profileName: string) =>
      Effect.gen(function* () {
        const credentials = yield* promptStoredFields;
        yield* store.write(
          profileName,
          SCALEWAY_AUTH_STORAGE_KEY,
          ScalewayStoredCredentialsSchema,
          credentials,
        );
        yield* interaction.output.success("Scaleway: credentials saved.");
        return { method: "stored" as const };
      });

    const configure = (
      _profileName: string,
    ): Effect.Effect<ScalewayAuthConfig, AuthError, Interaction.Interaction> =>
      interaction.prompt
        .select({
          message: "Scaleway authentication method",
          options: [
            {
              value: "env" as const,
              label: "Environment Variables",
              description: "SCW_SECRET_KEY plus optional Scaleway environment variables",
            },
            {
              value: "stored" as const,
              label: "Stored Credentials",
              description: "Enter credentials interactively",
            },
          ],
        })
        .pipe(
          mapPromptCancellation,
          Effect.flatMap(
            (method): Effect.Effect<ScalewayAuthConfig, AuthError, Interaction.Interaction> =>
            method === "stored"
              ? promptStored(_profileName)
              : Effect.succeed({ method: "env" as const }),
          ),
          Effect.mapError((error) =>
            error instanceof AuthError
              ? error
              : new AuthError({ message: "Failed to configure Scaleway credentials", cause: error }),
          ),
        );

    const configureWith = (
      profileName: string,
      input: { readonly method: string; readonly values: Record<string, string> },
    ): Effect.Effect<ScalewayAuthConfig, AuthError, Interaction.Interaction> => {
      if (input.method === "env") return Effect.succeed({ method: "env" as const });
      if (input.method !== "stored") {
        return Effect.fail(
          new AuthError({
            message: `Scaleway: unknown method '${input.method}'. Valid methods: stored, env.`,
          }),
        );
      }
      return validateFieldValues(SCALEWAY_AUTH_PROVIDER_NAME, scalewayStoredFields, input.values).pipe(
        Effect.map((values) => ({
          secretKey: Redacted.value(storedSecret(values.secretKey) ?? Redacted.make("")),
          accessKey: storedValueText(values.accessKey),
          projectId: storedValueText(values.projectId),
          region: storedValueText(values.region),
          apiUrl: storedValueText(values.apiUrl),
        })),
        Effect.flatMap((credentials) =>
          store
            .write(profileName, SCALEWAY_AUTH_STORAGE_KEY, ScalewayStoredCredentialsSchema, credentials)
            .pipe(Effect.mapError(toAuthError("Failed to save Scaleway stored credentials"))),
        ),
        Effect.andThen(interaction.output.success("Scaleway: credentials saved.")),
        Effect.as({ method: "stored" as const }),
      );
    };

    const read = (profileName: string, config: ScalewayAuthConfig) =>
      Match.value(config).pipe(
        Match.when({ method: "env" }, () => resolveFromEnv()),
        Match.when({ method: "stored" }, () =>
          store
            .read(profileName, SCALEWAY_AUTH_STORAGE_KEY, ScalewayStoredCredentialsSchema)
            .pipe(
              Effect.mapError(toAuthError("Failed to read Scaleway stored credentials")),
              Effect.flatMap((credentials) => resolveFromStored(credentials, profileName)),
            ),
        ),
        Match.exhaustive,
      );

    const login = (profileName: string, config: ScalewayAuthConfig) =>
      Match.value(config).pipe(
        Match.when({ method: "env" }, () => resolveFromEnv().pipe(Effect.asVoid)),
        Match.when({ method: "stored" }, () =>
          store
            .read(profileName, SCALEWAY_AUTH_STORAGE_KEY, ScalewayStoredCredentialsSchema)
            .pipe(
              Effect.mapError(toAuthError("Failed to read Scaleway stored credentials")),
              Effect.flatMap((credentials) =>
                credentials ? Effect.void : promptStored(profileName).pipe(Effect.asVoid),
              ),
            ),
        ),
        Match.exhaustive,
        Effect.mapError((error) =>
          error instanceof AuthError ? error : toAuthError("Scaleway login failed")(error),
        ),
      );

    const logout = (profileName: string, config: ScalewayAuthConfig) =>
      Match.value(config).pipe(
        Match.when({ method: "env" }, () => Effect.void),
        Match.when({ method: "stored" }, () =>
          store.delete(profileName, SCALEWAY_AUTH_STORAGE_KEY).pipe(
            Effect.mapError(toAuthError("Failed to delete Scaleway stored credentials")),
            Effect.andThen(interaction.output.success("Scaleway: stored credentials removed")),
          ),
        ),
        Match.exhaustive,
      );

    const details = (
      profileName: string,
      config: ScalewayAuthConfig,
    ): Effect.Effect<ProviderDetails, AuthError> =>
      read(profileName, config).pipe(Effect.map(scalewayDetails));

    return {
      configSchema: ScalewayAuthConfigSchema,
      configure,
      configureWith,
      configureMethods: scalewayConfigureMethods,
      login,
      logout,
      details,
      read,
      readEnvironment: resolveFromEnv(),
      environment: [
        { name: "SCW_SECRET_KEY", required: true, secret: true },
        { name: "SCW_ACCESS_KEY", required: false, secret: true },
        { name: "SCW_DEFAULT_PROJECT_ID", required: false },
        { name: "SCW_DEFAULT_REGION", required: false },
        { name: "SCW_API_URL", required: false },
      ],
    };
  }),
);
