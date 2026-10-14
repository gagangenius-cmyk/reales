// Load/smoke test for k6 (https://k6.io). NOT run in the authoring environment (k6 is not installed there).
//   k6 run -e BASE_URL=https://staging.example.com -e TENANT=demo -e EMAIL=agent@demo.test -e PASSWORD=... tests/load/k6-smoke.js
// Run against a production-like STAGING environment only: it logs in and creates no data (read paths + login).
// Thresholds are starting points; set them from your agreed SLOs after the first baseline run.
import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  scenarios: {
    browse: { executor: "ramping-vus", startVUs: 0, stages: [{ duration: "1m", target: 25 }, { duration: "3m", target: 25 }, { duration: "30s", target: 0 }] },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{kind:read}": ["p(95)<800"],
    "http_req_duration{kind:health}": ["p(95)<200"],
  },
};

const BASE = __ENV.BASE_URL || "http://localhost:3000";

export function setup() {
  const res = http.post(`${BASE}/api/v1/auth/login`, JSON.stringify({ tenant: __ENV.TENANT, email: __ENV.EMAIL, password: __ENV.PASSWORD }), {
    headers: { "content-type": "application/json", origin: BASE },
  });
  check(res, { "login ok": (r) => r.status === 200 });
  return { cookie: res.cookies.reales_session?.[0]?.value };
}

export default function (data) {
  const jar = http.cookieJar();
  jar.set(BASE, "reales_session", data.cookie);
  check(http.get(`${BASE}/api/v1/health`, { tags: { kind: "health" } }), { "health 200": (r) => r.status === 200 });
  for (const path of ["/api/v1/leads?limit=25", "/api/v1/contacts?limit=25", "/api/v1/leases?limit=25", "/api/v1/dashboards/sales"]) {
    const r = http.get(`${BASE}${path}`, { tags: { kind: "read" } });
    check(r, { [`${path} < 500`]: (x) => x.status < 500 });
  }
  sleep(1);
}
