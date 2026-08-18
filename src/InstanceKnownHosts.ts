import { Resource } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import { createHash } from "node:crypto";
import { Client, type ServerHostKeyAlgorithm, utils as ssh2Utils } from "ssh2";
import { makeScalewayClients, type ScalewayClientsShape } from "./Clients.ts";
import { isNotFound } from "./Errors.ts";
import { parentReadiness, resolveRef } from "./Internal.ts";
import type { Instance } from "./Instance.ts";
import type { Providers } from "./Providers.ts";

export type InstanceKnownHostsRef = string | Instance;

export interface InstanceKnownHostsProps {
  instance: InstanceKnownHostsRef;
  zone?: string;
  /** Optional endpoint preference; falls back to the first entry in `addresses`. */
  preferredAddress?: string;
  /** Hostnames/IPs that should be written into `known_hosts`. */
  addresses?: string[];
  port?: number;
  timeout?: string;
  /** Scheduling-only edge to the instance reconcile when a resource reference is used. */
  instanceReadiness?: unknown;
}

export type InstanceKnownHosts = Resource<
  "Scaleway.InstanceKnownHosts",
  InstanceKnownHostsProps,
  {
    serverId: string;
    zone: string;
    addresses: string[];
    fingerprints: string[];
    knownHosts: string;
    knownHostsB64: string;
    verified: boolean;
    port?: number;
  },
  never,
  Providers
>;

const InstanceKnownHostsResource = Resource<InstanceKnownHosts>("Scaleway.InstanceKnownHosts");

export const InstanceKnownHosts = Object.assign(
  (id: string, props: InstanceKnownHostsProps) =>
    InstanceKnownHostsResource(id, {
      ...props,
      instanceReadiness: props.instanceReadiness ?? parentReadiness(props.instance),
    }),
  InstanceKnownHostsResource,
) as typeof InstanceKnownHostsResource;

class InstanceKnownHostsPending extends Data.TaggedError("Scaleway.InstanceKnownHostsPending")<{ message: string; }> {}

class InstanceKnownHostsMismatch extends Data.TaggedError("Scaleway.InstanceKnownHostsMismatch")<{
  message: string;
  expected: string[];
  actual: string[];
}> {}

export interface InstanceKnownHostsScanRequest {
  address: string;
  port: number;
  algorithms: readonly string[];
  timeout: string;
}

export type InstanceKnownHostsCommand = InstanceKnownHostsScanRequest;

export type InstanceKnownHostsScanner = (
  request: InstanceKnownHostsScanRequest,
) => Effect.Effect<ScannedKey | undefined, Error, never>;

export type InstanceKnownHostsCommandRunner = InstanceKnownHostsScanner;

type FingerprintSummary = {
  keyType: string;
  fingerprint: string;
};

type ScannedKey = FingerprintSummary & {
  host: string;
  algorithm: string;
  keyData: string;
};

const scanTimeout = "5 seconds";

const scanAlgorithmsByKeyType = {
  ED25519: ["ssh-ed25519"],
  ECDSA: ["ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521"],
  RSA: ["rsa-sha2-512", "rsa-sha2-256", "ssh-rsa"],
} as const;

const fingerprintKey = (fingerprint: FingerprintSummary) => `${fingerprint.keyType}\0${fingerprint.fingerprint}`;
const fingerprintKeys = (fingerprints: readonly FingerprintSummary[]) => fingerprints.map(fingerprintKey).sort();

const normalizeKeyType = (keyType: string) => {
  const lowered = keyType.toLowerCase();
  if (lowered.startsWith("ssh-ed25519")) return "ED25519";
  if (lowered.startsWith("ecdsa-")) return "ECDSA";
  if (lowered.startsWith("ssh-rsa") || lowered.startsWith("rsa-")) return "RSA";
  return keyType.replace(/-cert-v01@openssh\.com$/, "").toUpperCase();
};

const readSshString = (buffer: Buffer, offset: number) => {
  const length = buffer.readUInt32BE(offset);
  const start = offset + 4;
  const end = start + length;
  return { value: buffer.subarray(start, end), offset: end };
};

export const sshKeyFingerprint = (keyData: string) => {
  const blob = Buffer.from(keyData, "base64");
  if (blob.length === 0) throw new Error("Invalid SSH public key data.");
  let offset = 0;
  const algorithm = readSshString(blob, offset);
  offset = algorithm.offset;
  if (algorithm.value.length === 0 || offset > blob.length) throw new Error("Invalid SSH public key data.");
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
};

