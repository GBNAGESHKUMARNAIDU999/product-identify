import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// User confirm/reject on an identify result. Confirmed/rejected choices are
// the feedback loop that later improves ranking (see README roadmap).

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = (await req.json()) as { itemId?: string | null };
  const query = await prisma.identifyQuery.findUnique({ where: { id: params.id } });
  if (!query) return NextResponse.json({ error: "query not found" }, { status: 404 });

  if (body.itemId === null) {
    // explicit rejection of all candidates
    const updated = await prisma.identifyQuery.update({
      where: { id: params.id },
      data: { userConfirmedItemId: null, candidatesJson: query.candidatesJson },
    });
    return NextResponse.json({ ok: true, rejected: true, queryId: updated.id });
  }

  if (body.itemId) {
    const item = await prisma.inventoryItem.findUnique({ where: { id: body.itemId } });
    if (!item) return NextResponse.json({ error: "item not found" }, { status: 404 });
  }

  const updated = await prisma.identifyQuery.update({
    where: { id: params.id },
    data: { userConfirmedItemId: body.itemId ?? null },
  });
  return NextResponse.json({ ok: true, queryId: updated.id, confirmedItemId: updated.userConfirmedItemId });
}
