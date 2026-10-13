"use client";

export interface ApiResult<T = any> { ok: boolean; status: number; data: T }

export async function postJson<T = any>(url: string, body?: unknown, method = "POST"): Promise<ApiResult<T>> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: any = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { ok: res.ok, status: res.status, data };
}

export const errMsg = (r: ApiResult) => r.data?.error?.message ?? "Something went wrong";
