/** An error whose message is safe to show the user. Anything else becomes a generic 500. */
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export const unauthorized = () => new HttpError(401, "Please sign in to continue.");
export const forbidden = () => new HttpError(403, "You don't have access to this.");
export const notFound = (what = "This record") => new HttpError(404, `${what} could not be found.`);
export const conflict = (message: string) => new HttpError(409, message);
export const invalid = (message: string) => new HttpError(422, message);
export const tooMany = () => new HttpError(429, "Too many attempts. Please wait a while and try again.");
