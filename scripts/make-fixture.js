/* Generates fixtures/smoke-catalog.xlsx: 5 rows, one distinct embedded image
   per row (synthetic shapes so cosine differences are large). */
const ExcelJS = require("exceljs");
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "fixtures");
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const COLORS = ["#e74c3c", "#2ecc71", "#3498db", "#f39c12", "#9b59b6"];

async function makeImage(i) {
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320">
       <rect width="320" height="320" fill="#f5f5f0"/>
       <circle cx="160" cy="150" r="${70 + i * 18}" fill="${COLORS[i]}"/>
       <rect x="20" y="20" width="${60 + i * 30}" height="24" fill="#333"/>
     </svg>`
  );
  return sharp(svg).png().toBuffer();
}

(async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Stock");
  ws.addRow(["SKU", "Item Name", "Category", "Qty", "Unit Price", "Location", "Photo"]);

  const rows = [
    ["SKU-001", "Red Tank Seal 40", "Seals", 12, 4.5, "A1-3"],
    ["SKU-002", "Green Gasket Pro", "Gaskets", 8, 6.2, "A2-1"],
    ["SKU-003", "Blue Valve L", "Valves", 3, 11.0, "B1-2"],
    ["SKU-004", "Amber Coupler", "Couplers", 25, 2.75, "B3-4"],
    ["SKU-005", "Purple Flange XL", "Flanges", 1, 19.99, "C2-5"],
  ];

  const extRows = [];
  for (let i = 0; i < rows.length; i++) {
    const buf = await makeImage(i);
    const ext = "image" + (i + 1) + ".png";
    fs.writeFileSync(path.join(OUT, ext), buf); // keep originals for identify tests
    const imgId = wb.addImage({ buffer: buf, extension: "png" });
    const r = ws.addRow(rows[i]);
    ws.addImage(imgId, {
      tl: { col: 6, row: r.number - 1 }, // anchored on the "Photo" column cell
      ext: { width: 120, height: 120 },
    });
    extRows.push(r.number);
  }
  ws.columns.forEach((c) => (c.width = 18));
  await wb.xlsx.writeFile(path.join(OUT, "smoke-catalog.xlsx"));
  console.log("wrote fixtures/smoke-catalog.xlsx with", rows.length, "embedded images");
})();
