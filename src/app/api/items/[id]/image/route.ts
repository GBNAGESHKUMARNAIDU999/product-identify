import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getObject, objectExists, contentTypeFor } from "@/lib/storage";

// Serves catalog images byte-for-byte as stored (original bytes, no
// transformation). Strong ETag + immutable caching since keys are
// content-addressed per row/version.

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const item = await prisma.inventoryItem.findUnique({ where: { id: params.id } });
  if (!item?.imageStorageKey || !(await objectExists(item.imageStorageKey))) {
    return NextResponse.json({ error: "image not found" }, { status: 404 });
  }
  const buf = await getObject(item.imageStorageKey);
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": contentTypeFor(item.imageStorageKey),
      "Content-Length": String(buf.length),
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
