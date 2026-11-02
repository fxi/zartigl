/**
 * Just enough ISO BMFF to feed WebCodecs the H.264 track of a GeoVideo:
 * ffmpeg's single-track, faststart MP4. No fragments, no other codecs.
 */

/** One coded frame, in decode order. */
export interface Mp4Sample {
  offset: number;
  size: number;
  /** Rank in presentation order: the video frame it shows. */
  frame: number;
  key: boolean;
}

export interface Mp4VideoTrack {
  /** WebCodecs codec string, e.g. "avc1.640029". */
  codec: string;
  /** The avcC record: VideoDecoderConfig.description. */
  description: Uint8Array;
  width: number;
  height: number;
  /** Decode order. */
  samples: Mp4Sample[];
}

interface Box {
  type: string;
  start: number;
  end: number;
}

function boxes(view: DataView, start: number, end: number): Box[] {
  const found: Box[] = [];
  let at = start;
  while (at + 8 <= end) {
    let size = view.getUint32(at);
    const type = String.fromCharCode(
      view.getUint8(at + 4),
      view.getUint8(at + 5),
      view.getUint8(at + 6),
      view.getUint8(at + 7),
    );
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < header || at + size > end) {
      throw new Error(`Malformed MP4 box ${type}`);
    }
    found.push({ type, start: at + header, end: at + size });
    at += size;
  }
  return found;
}

function child(view: DataView, parent: Box, type: string): Box {
  const box = boxes(view, parent.start, parent.end).find(
    (b) => b.type === type,
  );
  if (!box) {
    throw new Error(`MP4 box ${type} not found in ${parent.type}`);
  }
  return box;
}

function optional(view: DataView, parent: Box, type: string): Box | null {
  return boxes(view, parent.start, parent.end).find((b) => b.type === type) ?? null;
}

/** Full-box entries: version/flags, a count, then the entries. */
function entries(view: DataView, box: Box): { at: number; count: number } {
  return { at: box.start + 8, count: view.getUint32(box.start + 4) };
}

/**
 * Frames rank by composition time, which holds when an edit list only
 * removes the B-frame delay (ffmpeg's one edit starting at the first
 * composition time). Any other edit would show other frames: rejected.
 */
function requirePlainEditList(
  view: DataView,
  trak: Box,
  firstComposition: number,
): void {
  const edts = optional(view, trak, "edts");
  const elst = edts && optional(view, edts, "elst");
  if (!elst) {
    return;
  }
  const { at, count } = entries(view, elst);
  const mediaTime =
    view.getUint8(elst.start) === 1
      ? Number(view.getBigInt64(at + 8))
      : view.getInt32(at + 4);
  if (count !== 1 || mediaTime !== firstComposition) {
    throw new Error("Unsupported MP4 edit list");
  }
}

