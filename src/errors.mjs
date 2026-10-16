export class UsageError extends Error {
  constructor(code, message, signIn = "kept") {
    super(message);
    this.name = "UsageError";
    this.code = code;
    this.signIn = signIn;
  }
}
