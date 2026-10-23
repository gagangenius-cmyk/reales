import { NextRequest, NextResponse } from "next/server";
import { whatsappHandshake } from "@reales/domain";
import { webhookHandler } from "@/lib/webhook";

export const POST = webhookHandler("messaging");

/** Meta's webhook subscription handshake (WhatsApp Cloud): echo hub.challenge when the verify token matches. */
export async function GET(req: NextRequest, route: { params: Promise<{ provider: string }> }) {
  if ((await route.params).provider !== "whatsapp_cloud") return NextResponse.json({ error: { code: "not_found" } }, { status: 404 });
  const challenge = whatsappHandshake(req.nextUrl.searchParams);
  return challenge === null ? NextResponse.json({ error: { code: "forbidden" } }, { status: 403 }) : new NextResponse(challenge, { headers: { "content-type": "text/plain" } });
}