/** The first H.264 video track of an MP4. */
export function parseMp4VideoTrack(buffer: ArrayBuffer): Mp4VideoTrack {
  const view = new DataView(buffer);
  const top = { type: "file", start: 0, end: buffer.byteLength };
  const moov = child(view, top, "moov");
  const trak = boxes(view, moov.start, moov.end).find((box) => {
    if (box.type !== "trak") {
      return false;
    }
    const hdlr = child(view, child(view, box, "mdia"), "hdlr");
    return (
      String.fromCharCode(...new Uint8Array(buffer, hdlr.start + 8, 4)) ===
      "vide"
    );
  });
  if (!trak) {
    throw new Error("MP4 has no video track");
  }
  const stbl = child(
    view,
    child(view, child(view, trak, "mdia"), "minf"),
    "stbl",
  );

  // stsd → avc1 (78-byte visual sample entry) → avcC.
  const stsd = child(view, stbl, "stsd");
  const [entry] = boxes(view, stsd.start + 8, stsd.end);
  if (!entry || (entry.type !== "avc1" && entry.type !== "avc3")) {
    throw new Error(`Unsupported MP4 sample entry ${entry?.type}`);
  }
  const width = view.getUint16(entry.start + 24);
  const height = view.getUint16(entry.start + 26);
  const avcC = child(view, { ...entry, start: entry.start + 78 }, "avcC");
  const description = new Uint8Array(buffer.slice(avcC.start, avcC.end));
  const hex = (i: number) => description[i].toString(16).padStart(2, "0");
  const codec = `avc1.${hex(1)}${hex(2)}${hex(3)}`;

  // Sizes.
  const stsz = child(view, stbl, "stsz");
  const fixedSize = view.getUint32(stsz.start + 4);
  const count = view.getUint32(stsz.start + 8);
  const sizes = Array.from({ length: count }, (_, i) =>
    fixedSize || view.getUint32(stsz.start + 12 + i * 4),
  );

  // Offsets: chunk offsets spread over samples by stsc.
  const co64 = optional(view, stbl, "co64");
  const stco = co64 ?? child(view, stbl, "stco");
  const chunks = entries(view, stco);
  const chunkOffsets = Array.from({ length: chunks.count }, (_, i) =>
    co64
      ? Number(view.getBigUint64(chunks.at + i * 8))
      : view.getUint32(chunks.at + i * 4),
  );
  const stsc = entries(view, child(view, stbl, "stsc"));
  const offsets: number[] = [];
  for (let i = 0; i < stsc.count; i++) {
    const at = stsc.at + i * 12;
    const first = view.getUint32(at) - 1;
    const perChunk = view.getUint32(at + 4);
    const last =
      i + 1 < stsc.count ? view.getUint32(at + 12) - 1 : chunkOffsets.length;
    for (let c = first; c < last; c++) {
      let offset = chunkOffsets[c];
      for (let s = 0; s < perChunk && offsets.length < count; s++) {
        offsets.push(offset);
        offset += sizes[offsets.length - 1];
      }
    }
  }

  // Decode times, composition offsets, presentation rank.
  const stts = entries(view, child(view, stbl, "stts"));
  const times: number[] = [];
  let dts = 0;
  for (let i = 0; i < stts.count; i++) {
    const n = view.getUint32(stts.at + i * 8);
    const delta = view.getUint32(stts.at + i * 8 + 4);
    for (let s = 0; s < n; s++) {
      times.push(dts);
      dts += delta;
    }
  }
  const cttsBox = optional(view, stbl, "ctts");
  if (cttsBox) {
    const signed = view.getUint8(cttsBox.start) === 1;
    const ctts = entries(view, cttsBox);
    let sample = 0;
    for (let i = 0; i < ctts.count; i++) {
      const n = view.getUint32(ctts.at + i * 8);
      const offset = signed
        ? view.getInt32(ctts.at + i * 8 + 4)
        : view.getUint32(ctts.at + i * 8 + 4);
      for (let s = 0; s < n; s++) {
        times[sample++] += offset;
      }
    }
  }
  requirePlainEditList(view, trak, Math.min(...times.slice(0, count)));
  const order = times
    .slice(0, count)
    .map((time, i) => [time, i])
    .sort((a, b) => a[0] - b[0]);
  const frames = new Array<number>(count);
  order.forEach(([, i], rank) => (frames[i] = rank));

  const stssBox = optional(view, stbl, "stss");
  const keys = new Set<number>();
  if (stssBox) {
    const stss = entries(view, stssBox);
    for (let i = 0; i < stss.count; i++) {
      keys.add(view.getUint32(stss.at + i * 4) - 1);
    }
  }

  if (offsets.length !== count || times.length < count) {
    throw new Error("Inconsistent MP4 sample tables");
  }
  return {
    codec,
    description,
    width,
    height,
    samples: sizes.map((size, i) => ({
      offset: offsets[i],
      size,
      frame: frames[i],
      key: stssBox ? keys.has(i) : true,
    })),
  };
}
