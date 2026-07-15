/** Normalizes any caught value into a string for logging and user-facing messages. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