export const parseFingerprintSummaries = (value: string): FingerprintSummary[] =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(?:\d+\s+)?(SHA256:[^\s]+).*\(([^)]+)\)\s*$/);
      if (!match) throw new Error(`Invalid SSH fingerprint line: ${line}`);
      return { keyType: normalizeKeyType(match[2] ?? ""), fingerprint: match[1] };
    })
    .sort((left, right) => fingerprintKey(left).localeCompare(fingerprintKey(right)));

const parseScannedKey = (keyData: Buffer, host: string): ScannedKey => {
  const parsed = ssh2Utils.parseKey(keyData);
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key) throw new Error("Invalid SSH host key data.");
  return {
    host,
    keyType: normalizeKeyType(key.type),
    algorithm: key.type,
    keyData: keyData.toString("base64"),
    fingerprint: sshKeyFingerprint(keyData.toString("base64")),
  };
};

const defaultScanInstanceKnownHosts: InstanceKnownHostsScanner = ({ address, port, algorithms }) =>
  Effect.tryPromise({
    try: () =>
      new Promise<ScannedKey | undefined>((resolve, reject) => {
        const client = new Client();
        let captured: ScannedKey | undefined;
        let settled = false;
        const timeoutMs = 5000;
        const deadline = setTimeout(() => {
          if (settled) return;
          settled = true;
          try {
            client.end();
          } catch {
            // ignore
          }
          reject(new Error(`waiting for SSH on ${address}`));
        }, timeoutMs);

        const finish = (handler: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          handler();
        };

        client.on("error", (error) => {
          if (captured) return;
          finish(() => reject(error instanceof Error ? error : new Error(String(error))));
        });

        client.on("close", () => {
          if (captured) {
            finish(() => resolve(captured));
            return;
          }
          finish(() => reject(new Error(`waiting for SSH on ${address}`)));
        });

        try {
          client.connect({
            host: address,
            port,
            username: "scan",
            readyTimeout: timeoutMs,
            algorithms: { serverHostKey: [...algorithms] as ServerHostKeyAlgorithm[] },
            hostVerifier: (rawKey: Buffer) => {
              try {
                captured = parseScannedKey(rawKey, address);
                return false;
              } catch (error) {
                finish(() => reject(error instanceof Error ? error : new Error(String(error))));
                return false;
              }
            },
          });
        } catch (error) {
          finish(() => reject(error instanceof Error ? error : new Error(String(error))));
        }
      }),
    catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
  });

let runInstanceKnownHostsScanner = defaultScanInstanceKnownHosts;

export const setInstanceKnownHostsScanner = (scanner: InstanceKnownHostsScanner) => {
  runInstanceKnownHostsScanner = scanner;
};

export const resetInstanceKnownHostsScanner = () => {
  runInstanceKnownHostsScanner = defaultScanInstanceKnownHosts;
};

export const setInstanceKnownHostsCommandRunner = setInstanceKnownHostsScanner;
export const resetInstanceKnownHostsCommandRunner = resetInstanceKnownHostsScanner;

const timeoutDuration = (timeout: string) => {
  const normalized = timeout.replace(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/, (_, value: string, unit: keyof typeof shortTimeoutUnits) =>
    `${value} ${shortTimeoutUnits[unit]}`,
  );
  return Duration.fromInputUnsafe(normalized as Duration.Input);
};

const shortTimeoutUnits = {
  ms: "millis",
  s: "seconds",
  m: "minutes",
  h: "hours",
} as const;

const instanceServerId = (instance: InstanceKnownHostsRef) =>
  resolveRef(typeof instance === "string" ? instance : instance.serverId);

const instanceZone = (instance: InstanceKnownHostsRef, zone?: string) =>
  Effect.gen(function* () {
    if (zone !== undefined) return yield* resolveRef(zone);
    if (typeof instance === "string") throw new Error("InstanceKnownHosts requires zone when the instance reference does not provide one.");
    const resolved = yield* resolveRef(instance.zone);
    if (!resolved) throw new Error("InstanceKnownHosts requires zone when the instance reference does not provide one.");
    return resolved;
  });

const instanceAddresses = (preferredAddress: string | undefined, addresses: readonly string[] | undefined) => {
  const requestedAddresses = [preferredAddress, ...(addresses ?? [])].filter((value): value is string =>
    typeof value === "string" && value.trim().length > 0,
  );
  const deduped = [...new Set(requestedAddresses)];
  if (deduped.length === 0) throw new Error("InstanceKnownHosts requires preferredAddress or addresses.");
  return deduped;
};

