import mammoth from "mammoth";

// Word parser: heading-anchored rows ("Item: value" style), plus embedded
// images mapped by position between headings. Original bytes preserved.

export interface DocxParsed {
  columns: string[];
  rows: { rowIndex: number; cells: Record<string, string>; imageFilename: string | null }[];
  images: Record<string, Buffer>;
}

interface Block {
  type: "para" | "image";
  text?: string;
  heading?: boolean;
  filename?: string;
}

export async function parseDocx(buf: Buffer): Promise<DocxParsed> {
  const blocks = await extractBlocks(buf);
  const rows: DocxParsed["rows"] = [];
  const columnsSet = new Set<string>(["content"]);
  let current: Record<string, string> | null = null;
  let currentImage: string | null = null;

  const flush = () => {
    if (current) {
      const hasKv = Object.keys(current).some((k) => k !== "content");
      // A row must carry a field or an image; content-only blocks are the
      // document preamble (title/intro), not inventory items.
      if (hasKv || currentImage) {
        rows.push({ rowIndex: rows.length, cells: current, imageFilename: currentImage });
      }
    }
    current = null;
    currentImage = null;
  };

  for (const b of blocks) {
    if (b.type === "image") {
      if (!current) current = {};
      currentImage = b.filename ?? null;
      continue;
    }
    const text = (b.text ?? "").trim();
    if (!text) continue;
    const isHeadingLike = b.heading === true || /^#+\s/.test(b.text ?? "") || /^[A-Z0-9][A-Za-z0-9 \-_\/]{0,60}:$/.test(text);
    const kv = text.match(/^([A-Za-z0-9 #_\-\/().]{1,60}?)\s*[:=]\s*(.+)$/);

    if (isHeadingLike && !kv) {
      flush();
      current = { content: text.replace(/^#+\s*/, "") };
      columnsSet.add("content");
    } else if (kv) {
      if (!current) current = {};
      current[kv[1].trim()] = kv[2].trim();
      columnsSet.add(kv[1].trim());
    } else {
      if (!current) current = {};
      current["content"] = current["content"] ? `${current["content"]}\n${text}` : text;
      columnsSet.add("content");
    }
  }
  flush();

  const images: Record<string, Buffer> = {};
  for (const b of blocks) {
    if (b.type === "image" && b.filename && b.data) images[b.filename] = b.data;
  }

  return { columns: [...columnsSet], rows, images };
}

async function extractBlocks(buf: Buffer): Promise<(Block & { data?: Buffer })[]> {
  const blocks: (Block & { data?: Buffer })[] = [];

  const { value: html } = await mammoth.convertToHtml({ buffer: buf });
  const paraRe = /<(h[1-6]|p)[^>]*>([\s\S]*?)<\/\1>/g;
  let m: RegExpExecArray | null;
  const order: (Block & { data?: Buffer })[] = [];
  while ((m = paraRe.exec(html))) {
    const isHeading = m[1].toLowerCase() !== "p";
    const inner = m[2];
    const imgMatch = inner.match(/<img[^>]*>/);
    if (imgMatch) {
      const src = imgMatch[0].match(/src="data:([^;]+);base64,([^"]+)"/);
      if (src) {
        order.push({ type: "image", filename: null as unknown as string });
        // buffer attached below from mammoth images array
        continue;
      }
    }
    const text = inner
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim();
    if (text) order.push({ type: "para", text, heading: isHeading });
  }

  // mammoth gives us image buffers via convertToHtml images option — re-run
  // with an image converter collecting buffers in order.
  const imgBuffers: Buffer[] = [];
  await mammoth.convertToHtml(
    { buffer: buf },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        const b = await image.readAsBuffer();
        imgBuffers.push(b);
        return { src: `cid:${imgBuffers.length - 1}` };
      }),
    }
  );

  let imgIdx = 0;
  for (const b of order) {
    if (b.type === "image") {
      b.filename = `image${imgIdx}.bin`;
      b.data = imgBuffers[imgIdx];
      imgIdx++;
    }
    blocks.push(b);
  }
  return blocks;
}
