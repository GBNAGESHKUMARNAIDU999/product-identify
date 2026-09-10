import { NextRequest, NextResponse } from "next/server";
import { embeddingStatus, runBackfill } from "@/lib/embed-job";

export async function GET(req: NextRequest) {
  const inventoryId = new URL(req.url).searchParams.get("inventoryId");
  if (!inventoryId) return NextResponse.json({ error: "inventoryId required" }, { status: 400 });
  return NextResponse.json(await embeddingStatus(inventoryId));
}

// Manual retry/trigger for the background backfill.
export async function POST(req: NextRequest) {
  const body = (await req.json()) as { inventoryId?: string };
  if (!body.inventoryId) return NextResponse.json({ error: "inventoryId required" }, { status: 400 });
  const result = await runBackfill(body.inventoryId);
  return NextResponse.json(result);
}
