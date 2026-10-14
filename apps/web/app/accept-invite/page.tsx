"use client";

import { Suspense } from "react";
import { SetPasswordForm } from "../set-password-form";

export default function AcceptInvite() {
  return <Suspense><SetPasswordForm endpoint="/api/v1/auth/invite/accept" title="Join your team" intro="Set a password to activate your account." cta="Activate account" /></Suspense>;
}
