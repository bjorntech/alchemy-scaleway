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
    expect(wrapped.message).toBe('Failed to create namespace "demo": conflict');
    expect(wrapped.statusCode).toBe(409);
    expect(wrapped.code).toBeUndefined();
    expect(wrapped.resource).toBe("demo");
    expect(wrapped.operation).toBe("create namespace");
    expect(wrapped.cause).toBeInstanceOf(Error);
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

  test("supports Effect.catchTags with runtime tag matching", async () => {
    const result = await Effect.runPromise(
      Effect.fail(new ScalewayError({
        message: "Failed to read bucket: missing",
        operation: "read bucket",
        resource: "bucket",
        statusCode: 404,
        code: "NotFound",
        retryable: false,
        cause: new Error("missing"),
      })).pipe(
        Effect.catchTags({
          ScalewayError: (error) => Effect.succeed(`${error._tag}:${error.statusCode}:${error.code}`),
        }),
      ),
    );

    expect(result).toBe("ScalewayError:404:NotFound");
  });
});
