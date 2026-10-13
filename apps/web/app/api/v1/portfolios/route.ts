import { createPortfolio, listPortfolios } from "@reales/domain";
import { portfolioSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => ({ portfolios: await listPortfolios(sq, ctx) }));
export const POST = api({ body: portfolioSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await createPortfolio(sq, ctx, body) }));
