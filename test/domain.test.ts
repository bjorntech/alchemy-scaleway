import { afterEach, describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import {
  absoluteHostname,
  cnameMatches,
  type CnameLookupResult,
  hasCname,
  resetCnameResolver,
  setCnameResolver,
  waitForCname,
  withoutScheme,
} from "../src/Domain.ts";

const session = { note: () => Effect.void };

const lookup = (entries: Record<string, string[]>): CnameLookupResult[] =>
  Object.entries(entries).map(([server, cnames]) => ({ server, cnames }));

afterEach(() => {
  resetCnameResolver();
});

describe("withoutScheme", () => {
  test("strips scheme and trailing slash", () => {
    expect(withoutScheme("https://api.example.com/")).toBe("api.example.com");
    expect(withoutScheme("http://api.example.com")).toBe("api.example.com");
    expect(withoutScheme("api.example.com")).toBe("api.example.com");
  });
});

describe("absoluteHostname", () => {
  test("adds a single trailing dot and strips scheme", () => {
    expect(absoluteHostname("https://target.fnc.fr-par.scw.cloud")).toBe(
      "target.fnc.fr-par.scw.cloud.",
    );
    expect(absoluteHostname("target.fnc.fr-par.scw.cloud.")).toBe("target.fnc.fr-par.scw.cloud.");
  });
});

describe("hasCname", () => {
  test("matches case-insensitively and normalizes trailing dot", () => {
    expect(hasCname(["Target.Fnc.Fr-Par.Scw.Cloud"], "target.fnc.fr-par.scw.cloud.")).toBe(true);
    expect(hasCname(["other.example.com."], "target.fnc.fr-par.scw.cloud.")).toBe(false);
  });

  test("returns false for an empty answer", () => {
    expect(hasCname([], "target.fnc.fr-par.scw.cloud.")).toBe(false);
  });
});

describe("cnameMatches", () => {
  const expected = "target.fnc.fr-par.scw.cloud.";

  const run = (entries: Record<string, string[]>) => {
    setCnameResolver(async () => lookup(entries));
    return Effect.runPromise(cnameMatches("api.example.com", expected));
  };

  test("is ready only when every public resolver agrees", async () => {
    expect(
      await run({
        "1.1.1.1": ["target.fnc.fr-par.scw.cloud"],
        "8.8.8.8": ["target.fnc.fr-par.scw.cloud"],
      }),
    ).toBe(true);
  });

  test("is not ready when only one resolver sees the record (the regression)", async () => {
    expect(
      await run({
        "1.1.1.1": ["target.fnc.fr-par.scw.cloud"],
        "8.8.8.8": [],
      }),
    ).toBe(false);
  });

  test("is not ready when a resolver returns a stale/different target", async () => {
    expect(
      await run({
        "1.1.1.1": ["target.fnc.fr-par.scw.cloud"],
        "8.8.8.8": ["old.fnc.fr-par.scw.cloud"],
      }),
    ).toBe(false);
  });

  test("is not ready when no resolver returns anything", async () => {
    expect(await run({ "1.1.1.1": [], "8.8.8.8": [] })).toBe(false);
  });

  test("treats resolver failure as not ready", async () => {
    setCnameResolver(() => Promise.reject(new Error("dns down")));
    expect(await Effect.runPromise(cnameMatches("api.example.com", expected))).toBe(false);
  });
});

describe("waitForCname", () => {
  test("resolves immediately when public DNS already agrees", async () => {
    setCnameResolver(async () =>
      lookup({
        "1.1.1.1": ["target.fnc.fr-par.scw.cloud"],
        "8.8.8.8": ["target.fnc.fr-par.scw.cloud"],
      }),
    );
    await Effect.runPromise(
      waitForCname("api.example.com", "https://target.fnc.fr-par.scw.cloud", session),
    );
  });

  test("re-queries public DNS until every resolver agrees", async () => {
    let calls = 0;
    setCnameResolver(async () => {
      calls += 1;
      const seen = calls >= 3 ? ["target.fnc.fr-par.scw.cloud"] : [];
      return lookup({
        "1.1.1.1": ["target.fnc.fr-par.scw.cloud"],
        "8.8.8.8": seen,
      });
    });

    const program = Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        waitForCname("api.example.com", "target.fnc.fr-par.scw.cloud", session),
        { startImmediately: true },
      );
      // Each miss schedules a 5s retry; advance enough to clear two misses.
      yield* TestClock.adjust("5 seconds");
      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(fiber);
    });

    await Effect.runPromise(program.pipe(Effect.provide(TestClock.layer())));
    expect(calls).toBe(3);
  });
});
