// An error caused by what the user asked for, shown to them as-is.
export class UserInputError extends Error {
  readonly status: 400 | 404 | 409;

  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message);
    this.name = "UserInputError";
    this.status = status;
  }
}
