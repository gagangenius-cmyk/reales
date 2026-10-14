import { Suspense } from "react";
import { getLang } from "@/lib/i18n";
import { LoginForm } from "./login-form";

export default async function LoginPage() {
  return <Suspense><LoginForm lang={await getLang()} /></Suspense>;
}
