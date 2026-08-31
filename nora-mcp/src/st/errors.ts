export class StMcpError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StMcpError";
  }
}

export class ConfirmationRequiredError extends StMcpError {
  constructor(operation: string) {
    super(`${operation} requires confirm: true`);
    this.name = "ConfirmationRequiredError";
  }
}
