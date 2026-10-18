import { addTimeOff, getAvailability, setWeeklyAvailability } from "@reales/domain";
import { timeOffSchema, weeklyAvailabilitySchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const idParam = z.string().uuid();

export const GET = api<{ userId: string }>({}, async ({ ctx, sq, params }) => getAvailability(sq, ctx, idParam.parse(params.userId)));
export const PUT = api<{ userId: string }, typeof weeklyAvailabilitySchema>({ body: weeklyAvailabilitySchema }, async ({ ctx, sq, params, body }) => setWeeklyAvailability(sq, ctx, idParam.parse(params.userId), body.windows));
export const POST = api<{ userId: string }, typeof timeOffSchema>({ body: timeOffSchema, idempotent: true }, async ({ ctx, sq, params, body }) => ({ status: 201, data: await addTimeOff(sq, ctx, idParam.parse(params.userId), body) }));
