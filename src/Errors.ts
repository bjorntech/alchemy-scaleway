import * as Schema from "effect/Schema";

export class ScalewayError extends Schema.TaggedErrorClass<ScalewayError>()("ScalewayError", {
  message: Schema.String,
  operation: Schema.optional(Schema.String),
  resource: Schema.optional(Schema.String),
  statusCode: Schema.optional(Schema.Number),
  code: Schema.optional(Schema.String),
  retryable: Schema.optional(Schema.Boolean),
  cause: Schema.optional(Schema.Unknown),
}) {}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function scalewayError(input: {
  operation: string;
  resource?: string;
  cause: unknown;
  statusCode?: number;
  code?: string;
  retryable?: boolean;
}): ScalewayError {
  const statusCode = input.statusCode ?? statusOf(input.cause);
  return new ScalewayError({
    message: errorText(input.operation, input.resource, input.cause),
    operation: input.operation,
    resource: input.resource,
    statusCode,
    code: input.code ?? codeOf(input.cause),
    retryable: input.retryable ?? retryableStatus(statusCode),
    cause: input.cause,
  });
}

export function isNotFound(error: unknown): boolean {
  return statusOf(error) === 404;
}

function statusOf(error: unknown) {
  if (error instanceof ScalewayError) return error.statusCode;
  return httpStatusOf(error);
}

function httpStatusOf(error: unknown) {
  if (!(error instanceof Error)) return undefined;
  return statusCodeOf(error) ?? statusFieldOf(error);
}

function statusCodeOf(error: Error) {
  return "statusCode" in error && typeof error.statusCode === "number"
    ? error.statusCode
    : undefined;
}

function statusFieldOf(error: Error) {
  return "status" in error && typeof error.status === "number" ? error.status : undefined;
}

function codeOf(error: unknown) {
  if (error instanceof ScalewayError) return error.code;
  if (!(error instanceof Error)) return undefined;
  return "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function retryableStatus(statusCode: number | undefined) {
  if (statusCode === undefined) return undefined;
  return statusCode >= 500 || statusCode === 429;
}

function errorText(operation: string, resource: string | undefined, cause: unknown) {
  const target = resource ? ` "${resource}"` : "";
  return `Failed to ${operation}${target}: ${errorMessage(cause)}`;
}
