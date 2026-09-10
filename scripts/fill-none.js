// One-off backfill: rewrite stored attributesJson replacing blank/whitespace
// cells with "N/A" (same rule the import commit applies going forward).
const { PrismaClient } = require("@prisma/client");

const p = new PrismaClient();

(async () => {
  const items = await p.inventoryItem.findMany();
  let touched = 0;
  let cellsFilled = 0;
  for (const it of items) {
    let attrs;
    try {
      attrs = JSON.parse(it.attributesJson);
    } catch {
      continue;
    }
    let changed = false;
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || String(v).trim() === "" || String(v) === "None") {
        attrs[k] = "N/A";
        changed = true;
        cellsFilled++;
      }
    }
    if (changed) {
      await p.inventoryItem.update({ where: { id: it.id }, data: { attributesJson: JSON.stringify(attrs) } });
      touched++;
    }
  }
  console.log(`scanned ${items.length} items · wrote "N/A" into ${cellsFilled} cells in ${touched} items`);
  await p.$disconnect();
})();
