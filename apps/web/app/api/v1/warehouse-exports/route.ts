import { exportForWarehouse } from "@reales/domain";
import { exportQuery } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: exportQuery }, async ({ ctx, sq, query }) => exportForWarehouse(sq, ctx, query));
