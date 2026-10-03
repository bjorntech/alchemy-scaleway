import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Interaction from "alchemy/Interaction";
import { AuthProviders } from "alchemy/Auth/AuthProvider";
import {
  CredentialsStore,
  type CredentialsStoreService,
} from "alchemy/Auth/Credentials";
import {
  ScalewayAuth,
  scalewayDetails,
  ScalewayStoredCredentialsSchema,
  resolveFromStored,
} from "../src/AuthProvider.ts";

const makeStore = (
  credentials:
    | {
        secretKey: string;
        accessKey?: string;
        projectId?: string;
        region?: string;
      }
    | undefined,
) =>
  ({
    read: (() => Effect.succeed(credentials)) as CredentialsStoreService["read"],
    write: () => Effect.void,
    delete: () => Effect.void,
    deleteProfile: () => Effect.void,
  }) satisfies CredentialsStoreService;

const makeInteraction = () => {
  const messages: string[] = [];
  const interaction = Interaction.Interaction.of({
    output: {
      info: (message) => Effect.sync(() => messages.push(String(message))),
      success: (message) => Effect.sync(() => messages.push(String(message))),
      warning: (message) => Effect.sync(() => messages.push(String(message))),
      error: (message) => Effect.sync(() => messages.push(String(message))),
    },
    prompt: {
      password: () => Effect.succeed("stored-secret"),
      text: ({ message }: { message: string }) =>
        Effect.succeed(
          message.includes("Access")
            ? "stored-access"
            : message.includes("Project")
              ? "stored-project"
              : "nl-ams",
        ),
      confirm: () => Effect.succeed(true),
      select: (() => Effect.succeed("stored")) as Interaction.Interaction["Service"]["prompt"]["select"],
      multiSelect: () => Effect.succeed([]),
      awaitExternal: () => Effect.succeed("done"),
    },
    task: (_options, effect) => effect,
  });
  return { interaction, messages };
};

const getAuth = async (credentials?: Parameters<typeof makeStore>[0]) => {
  const registry: Record<string, any> = {};
  const context = await Effect.runPromise(
    Effect.scoped(
      (Layer.build(ScalewayAuth) as Effect.Effect<unknown, never, never>).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(CredentialsStore, makeStore(credentials)),
            Layer.succeed(AuthProviders, registry),
          ),
        ),
      ),
    ),
  );
  void context;
  return registry.Scaleway;
};

describe("Alchemy beta80 Scaleway auth", () => {
  test("configures stored credentials through Interaction and schema-aware storage", async () => {
    const auth = await getAuth();
    const { interaction, messages } = makeInteraction();
    const config = await Effect.runPromise(
      auth.configure("default").pipe(
        Effect.provideService(Interaction.Interaction, interaction),
      ),
    );

    expect(config).toEqual({ method: "stored" });
    expect(messages).toContain("Scaleway: credentials saved.");
    expect(
      await Effect.runPromise(
        Schema.decodeUnknownEffect(ScalewayStoredCredentialsSchema)({
          secretKey: "stored-secret",
          accessKey: "stored-access",
          projectId: "stored-project",
          region: "nl-ams",
        }),
      ),
    ).toMatchObject({ region: "nl-ams" });
  });

  test("details redacts both Scaleway secrets", async () => {
    const details = scalewayDetails(
      await Effect.runPromise(
        resolveFromStored({
          secretKey: "secret-value",
          accessKey: "access-value",
          region: "fr-par",
        }),
      ),
    );
    const rendered = details.lines.map((line) => `${line.key}: ${line.value}`).join("\n");

    expect(rendered).not.toContain("secret-value");
    expect(rendered).not.toContain("access-value");
    expect(rendered).toContain("****");
    expect(Redacted.value(Redacted.make("access-value"))).toBe("access-value");
  });
});
