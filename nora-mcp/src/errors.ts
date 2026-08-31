export class NoraMcpError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NoraMcpError";
  }
}

export class NoraConfirmationRequiredError extends NoraMcpError {
  constructor(action: string) {
    super(`${action} requires confirm: true`);
    this.name = "NoraConfirmationRequiredError";
  }
}

export class NoraRequestError extends NoraMcpError {
  constructor(message: string, readonly code: string, readonly status: number | null = null,
    readonly outcome: "rejected" | "unknown" = "rejected", readonly details: Record<string, unknown> = {}) {
    super(message);
  }
}
