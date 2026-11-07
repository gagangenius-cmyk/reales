import { cancelPhotoshoot, deliverPhotoshoot, schedulePhotoshoot, startPhotoshoot } from "@reales/domain";
import { photoshootActionSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

/** One endpoint for the workflow: { action: schedule | start | deliver | cancel, ... }. */
export const POST = api<{ id: string }, typeof photoshootActionSchema>({ body: photoshootActionSchema, idempotent: true }, async ({ ctx, sq, params, body }) => {
  const id = z.string().uuid().parse(params.id);
  switch (body.action) {
    case "schedule": return schedulePhotoshoot(sq, ctx, id, body);
    case "start": return startPhotoshoot(sq, ctx, id);
    case "deliver": return deliverPhotoshoot(sq, ctx, id, body);
    case "cancel": return cancelPhotoshoot(sq, ctx, id, body.reason);
  }
});
