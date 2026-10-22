import { NextResponse, type NextRequest } from "next/server";

/** Passes the requested path to server components so the app layout can check whether the page's module is switched on for the company. */
export function proxy(req: NextRequest) {
  const headers = new Headers(req.headers);
  headers.set("x-pathname", req.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ["/((?!api|_next/static|_next/image|favicon.ico|media|p/).*)"] };
