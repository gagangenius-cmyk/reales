export type AuthErrorCode =
  | "invalid_credentials" | "locked" | "mfa_required" | "mfa_invalid" | "session_invalid"
  | "disabled" | "step_up_required" | "mfa_enrollment_required" | "sso_required";

export class AuthError extends Error {
  constructor(public code: AuthErrorCode, message?: string) {
    super(message ?? code);
    this.name = "AuthError";
  }
  get status() {
    return this.code === "locked" ? 423 : 401;
  }
}
