/**
 * Agent_Composer message validation (R4.9, R4.13).
 *
 * A message is accepted iff its trimmed length is in [1, 10000]. Whitespace-
 * only input (trimmed length 0) is rejected; input longer than the limit is
 * rejected.
 */

export const MIN_MESSAGE_LENGTH = 1;
export const MAX_MESSAGE_LENGTH = 10_000;

export interface MessageValidation {
  valid: boolean;
  /** Trimmed character length used for the decision. */
  length: number;
  reason: "ok" | "empty" | "too_long";
}

export function validateMessage(input: string): MessageValidation {
  const length = input.trim().length;
  if (length < MIN_MESSAGE_LENGTH) {
    return { valid: false, length, reason: "empty" };
  }
  if (length > MAX_MESSAGE_LENGTH) {
    return { valid: false, length, reason: "too_long" };
  }
  return { valid: true, length, reason: "ok" };
}

export function isValidMessage(input: string): boolean {
  return validateMessage(input).valid;
}
