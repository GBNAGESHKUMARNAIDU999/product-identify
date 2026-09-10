/* Generates fixtures/smoke-catalog.docx: heading-anchored item blocks with
   "Label: value" lines and one embedded image per block — the shape the docx
   parser is designed around. */
const { Document, Packer, Paragraph, HeadingLevel, TextRun, ImageRun } = require("docx");
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "fixtures");
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const COLORS = ["#16a085", "#c0392b", "#2980b9", "#d35400", "#27ae60"];

async function makeImage(i) {
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">
       <rect width="300" height="300" fill="#fafaf6"/>
       <rect x="${30 + i * 10}" y="${30 + i * 10}" width="${240 - i * 20}" height="${240 - i * 20}"
             fill="none" stroke="${COLORS[i]}" stroke-width="${8 + i * 4}"/>
       <circle cx="150" cy="150" r="${20 + i * 10}" fill="${COLORS[i]}"/>
     </svg>`
  );
  return { png: await sharp(svg).png().toBuffer(), jpg: await sharp(svg).flatten({ background: "#ffffff" }).jpeg({ quality: 85 }).toBuffer() };
}

const ITEMS = [
  { sku: "DOC-001", name: "Teal Ring Adapter", category: "Adapters", qty: "6", location: "D1-1" },
  { sku: "DOC-002", name: "Crimson Sleeve MK II", category: "Sleeves", qty: "14", location: "D1-4" },
  { sku: "DOC-003", name: "Ocean Clamp Set", category: "Clamps", qty: "2", location: "D2-2" },
  { sku: "DOC-004", name: "Copper Bushing XL", category: "Bushings", qty: "9", location: "E1-3" },
  { sku: "DOC-005", name: "Emerald Spacer Pack", category: "Spacers", qty: "30", location: "E2-1" },
];

(async () => {
  const children = [
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Warehouse B — Loose Parts Catalog")] }),
    new Paragraph("Each section below is one inventory item. Fields are 'Label: value'."),
  ];
  const saved = [];

  for (let i = 0; i < ITEMS.length; i++) {
    const it = ITEMS[i];
    const { png, jpg } = await makeImage(i);
    const fname = `doc-image${i + 1}.png`;
    fs.writeFileSync(path.join(OUT, fname), png); // originals for identify tests
    saved.push(fname);

    children.push(
      new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(it.name)] }),
      new Paragraph(`SKU: ${it.sku}`),
      new Paragraph(`Category: ${it.category}`),
      new Paragraph(`Qty: ${it.qty}`),
      new Paragraph(`Location: ${it.location}`),
      new Paragraph({
        children: [new ImageRun({ type: "png", data: png, transformation: { width: 180, height: 180 } })],
      })
    );
    void jpg;
  }

  const doc = new Document({ sections: [{ children }] });
  const buf = await Packer.toBuffer(doc);
  fs.writeFileSync(path.join(OUT, "smoke-catalog.docx"), buf);
  console.log("wrote fixtures/smoke-catalog.docx —", ITEMS.length, "items, images:", saved.join(", "));
})();
