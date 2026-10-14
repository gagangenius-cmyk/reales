import { permissionCatalogue } from "@reales/domain";
import { authorize } from "@reales/rbac";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx }) => {
  authorize(ctx, "role.read");
  return { modules: permissionCatalogue() };
});
