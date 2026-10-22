import { removeTeamMember, setTeamMember } from "@reales/domain";
import { teamMemberSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const id = z.string().uuid();

export const PUT = api<{ id: string }, typeof teamMemberSchema>({ body: teamMemberSchema }, async ({ ctx, sq, params, body }) => {
  await setTeamMember(sq, ctx, id.parse(params.id), body.userId, body.role ?? "member");
  return { ok: true };
});
export const DELETE = api<{ id: string }, typeof teamMemberSchema>({ body: teamMemberSchema }, async ({ ctx, sq, params, body }) => {
  await removeTeamMember(sq, ctx, id.parse(params.id), body.userId);
  return { ok: true };
});
