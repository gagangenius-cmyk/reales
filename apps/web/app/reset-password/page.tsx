"use client";

import { Suspense } from "react";
import { SetPasswordForm } from "../set-password-form";

export default function ResetPassword() {
  return <Suspense><SetPasswordForm endpoint="/api/v1/auth/password/reset" title="Choose a new password" intro="This link works once and signs you out everywhere else." cta="Change password" /></Suspense>;
}
