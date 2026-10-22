// Public inbound lead webhook: authenticated by an HMAC signature of the raw body, not by a session (see lib/lead-ingest.ts).
import { leadIngestHandlers } from "@/lib/lead-ingest";

export const POST = leadIngestHandlers.POST;
export const GET = leadIngestHandlers.GET;
