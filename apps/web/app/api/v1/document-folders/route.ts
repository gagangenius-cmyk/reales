import { listFolders, saveFolder } from "@reales/domain";
import { folderSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => listFolders(sq, ctx));
export const POST = api({ body: folderSchema, idempotent: true }, async ({ ctx, sq, body }) => saveFolder(sq, ctx, body));
