import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { isNotFound, ScalewayError, scalewayError } from "../src/Errors.ts";

describe("ScalewayError", () => {
  test("wraps HTTP-like errors", () => {
    const wrapped = scalewayError({
      operation: "create namespace",
      resource: "demo",
      cause: Object.assign(new Error("conflict"), { statusCode: 409 }),
    });

    expect(wrapped).toBeInstanceOf(ScalewayError);
    expect(wrapped._tag).toBe("ScalewayError");
    expect(wrapped.statusCode).toBe(409);
    expect(wrapped.code).toBeUndefined();
    expect(wrapped.resource).toBe("demo");
  });

  test("recognizes not found", () => {
    expect(
      isNotFound(
        scalewayError({
          operation: "get",
          cause: Object.assign(new Error("missing"), { statusCode: 404 }),
        }),
      ),
    ).toBe(true);
  });

  test("can be matched with Effect.catchTag", async () => {
    const result = await Effect.runPromise(
      Effect.fail(scalewayError({ operation: "test", cause: new Error("boom") })).pipe(
        Effect.catchTag("ScalewayError", (error) => Effect.succeed(error.operation)),
      ),
    );
    expect(result).toBe("test");
  });
});
