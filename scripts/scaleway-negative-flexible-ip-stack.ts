import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Scaleway from "../src/index.ts";

const region = process.env.SCW_DEFAULT_REGION || "fr-par";
const zone = process.env.SCW_DEFAULT_ZONE || `${region}-1`;
const prefix = process.env.SCW_NEGATIVE_SMOKE_PREFIX ?? "alchemy-negative-smoke";
const reverse = process.env.SCW_NEGATIVE_SMOKE_REVERSE ?? `${prefix}.invalid`;

export const negativeSmokeTag = `alchemy-negative-smoke=${prefix}`;

export default Alchemy.Stack(
  "alchemy-scaleway-negative-flexible-ip-smoke",
  {
    providers: Scaleway.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const flexibleIp = yield* Scaleway.FlexibleIp("FlexibleIp", {
      zone,
      tags: ["alchemy-negative-smoke-test", negativeSmokeTag],
      type: "routed_ipv4",
      reverse,
    });

    return {
      flexibleIpId: flexibleIp.ipId,
    };
  }),
);
