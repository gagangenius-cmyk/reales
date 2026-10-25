import { afterAll, describe, expect, it } from "vitest";
import { closeTestDb, makeTenant, makeUser } from "./helpers";
import { call, ORIGIN, sessionOf } from "./api-helpers";
import { POST as loginRoute } from "@/app/api/v1/auth/login/route";
import { POST as logoutRoute } from "@/app/api/v1/auth/logout/route";
import { GET as meRoute } from "@/app/api/v1/auth/me/route";
import { POST as dialRoute } from "@/app/api/v1/calls/dial/route";
import { PASSWORD } from "./helpers";

afterAll(closeTestDb);

describe("native app login with a bearer token", () => {
  it("returns the token only when a native client asks, and accepts it as Authorization: Bearer", async () => {
    const t = await makeTenant();
    const u = await makeUser(t, ["agent"]);
    const body = { tenant: t.slug, email: u.email, password: PASSWORD };

    const web = await call(loginRoute, "POST", "/api/v1/auth/login", { body });
    expect(web.json.token).toBeUndefined(); // browsers only ever get the httpOnly cookie
    expect(sessionOf(web.res)).toBeTruthy();

    const native = await call(loginRoute, "POST", "/api/v1/auth/login", { body, headers: { "x-client": "native" } });
    const token: string = native.json.token;
    expect(native.json.status).toMatch(/ok|mfa/);
    expect(token).toMatch(/^[A-Za-z0-9._~-]{20,}$/);

    // a native app sends no Origin and no cookie: the bearer token is its credential
    const me = await call(meRoute, "GET", "/api/v1/auth/me", { origin: null, headers: { authorization: `Bearer ${token}` } });
    expect(me.status).toBe(200);
    expect(JSON.stringify(me.json)).toContain(u.email);
    const post = await call(dialRoute, "POST", "/api/v1/calls/dial", { origin: null, body: { leadId: "00000000-0000-4000-8000-000000000000" }, headers: { authorization: `Bearer ${token}` } });
    expect(post.status).not.toBe(403); // reached the handler (a missing lead or setup error is fine), the origin check did not block it

    expect((await call(meRoute, "GET", "/api/v1/auth/me", { origin: null, headers: { authorization: "Bearer not-a-real-token-at-all-0000" } })).status).toBe(401);
    expect((await call(meRoute, "GET", "/api/v1/auth/me", { origin: null })).status).toBe(401);

    // without a bearer token, a cookie request with no matching Origin is still refused
    expect((await call(dialRoute, "POST", "/api/v1/calls/dial", { origin: "https://evil.example", cookie: sessionOf(web.res)!, body: { leadId: "00000000-0000-4000-8000-000000000000" } })).status).toBe(403);

    expect((await call(logoutRoute, "POST", "/api/v1/auth/logout", { origin: null, headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    expect((await call(meRoute, "GET", "/api/v1/auth/me", { origin: null, headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  });
});
void ORIGIN;
