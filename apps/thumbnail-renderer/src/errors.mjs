export class RendererError extends Error {
  constructor(code, retryable, message = code) {
    super(message);
    this.name = "RendererError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function asRendererError(error) {
  if (error instanceof RendererError) return error;
  if (error?.name === "AbortError") return new RendererError("operation_timeout", true);
  return new RendererError("renderer_internal", true);
}