const resolveKnownHostsRequest = (props: Pick<InstanceKnownHostsProps, "instance" | "zone" | "preferredAddress" | "addresses" | "port">) =>
  Effect.gen(function* () {
    return {
      serverId: yield* instanceServerId(props.instance),
      zone: yield* instanceZone(props.instance, props.zone),
      addresses: instanceAddresses(props.preferredAddress, props.addresses),
      port: props.port ?? 22,
    };
  });

const portAddress = (address: string, port: number) => port === 22 ? address : `[${address}]:${port}`;

const buildKnownHosts = (keys: readonly ScannedKey[], addresses: readonly string[], port: number) => {
  const renderedAddresses = addresses.map((address) => portAddress(address, port));
  return knownHostsFromKeys(keys, renderedAddresses);
};

const retryableScanErrorPattern = /(connection refused|timed out|timeout|waiting for ssh|no route|unreachable|no matching host key|unable to negotiate|handshake failed)/;

export const isRetryableScanError = (error: unknown) => retryableScanErrorPattern.test(
  String((error as { message?: unknown })?.message ?? error).toLowerCase(),
);

const scanKeyTypeOrder = ["ED25519", "ECDSA", "RSA"] as const;

const verifyKnownHostsOnce = (input: {
  serverId: string;
  zone: string;
  addresses: readonly string[];
  port: number;
}, clients: Pick<ScalewayClientsShape, "instance">): Effect.Effect<InstanceKnownHosts["Attributes"], InstanceKnownHostsPending | InstanceKnownHostsMismatch | Error, never> =>
  Effect.gen(function* () {
    const fingerprintValue = yield* clients.instance.getInstanceUserData({
      zone: input.zone,
      serverId: input.serverId,
      key: "ssh-host-fingerprints",
    }).pipe(
      Effect.catchIf(isNotFound, () => Effect.fail(new InstanceKnownHostsPending({ message: "waiting for ssh-host-fingerprints user-data" }))),
    );
    const expected = parseFingerprintSummaries(fingerprintValue);
    if (expected.length === 0) {
      return yield* Effect.fail(new InstanceKnownHostsPending({ message: "waiting for ssh-host-fingerprints user-data" }));
    }

    const expectedByType = new Map<string, FingerprintSummary[]>();
    for (const fingerprint of expected) {
      const fingerprints = expectedByType.get(fingerprint.keyType) ?? [];
      fingerprints.push(fingerprint);
      expectedByType.set(fingerprint.keyType, fingerprints);
    }

    const requestedTypes = scanKeyTypeOrder.filter((keyType) => expectedByType.has(keyType));
    const scanned = new Map<string, ScannedKey>();
    let lastError: unknown;

    for (const address of input.addresses) {
      for (const keyType of requestedTypes) {
        if (scanned.has(keyType)) continue;
        try {
          const scannedKey = yield* runInstanceKnownHostsScanner({
            address,
            port: input.port,
            algorithms: scanAlgorithmsByKeyType[keyType],
            timeout: scanTimeout,
          });
          if (!scannedKey) continue;

          const actualType = normalizeKeyType(scannedKey.keyType);
          if (actualType !== keyType) {
            return yield* Effect.fail(new InstanceKnownHostsMismatch({
              message: `SSH host key algorithm does not match the expected category for ${input.serverId}`,
              expected: [keyType],
              actual: [actualType],
            }));
          }

          const expectedFingerprints = expectedByType.get(keyType) ?? [];
          if (!expectedFingerprints.some(({ fingerprint }) => fingerprint === scannedKey.fingerprint)) {
            return yield* Effect.fail(new InstanceKnownHostsMismatch({
              message: `SSH host key fingerprints do not match for ${input.serverId}`,
              expected: expectedFingerprints.map(({ keyType: expectedKeyType, fingerprint }) => `${expectedKeyType} ${fingerprint}`).sort(),
              actual: [`${actualType} ${scannedKey.fingerprint}`],
            }));
          }

          scanned.set(keyType, scannedKey);
        } catch (error) {
          lastError = error;
          if (isRetryableScanError(error)) continue;
          throw error;
        }
      }

      if (requestedTypes.every((keyType) => scanned.has(keyType))) break;
    }

    const scannedKeys = requestedTypes.flatMap((keyType) => scanned.get(keyType) ? [scanned.get(keyType)!] : []);
    const actual = scannedKeys.map((key) => ({ keyType: key.keyType, fingerprint: key.fingerprint }));
    const expectedKeys = fingerprintKeys(expected);
    const actualKeys = fingerprintKeys(actual);
    if (expectedKeys.length !== actualKeys.length || expectedKeys.some((key, index) => key !== actualKeys[index])) {
      if (lastError && isRetryableScanError(lastError)) {
        return yield* Effect.fail(new InstanceKnownHostsPending({
          message: `waiting for SSH on ${input.addresses.join(", ")}`,
        }));
      }
      if (lastError) throw lastError;
      return yield* Effect.fail(new InstanceKnownHostsMismatch({
        message: `SSH host key fingerprints do not match for ${input.serverId}`,
        expected: expectedKeys,
        actual: actualKeys,
      }));
    }

    const knownHosts = buildKnownHosts(scannedKeys, input.addresses, input.port);
    return {
      serverId: input.serverId,
      zone: input.zone,
      addresses: input.addresses.map((address) => portAddress(address, input.port)),
      fingerprints: expected.map(({ keyType, fingerprint }) => `${keyType} ${fingerprint}`),
      knownHosts,
      knownHostsB64: Buffer.from(knownHosts, "utf8").toString("base64"),
      verified: true,
      port: input.port === 22 ? undefined : input.port,
    } as InstanceKnownHosts["Attributes"];
  });

// @crap-ignore: provider factory wraps lifecycle closures scored separately.
export const InstanceKnownHostsProvider = () =>
  Provider.effect(
    InstanceKnownHosts,
    Effect.gen(function* () {
      const clients = yield* makeScalewayClients;
      const verify = (props: InstanceKnownHostsProps) =>
        resolveKnownHostsRequest(props).pipe(Effect.flatMap((input) => verifyKnownHostsOnce(input, clients)));

      const reconcile = (props: InstanceKnownHostsProps, session: { note(message: string): Effect.Effect<void> }): Effect.Effect<InstanceKnownHosts["Attributes"], never> => {
        const effect = Effect.gen(function* () {
          while (true) {
            try {
              return yield* verify(props);
            } catch (error) {
              if (error instanceof InstanceKnownHostsPending) {
                yield* session.note(error.message);
                yield* Effect.sleep("1 second");
                continue;
              }
              throw error;
            }
          }
        }) as Effect.Effect<InstanceKnownHosts["Attributes"], never>;
        return props.timeout ? (effect.pipe(Effect.timeout(timeoutDuration(props.timeout))) as Effect.Effect<InstanceKnownHosts["Attributes"], never>) : effect;
      };

      return InstanceKnownHosts.Provider.of({
        stables: ["serverId", "zone", "addresses", "fingerprints", "knownHosts", "knownHostsB64", "verified", "port"],
        list: () => Effect.succeed([]),
        diff: Effect.fnUntraced(function* ({ news, output }) {
          if (!isResolved(news) || !output) return undefined;
          const resolved = yield* resolveKnownHostsRequest(news);
          const outputAddresses = output.addresses ?? [];
          if (output.serverId !== resolved.serverId || output.zone !== resolved.zone || output.port !== (resolved.port === 22 ? undefined : resolved.port)) {
            return { action: "replace" } as const;
          }
          if (JSON.stringify(outputAddresses) !== JSON.stringify(resolved.addresses.map((address) => portAddress(address, resolved.port)))) {
            return { action: "update" } as const;
          }
          return { action: "noop" } as const;
        }),
        read: Effect.fnUntraced(function* ({ output }) {
          if (!output?.serverId || !output.zone || !output.addresses?.length) return undefined;
          return yield* verifyKnownHostsOnce({
            serverId: output.serverId,
            zone: output.zone,
            addresses: output.addresses.map((address) => address.replace(/^\[(.*)]:(\d+)$/, "$1")),
            port: output.port ?? 22,
          }, clients).pipe(
            Effect.catchIf((error) => error instanceof InstanceKnownHostsPending || isRetryableScanError(error), () => Effect.succeed(undefined)),
          );
        }),
        reconcile: Effect.fnUntraced(function* ({ news, session }) {
          return yield* reconcile(news, session);
        }),
        delete: Effect.fnUntraced(function* ({ output, session }) {
          yield* session.note(`Retained verified SSH known hosts for ${output.serverId}`);
        }),
      });
    }),
  );

export const knownHostsFromKeys = (keys: readonly ScannedKey[], aliases: readonly string[]) => {
  const uniqueAliases = [...new Set(aliases.map((alias) => alias.trim()).filter(Boolean))];
  return keys.map((key) => `${uniqueAliases.join(",")} ${key.algorithm} ${key.keyData}`).join("\n");
};
