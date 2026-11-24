/**
 * mp4.js — Parser y sellador de contenedores MP4 (BlueChisa).
 *
 * No recodifica nada: reescribe la estructura de átomos (boxes) del archivo.
 * Tres modos:
 *   - safe:     faststart, timestamps a cero, idioma, color bt709, limpieza de
 *               metadatos de procedencia (C2PA/uuid) y firma del taller.
 *   - compat:   además aplica el descuadre deliberado de tablas (handlers
 *               renombrados, edit list vacía, muestras fantasma) que impide que
 *               la plataforma rebaje la resolución. Puede producir archivos que
 *               algunos decodificadores estrictos rechacen.
 *   - surgical: mismo objetivo que compat pero SIN descuadrar tablas. Añade
 *               una cola real de 18 frames AAC de silencio (0,384 s), una
 *               segunda descripción de muestra y un clon de la pista de audio;
 *               más un `pasp` 1:1. Las tablas quedan coherentes (stts == stsz)
 *               y el archivo declara una firma de encoder ajena (Lavf por
 *               defecto). Técnica medida en Shore Uploader (2026-11).
 */

export class Mp4Error extends Error {
  constructor(message) {
    super(message);
    this.name = "Mp4Error";
  }
}

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts"]);
const TOP_LEVEL = new Set(["ftyp", "moov", "mdat", "free", "skip", "wide", "uuid", "pnot"]);
const FRAGMENTED = new Set(["moof", "mfra", "styp", "sidx", "emsg", "prft"]);
const STRIP_INSIDE_MOOV = new Set(["uuid", "c2pa", "c2mc", "bdat", "ccat", "xml ", "sdtp", "free", "skip"]);
const VIDEO_CODECS = new Set(["avc1", "avc3", "hvc1", "hev1", "dvh1", "dvhe"]);
const HEVC_CODECS = new Set(["hvc1", "hev1", "dvh1", "dvhe"]);

const GHOST_SAMPLE = new Uint8Array([0, 0, 0, 4, 0, 0, 0, 0]); // 8 bytes por muestra fantasma

/* ------------------------------------------------------------------ */
/* modo quirúrgico: binarios de referencia                             */
/* ------------------------------------------------------------------ */
/* Extraídos del patcher de Shore Uploader (build R3EQ9Y1ZLEWB2b2erWQ94,
 * 2026-11). Son una cola de audio AAC-48k válida, con un segundo descriptor
 * de códec etiquetado `Lavc62.11.100`, y las dos tablas `stsd` que la
 * acompañan. No se generan en tiempo de ejecución: son bytes fijos. */

const hexBytes = (hex) => Uint8Array.from(hex.match(/../g).map((byte) => parseInt(byte, 16)));

// Cola de 125 B = 18 frames AAC de silencio (23 B + 17 × 6 B ≈ 0,384 s a 48 kHz).
const AUDIO_TAIL_SIZES = [23, ...Array.from({ length: 17 }, () => 6)];
const AUDIO_TAIL_BYTES = (() => {
  const descriptor = hexBytes("de02004c61766336322e31312e31303000422008c11838"); // 23 B
  const frame = hexBytes("211004608c1c"); // 6 B
  const out = new Uint8Array(125);
  out.set(descriptor, 0);
  for (let i = 0; i < 17; i += 1) out.set(frame, 23 + 6 * i);
  return out;
})();

// stsd del audio con DOS entradas: la real y la del descriptor `Lavc62.11.100`.
const STSD_TWO_ENTRIES = hexBytes(
  "000000ec7374736400000000000000020000006b6d7034610000000000000001" +
    "00000000000000000002001000000000bb8000000000003365736473000000" +
    "000380808022000200048080801440150000000001f3f60001ea8d05808080" +
    "0211900680808001020000001462747274000000000001f3f60001ea8d0000" +
    "00716d703461000000000000000100000000000000000002001000000000bb" +
    "8000000000003965736473000000000380808028000200048080801a401500" +
    "00000001f3f60001ea8d0580808008118004c0400020000680808001020000" +
    "001462747274000000000001f3f60001ea8d",
).subarray(8);

// stsd del audio con UNA entrada: la que usa la pista clonada.
const STSD_ONE_ENTRY = hexBytes(
  "0000007b7374736400000000000000010000006b6d7034610000000000000001" +
    "00000000000000000002001000000000bb8000000000003365736473000000" +
    "000380808022000200048080801440150000000001f3f60001ea8d05808080" +
    "0211900680808001020000001462747274000000000001f3f60001ea8d",
).subarray(8);

// `pasp` 1:1 (píxeles cuadrados): evita reescalados por aspecto raro.
const PASP_BOX = hexBytes("00000010706173700000000100000001");

const AAC_FRAME_SAMPLES = 1024; // muestras por frame AAC
const AUDIO_TAIL_SECONDS = (AUDIO_TAIL_SIZES.length * AAC_FRAME_SAMPLES) / 48000;

/** Binarios fijos del modo quirúrgico. Exportados para poder verificarlos
 *  contra el patcher de referencia en los tests. */
export const SURGICAL_BINARY = {
  audioTail: AUDIO_TAIL_BYTES,
  audioTailSizes: AUDIO_TAIL_SIZES,
  stsdTwoEntries: STSD_TWO_ENTRIES,
  stsdOneEntry: STSD_ONE_ENTRY,
  pasp: PASP_BOX,
};


const DEFAULTS = {
  mode: "safe",
  ghostSamples: 9112,
  emptyEditDuration: 16,
  language: "eng",
  faststart: true,
  tagOutput: true,
  tagName: "BlueChisa",
  tagComment: "BlueChisa",
  handlerName: "BlueChisa-coded",
  forceBt709: true,
};

const COMPAT_TAGS = {
  tagName: "BlueChisa-v2.0.3",
  tagComment: "BlueChisa",
};

/* En quirúrgico la firma imita a un mux de FFmpeg real: el archivo debe
 * parecer recién salido de `ffmpeg`, no de un taller. Se puede sobrescribir
 * con `tagName` / `tagComment` desde la API. */
const SURGICAL_TAGS = {
  tagName: "Lavf62.3.100",
  tagComment: "Lavf62.3.100",
};

/* ------------------------------------------------------------------ */
/* utilidades de bytes                                                 */
/* ------------------------------------------------------------------ */

function toBytes(input) {
  if (input instanceof Uint8Array) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new TypeError("Se esperaba un ArrayBuffer o Uint8Array.");
}

function viewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function u32(bytes, offset) {
  return viewOf(bytes).getUint32(offset, false);
}

function setU32(bytes, offset, value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Mp4Error(`El valor ${value} no cabe en un campo de 32 bits.`);
  }
  viewOf(bytes).setUint32(offset, value, false);
}

function setU16(bytes, offset, value) {
  viewOf(bytes).setUint16(offset, value, false);
}

function ascii(bytes, offset, length) {
  let out = "";
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[offset + i]);
  return out;
}

function asciiBytes(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function concat(parts) {
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

function indexOfBytes(haystack, needle, from = 0) {
  outer: for (let i = from; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/* ------------------------------------------------------------------ */
/* parser                                                              */
/* ------------------------------------------------------------------ */

function parseRange(bytes, start, end, depth = 0) {
  if (depth > 8) throw new Mp4Error("Anidamiento de cajas demasiado profundo.");
  const boxes = [];
  let at = start;

  while (at + 8 <= end) {
    let size = u32(bytes, at);
    const type = ascii(bytes, at + 4, 4);
    let headerSize = 8;

    if (size === 1) {
      if (at + 16 > end) throw new Mp4Error(`Cabecera de 64 bits truncada en "${type}".`);
      const big = viewOf(bytes).getBigUint64(at + 8, false);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Mp4Error(`La caja "${type}" es demasiado grande.`);
      size = Number(big);
      headerSize = 16;
    } else if (size === 0) {
      size = end - at;
    }

    if (size < headerSize || at + size > end) {
      throw new Mp4Error(`Caja "${type}" inválida en el byte ${at}.`);
    }

    const payloadStart = at + headerSize;
    const payloadEnd = at + size;
    const box = {
      type,
      start: at,
      size,
      headerSize,
      payloadStart,
      payloadEnd,
      payload: bytes.subarray(payloadStart, payloadEnd),
      children: null,
    };

    if (CONTAINERS.has(type)) {
      box.children = parseRange(bytes, payloadStart, payloadEnd, depth + 1);
    }

    boxes.push(box);
    at += size;
  }

  if (at !== end) {
    throw new Mp4Error(`Quedan ${end - at} bytes sin parsear: el MP4 no es convencional.`);
  }
  return boxes;
}

export function parseMp4(input) {
  const bytes = toBytes(input);
  const boxes = parseRange(bytes, 0, bytes.length);
  return { bytes, boxes };
}

function serializeBox(box) {
  const content = box.children ? concat(box.children.map(serializeBox)) : box.payload;
  const size = content.byteLength + 8;
  if (size > 0xffffffff) throw new Mp4Error(`La caja "${box.type}" supera los 4 GB.`);
  const out = new Uint8Array(size);
  setU32(out, 0, size);
  out.set(asciiBytes(box.type), 4);
  out.set(content, 8);
  return out;
}

function rawBox(type, payload) {
  return { type, payload, children: null, start: -1, size: payload.byteLength + 8 };
}

function boxBytes(type, payload) {
  return serializeBox(rawBox(type, payload));
}

function findChild(box, type) {
  return box.children ? box.children.find((child) => child.type === type) ?? null : null;
}

function findAll(box, type, out = []) {
  if (box.type === type) out.push(box);
  for (const child of box.children ?? []) findAll(child, type, out);
  return out;
}

function pathBox(box, ...types) {
  let current = box;
  for (const type of types) {
    if (!current) return null;
    current = findChild(current, type);
  }
  return current;
}

/* ------------------------------------------------------------------ */
/* lectores de campos                                                  */
/* ------------------------------------------------------------------ */

function handlerType(trak) {
  const hdlr = pathBox(trak, "mdia", "hdlr");
  return hdlr && hdlr.payload.byteLength >= 12 ? ascii(hdlr.payload, 8, 4) : "";
}

function readOffsets(box) {
  const payload = box.payload;
  const count = u32(payload, 4);
  const stride = box.type === "co64" ? 8 : 4;
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const base = 8 + i * stride;
    out.push(stride === 8 ? Number(viewOf(payload).getBigUint64(base, false)) : u32(payload, base));
  }
  return out;
}

function writeOffsets(box, values) {
  const use64 = box.type === "co64" || values.some((v) => v > 0xffffffff);
  const stride = use64 ? 8 : 4;
  const payload = new Uint8Array(8 + values.length * stride);
  payload.set(box.payload.subarray(0, 4));
  setU32(payload, 4, values.length);
  values.forEach((value, i) => {
    const base = 8 + i * stride;
    if (use64) viewOf(payload).setBigUint64(base, BigInt(value), false);
    else setU32(payload, base, value);
  });
  box.type = use64 ? "co64" : "stco";
  box.payload = payload;
}

function readStts(box) {
  const payload = box.payload;
  const count = u32(payload, 4);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    entries.push([u32(payload, 8 + 8 * i), u32(payload, 12 + 8 * i)]);
  }
  return entries;
}

function writeStts(box, entries) {
  const payload = new Uint8Array(8 + entries.length * 8);
  payload.set(box.payload.subarray(0, 4));
  setU32(payload, 4, entries.length);
  entries.forEach(([count, delta], i) => {
    setU32(payload, 8 + 8 * i, count);
    setU32(payload, 12 + 8 * i, delta);
  });
  box.payload = payload;
}

function readEditList(box) {
  const payload = box.payload;
  const version = payload[0];
  const entrySize = version === 1 ? 20 : 12;
  const count = u32(payload, 4);
  if (payload.byteLength < 8 + count * entrySize) throw new Mp4Error("Caja elst truncada.");
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    entries.push(payload.subarray(8 + i * entrySize, 8 + (i + 1) * entrySize));
  }
  return { version, entrySize, entries };
}

function writeEditList(box, version, entries) {
  const versionSize = version === 1 ? 20 : 12;
  const payload = new Uint8Array(8 + entries.length * versionSize);
  payload[0] = version;
  setU32(payload, 4, entries.length);
  entries.forEach((entry, i) => payload.set(entry, 8 + i * versionSize));
  box.payload = payload;
}

function makeEmptyEdit(version) {
  const size = version === 1 ? 20 : 12;
  const entry = new Uint8Array(size);
  if (version === 1) {
    viewOf(entry).setBigUint64(0, 16n, false); // segment_duration
    viewOf(entry).setBigUint64(8, 0xffffffffffffffffn, false); // media_time = -1
  } else {
    setU32(entry, 0, 16); // segment_duration
    setU32(entry, 4, 0xffffffff); // media_time = -1
  }
  setU16(entry, version === 1 ? 16 : 8, 1); // media_rate = 1.0 (entero), fracción 0
  return entry;
}

function readSampleSizes(box) {
  const payload = box.payload;
  const constant = u32(payload, 4);
  const count = u32(payload, 8);
  const sizes = [];
  for (let i = 0; i < count; i += 1) {
    sizes.push(constant || u32(payload, 12 + 4 * i));
  }
  return { constant, sizes };
}

function writeSampleSizes(box, sizes) {
  const payload = new Uint8Array(12 + sizes.length * 4);
  payload.set(box.payload.subarray(0, 4));
  setU32(payload, 4, 0); // sample_size uniforme desactivado
  setU32(payload, 8, sizes.length);
  sizes.forEach((size, i) => setU32(payload, 12 + 4 * i, size));
  box.payload = payload;
}

/* ------------------------------------------------------------------ */
/* modo quirúrgico: escritores y sondas                                */
/* ------------------------------------------------------------------ */

function writeStsc(box, entries) {
  const payload = new Uint8Array(8 + entries.length * 12);
  payload.set(box.payload.subarray(0, 4));
  setU32(payload, 4, entries.length);
  entries.forEach(([firstChunk, perChunk, description], i) => {
    setU32(payload, 8 + i * 12, firstChunk);
    setU32(payload, 12 + i * 12, perChunk);
    setU32(payload, 16 + i * 12, description);
  });
  box.payload = payload;
}

function appendSttsEntry(box, count, delta) {
  writeStts(box, [...readStts(box), [count, delta]]);
}

function sttsTotal(box) {
  return readStts(box).reduce((sum, [count, delta]) => sum + count * delta, 0);
}

function setMediaDuration(box, duration) {
  if (!box) return false;
  const copy = box.payload.slice();
  if (copy[0] === 1) {
    if (copy.byteLength < 32) return false;
    viewOf(copy).setBigUint64(24, BigInt(duration), false);
  } else {
    if (copy.byteLength < 20) return false;
    setU32(copy, 16, Math.min(duration, 0xffffffff));
  }
  box.payload = copy;
  return true;
}

function setTrackDuration(box, duration) {
  if (!box) return false;
  const copy = box.payload.slice();
  if (copy[0] === 1) {
    if (copy.byteLength < 36) return false;
    viewOf(copy).setBigUint64(28, BigInt(duration), false);
  } else {
    if (copy.byteLength < 24) return false;
    setU32(copy, 20, Math.min(duration, 0xffffffff));
  }
  box.payload = copy;
  return true;
}

function setMovieDuration(box, duration) {
  return setMediaDuration(box, duration);
}

function movieDurationOf(box) {
  if (!box) return { unknown: true, value: 0 };
  if (box.payload[0] === 1) {
    const value = viewOf(box.payload).getBigUint64(24, false);
    return { unknown: value === 0xffffffffffffffffn, value: Number(value) };
  }
  const value = u32(box.payload, 16);
  return { unknown: value === 0xffffffff, value };
}

function setTrackId(tkhd, id) {
  if (!tkhd) return false;
  const copy = tkhd.payload.slice();
  setU32(copy, copy[0] === 1 ? 20 : 12, id);
  tkhd.payload = copy;
  return true;
}

function nextTrackIdOf(moov) {
  const mvhd = findChild(moov, "mvhd");
  if (!mvhd || mvhd.payload.byteLength < 4) return 2;
  return u32(mvhd.payload, mvhd.payload.byteLength - 4);
}

function bumpEditDuration(box, extra) {
  let parsed;
  try {
    parsed = readEditList(box);
  } catch {
    return false; // elst truncada: mejor dejarla como está que romper el parcheo
  }
  const { version, entries } = parsed;
  if (!entries.length) return false;
  const first = entries[0].slice();
  if (version === 1) {
    viewOf(first).setBigUint64(0, viewOf(first).getBigUint64(0, false) + BigInt(extra), false);
  } else {
    setU32(first, 0, Math.min(u32(first, 0) + extra, 0xffffffff));
  }
  writeEditList(box, version, [first, ...entries.slice(1)]);
  return true;
}

function cloneBox(box) {
  return {
    type: box.type,
    start: -1,
    size: box.size,
    headerSize: box.headerSize,
    payloadStart: -1,
    payloadEnd: -1,
    payload: box.payload.slice(),
    children: box.children ? box.children.map(cloneBox) : null,
  };
}

/** `pasp` 1:1 en la primera entrada del stsd de vídeo, si no lo tiene ya.
 *  Igual que el patcher de referencia: se inserta justo ANTES de `btrt`
 *  (la huella habitual de un mux de FFmpeg), no al final de la entrada. */
function addPasp(trak) {
  const stsd = pathBox(trak, "mdia", "minf", "stbl", "stsd");
  if (!stsd || stsd.payload.byteLength < 16) return false;
  const payload = stsd.payload;
  const entrySize = u32(payload, 8);
  const entryEnd = 8 + entrySize;
  if (entrySize < 16 || entryEnd > payload.byteLength) return false;
  const entry = payload.subarray(8, entryEnd);
  if (indexOfBytes(entry, asciiBytes("pasp")) !== -1) return false;

  // Si la entrada trae `btrt`, el pasp va delante de él (offset absoluto).
  const btrtAt = indexOfBytes(payload, asciiBytes("btrt"), 12);
  const insertAt = btrtAt !== -1 && btrtAt - 4 >= 8 && btrtAt - 4 < entryEnd ? btrtAt - 4 : entryEnd;

  const next = concat([payload.subarray(0, insertAt), PASP_BOX, payload.subarray(insertAt)]);
  setU32(next, 8, entrySize + PASP_BOX.byteLength);
  stsd.payload = next;
  return true;
}

/** ¿El audio es AAC-LC estéreo a 48 kHz con esds? Solo entonces la cola
 *  precalculada encaja sin recodificar. */
function audioProfile(trak) {
  const stsd = pathBox(trak, "mdia", "minf", "stbl", "stsd");
  if (!stsd || stsd.payload.byteLength < 16) return { ok: false, reason: "sin stsd" };
  const payload = stsd.payload;
  const entrySize = u32(payload, 8);
  if (entrySize < 36 || 8 + entrySize > payload.byteLength) {
    return { ok: false, reason: "entrada de audio atípica" };
  }
  const entry = payload.subarray(8, 8 + entrySize);
  const codec = ascii(entry, 4, 4);
  if (codec !== "mp4a") return { ok: false, reason: `códec ${codec || "?"}` };
  if (indexOfBytes(entry, asciiBytes("esds")) === -1) return { ok: false, reason: "mp4a sin esds" };
  const channels = viewOf(entry).getUint16(24, false);
  if (channels !== 2) return { ok: false, reason: `${channels} canal(es)` };
  const sampleRate = Math.round(u32(entry, 32) / 65536);
  if (sampleRate !== 48000) return { ok: false, reason: `${sampleRate} Hz` };
  const mdhd = pathBox(trak, "mdia", "mdhd");
  const timescale = mdhd ? u32(mdhd.payload, mdhd.payload[0] === 1 ? 20 : 12) : 0;
  if (timescale !== 48000) return { ok: false, reason: `timescale ${timescale}` };
  return { ok: true };
}

/** Convierte offsets por chunk en offsets por muestra (lo que exige stsc=1). */
function expandChunkOffsets(stscPayload, chunkOffsets, sampleSizes) {
  if (!stscPayload || stscPayload.byteLength < 16) return null;
  if (chunkOffsets.length === sampleSizes.length) return chunkOffsets.slice();
  const count = u32(stscPayload, 4);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    const at = 8 + i * 12;
    if (at + 12 > stscPayload.byteLength) break;
    entries.push([u32(stscPayload, at), u32(stscPayload, at + 4)]);
  }
  if (!entries.length) return null;

  const out = [];
  let sample = 0;
  entries.forEach(([firstChunk, perChunk], index) => {
    const lastChunk = index + 1 < entries.length ? entries[index + 1][0] - 1 : chunkOffsets.length;
    for (let chunk = firstChunk; chunk <= lastChunk && chunk <= chunkOffsets.length; chunk += 1) {
      let at = chunkOffsets[chunk - 1];
      for (let s = 0; s < perChunk && sample < sampleSizes.length; s += 1) {
        out.push(at);
        at += sampleSizes[sample];
        sample += 1;
      }
    }
  });
  return out.length === sampleSizes.length ? out : null;
}

/**
 * Añade 18 frames AAC de silencio al final de la pista de audio, con una
 * segunda descripción de muestra, y clona la pista. Devuelve las cajas de
 * offsets que hay que reescribir y los offsets por muestra sin desplazar.
 */
function applyAudioTail(moov, audio, movieTimescale) {
  const report = {
    applied: false,
    frames: 0,
    bytes: 0,
    seconds: 0,
    clonedTrack: false,
    secondDescription: false,
    reason: "",
  };
  const profile = audioProfile(audio);
  if (!profile.ok) {
    report.reason = `audio no compatible (${profile.reason})`;
    return { report, targets: [], perSample: [] };
  }

  const stbl = pathBox(audio, "mdia", "minf", "stbl");
  const stsz = stbl && findChild(stbl, "stsz");
  const stsc = stbl && findChild(stbl, "stsc");
  const stts = stbl && findChild(stbl, "stts");
  const stsd = stbl && findChild(stbl, "stsd");
  const stco = stbl && (findChild(stbl, "stco") || findChild(stbl, "co64"));
  if (!stsz || !stsc || !stts || !stsd || !stco) {
    report.reason = "tablas de audio incompletas";
    return { report, targets: [], perSample: [] };
  }

  const { sizes } = readSampleSizes(stsz);
  const perSample = expandChunkOffsets(stsc.payload, readOffsets(stco), sizes);
  if (!perSample) {
    report.reason = "no se pudo expandir stsc/stco";
    return { report, targets: [], perSample: [] };
  }

  const tailSizes = AUDIO_TAIL_SIZES.slice();
  const total = sizes.length + tailSizes.length;

  // 1. muestras y tiempos: stsz y stts quedan coherentes entre sí.
  writeSampleSizes(stsz, [...sizes, ...tailSizes]);
  appendSttsEntry(stts, tailSizes.length, AAC_FRAME_SAMPLES);

  // 2. un chunk por muestra y segunda descripción para el tramo final.
  writeStsc(stsc, [
    [1, 1, 1],
    [Math.max(1, total - 7), 1, 2],
  ]);
  stsd.payload = STSD_TWO_ENTRIES.slice();
  report.secondDescription = true;

  // 3. duraciones de la pista original.
  const mediaDuration = sttsTotal(stts);
  setMediaDuration(pathBox(audio, "mdia", "mdhd"), mediaDuration);
  const trackDuration = Math.round((mediaDuration * movieTimescale) / 48000);
  setTrackDuration(findChild(audio, "tkhd"), trackDuration);
  const elst = pathBox(audio, "edts", "elst");
  if (elst) {
    bumpEditDuration(elst, Math.round((tailSizes.length * AAC_FRAME_SAMPLES * movieTimescale) / 48000));
  }

  // 4. clon de la pista, con una sola descripción.
  const clone = cloneBox(audio);
  const cloneStsd = pathBox(clone, "mdia", "minf", "stbl", "stsd");
  if (cloneStsd) cloneStsd.payload = STSD_ONE_ENTRY.slice();
  const cloneStsc = pathBox(clone, "mdia", "minf", "stbl", "stsc");
  if (cloneStsc) writeStsc(cloneStsc, [[1, 1, 1]]);
  const cloneTrackId = Math.max(nextTrackIdOf(moov), 3);
  setTrackId(findChild(clone, "tkhd"), cloneTrackId);
  moov.children.push(clone);
  report.clonedTrack = true;

  const mvhd = findChild(moov, "mvhd");
  if (mvhd) {
    const copy = mvhd.payload.slice();
    setU32(copy, copy.byteLength - 4, cloneTrackId + 1);
    mvhd.payload = copy;
  }
  const current = movieDurationOf(mvhd);
  if (!current.unknown) setMovieDuration(mvhd, Math.max(current.value, trackDuration));

  report.applied = true;
  report.frames = tailSizes.length;
  report.bytes = AUDIO_TAIL_BYTES.byteLength;
  report.seconds = AUDIO_TAIL_SECONDS;

  const cloneStco = pathBox(clone, "mdia", "minf", "stbl", "stco") ??
    pathBox(clone, "mdia", "minf", "stbl", "co64");
  return { report, targets: [stco, cloneStco].filter(Boolean), perSample };
}


/* ------------------------------------------------------------------ */
/* inspección                                                          */
/* ------------------------------------------------------------------ */

export function inspectMp4(input) {
  const { bytes, boxes } = parseMp4(input);

  const fragmented = boxes.filter((box) => FRAGMENTED.has(box.type));
  const ftyp = boxes.find((box) => box.type === "ftyp") ?? null;
  const moov = boxes.find((box) => box.type === "moov") ?? null;
  const mdat = boxes.find((box) => box.type === "mdat") ?? null;

  if (fragmented.length) {
    throw new Mp4Error("MP4 fragmentado (moof/sidx): hay que remuxear antes de parchear.");
  }
  if (!moov || !mdat) throw new Mp4Error("No se encontraron las cajas moov y mdat.");

  const tracks = (moov.children ?? []).filter((box) => box.type === "trak");
  const video = tracks.find((trak) => handlerType(trak) === "vide") ?? null;
  const audio = tracks.find((trak) => handlerType(trak) === "soun") ?? null;

  const mvhd = findChild(moov, "mvhd");
  const movieTimescale = mvhd ? u32(mvhd.payload, mvhd.payload[0] === 1 ? 20 : 12) : 0;
  const movieDuration = mvhd
    ? mvhd.payload[0] === 1
      ? Number(viewOf(mvhd.payload).getBigUint64(24, false))
      : u32(mvhd.payload, 16)
    : 0;

  let width = 0;
  let height = 0;
  let codec = "";
  let fps = 0;

  if (video) {
    const tkhd = findChild(video, "tkhd");
    if (tkhd && tkhd.payload.byteLength >= 84) {
      const base = tkhd.payload[0] === 1 ? 88 : 76;
      width = u32(tkhd.payload, base) / 65536;
      height = u32(tkhd.payload, base + 4) / 65536;
    }
    const stsd = pathBox(video, "mdia", "minf", "stbl", "stsd");
    if (stsd && stsd.payload.byteLength >= 16) codec = ascii(stsd.payload, 12, 4);

    const mdhd = pathBox(video, "mdia", "mdhd");
    const stts = pathBox(video, "mdia", "minf", "stbl", "stts");
    if (mdhd && stts) {
      const timescale = u32(mdhd.payload, mdhd.payload[0] === 1 ? 20 : 12);
      let samples = 0;
      let ticks = 0;
      for (const [count, delta] of readStts(stts)) {
        samples += count;
        ticks += count * delta;
      }
      if (ticks > 0) fps = (samples * timescale) / ticks;
    }
  }

  return {
    bytes: bytes.byteLength,
    brands: ftyp ? ascii(ftyp.payload, 0, 4) : "",
    compatibleBrands: ftyp
      ? Array.from({ length: Math.max(0, (ftyp.payload.byteLength - 8) / 4) }, (_, i) =>
          ascii(ftyp.payload, 8 + i * 4, 4),
        )
      : [],
    durationSec: movieTimescale ? movieDuration / movieTimescale : 0,
    width,
    height,
    codec,
    fps,
    hasAudio: Boolean(audio),
    trackCount: tracks.length,
    faststart: boxes.indexOf(moov) < boxes.indexOf(mdat),
    fragmented: false,
  };
}

/* ------------------------------------------------------------------ */
/* parcheo                                                             */
/* ------------------------------------------------------------------ */

function zeroTimestamps(moov) {
  for (const type of ["mvhd", "tkhd", "mdhd"]) {
    for (const box of findAll(moov, type)) {
      const payload = box.payload.slice();
      if (payload.byteLength < 8) continue;
      const end = payload[0] === 1 ? 20 : 12;
      if (payload.byteLength < end) continue;
      payload.fill(0, 4, end);
      box.payload = payload;
    }
  }
}

function setLanguage(moov, language) {
  if (!language || language.length !== 3) return;
  const packed =
    ((language.charCodeAt(0) - 0x60) << 10) |
    ((language.charCodeAt(1) - 0x60) << 5) |
    (language.charCodeAt(2) - 0x60);
  for (const box of findAll(moov, "mdhd")) {
    const payload = box.payload.slice();
    const at = payload[0] === 1 ? 32 : 20;
    if (payload.byteLength < at + 2) continue;
    setU16(payload, at, packed);
    box.payload = payload;
  }
}

function setHandlerName(trak, name) {
  const hdlr = pathBox(trak, "mdia", "hdlr");
  if (!hdlr || hdlr.payload.byteLength < 24) return;
  const encoded = new TextEncoder().encode(name).subarray(0, 31);
  const payload = concat([hdlr.payload.subarray(0, 24), encoded, new Uint8Array(1)]);
  hdlr.payload = payload;
}

function setCompressorName(trak, name) {
  const stsd = pathBox(trak, "mdia", "minf", "stbl", "stsd");
  if (!stsd || stsd.payload.byteLength < 90) return;
  const payload = stsd.payload.slice();
  const encoded = new TextEncoder().encode(name).subarray(0, 31);
  payload.fill(0, 58, 90);
  payload[58] = encoded.byteLength;
  payload.set(encoded, 59);
  stsd.payload = payload;
}

function addColorTag(trak) {
  const stsd = pathBox(trak, "mdia", "minf", "stbl", "stsd");
  if (!stsd || stsd.payload.byteLength < 16) return false;

  const payload = stsd.payload;
  const entrySize = u32(payload, 8);
  const entryEnd = 8 + entrySize;
  if (entrySize < 8 || entryEnd > payload.byteLength) return false;

  // ¿Ya tiene colr? (búsqueda directa dentro de la entrada)
  const entry = payload.subarray(8, entryEnd);
  if (indexOfBytes(entry, asciiBytes("colr")) !== -1) return false;

  const colr = new Uint8Array(11);
  colr.set(asciiBytes("nclx"), 0);
  setU16(colr, 4, 1); // primaries = bt709
  setU16(colr, 6, 1); // transfer  = bt709
  setU16(colr, 8, 1); // matrix    = bt709
  const colrBox = boxBytes("colr", colr);

  const next = concat([payload.subarray(0, entryEnd), colrBox, payload.subarray(entryEnd)]);
  setU32(next, 8, entrySize + colrBox.byteLength); // tamaño de la entrada stsd
  stsd.payload = next;
  return true;
}

function stripInsideMoov(box) {
  if (!box.children) return;
  box.children = box.children.filter((child) => !STRIP_INSIDE_MOOV.has(child.type));
  box.children.forEach(stripInsideMoov);
}

function makeUdta(toolTag, comment) {
  const dataItem = (name, text) => {
    const value = new TextEncoder().encode(text);
    const data = new Uint8Array(8 + value.byteLength);
    setU32(data, 0, 1); // igual que el original: version/flags = 1, type = 0
    data.set(value, 8);
    return boxBytes("data", data);
  };

  const ilst = concat([
    boxBytes("\u00a9too", dataItem("too", toolTag)),
    ...(comment
      ? [boxBytes("\u00a9cmt", dataItem("cmt", comment)), boxBytes("cprt", dataItem("cprt", comment))]
      : []),
  ]);

  const hdlr = new Uint8Array(8 + 8 + 9);
  hdlr.set(asciiBytes("mdirappl"), 8);
  const meta = concat([new Uint8Array(4), boxBytes("hdlr", hdlr), boxBytes("ilst", ilst)]);
  return rawBox("udta", boxBytes("meta", meta));
}

function makeFtyp(codec) {
  const compat = HEVC_CODECS.has(codec) ? ["isom", "iso2", "hvc1", "mp41"] : ["isom", "iso2", "avc1", "mp41"];
  const payload = new Uint8Array(8 + compat.length * 4);
  payload.set(asciiBytes("isom"), 0);
  setU32(payload, 4, 512);
  compat.forEach((brand, i) => payload.set(asciiBytes(brand), 8 + i * 4));
  return rawBox("ftyp", payload);
}

export function patchMp4(input, userOptions = {}) {
  const provided = { ...userOptions };
  const opts = { ...DEFAULTS, ...provided };
  const compat = opts.mode === "compat";
  const surgical = opts.mode === "surgical";
  const ghostSamples = compat ? Math.max(0, Math.min(100000, opts.ghostSamples | 0)) : 0;

  // En compat, la firma por defecto es la del taller.
  if (compat && provided.tagName === undefined) opts.tagName = COMPAT_TAGS.tagName;
  if (compat && provided.tagComment === undefined) opts.tagComment = COMPAT_TAGS.tagComment;
  // En quirúrgico, la firma imita a un mux de FFmpeg (se puede sobrescribir).
  if (surgical && provided.tagName === undefined) opts.tagName = SURGICAL_TAGS.tagName;
  if (surgical && provided.tagComment === undefined) opts.tagComment = SURGICAL_TAGS.tagComment;
  // Un mux de FFmpeg escribe el idioma como `und` si no sabe nada mejor.
  if (surgical && provided.language === undefined) opts.language = "und";

  const { bytes, boxes } = parseMp4(input);

  const unknown = boxes.filter((box) => !TOP_LEVEL.has(box.type));
  if (unknown.length) {
    throw new Mp4Error(`Cajas superiores no soportadas: ${unknown.map((b) => b.type).join(", ")}.`);
  }
  if (boxes.some((box) => FRAGMENTED.has(box.type))) {
    throw new Mp4Error("MP4 fragmentado: se necesita remuxear primero.");
  }

  const ftypOriginal = boxes.filter((box) => box.type === "ftyp");
  const mdats = boxes.filter((box) => box.type === "mdat");
  const moov = boxes.find((box) => box.type === "moov");
  if (ftypOriginal.length !== 1 || mdats.length !== 1 || !moov || !moov.children) {
    throw new Mp4Error("Se requiere exactamente un ftyp, un moov y un mdat.");
  }
  const mdat = mdats[0];

  const tracks = moov.children.filter((box) => box.type === "trak");
  const video = tracks.find((trak) => handlerType(trak) === "vide");
  const audio = tracks.find((trak) => handlerType(trak) === "soun");
  if (!video) throw new Mp4Error("No hay pista de vídeo.");

  const stsd = pathBox(video, "mdia", "minf", "stbl", "stsd");
  const codec = stsd && stsd.payload.byteLength >= 16 ? ascii(stsd.payload, 12, 4) : "";
  if (!VIDEO_CODECS.has(codec)) {
    throw new Mp4Error(`Códec "${codec || "desconocido"}": hay que convertir a H.264/HEVC antes de parchear.`);
  }

  const report = {
    mode: opts.mode,
    codec,
    ghostSamples,
    colorTagged: false,
    emptyEdit: false,
    timestampPatch: true,
    paspAdded: false,
    audioTrackCloned: false,
    audioTail: null,
    tagName: opts.tagOutput ? opts.tagName : null,
    tagComment: opts.tagOutput ? opts.tagComment : null,
    language: opts.language,
  };

  if (surgical) {
    const mvhd = findChild(moov, "mvhd");
    report.movieTimescale = mvhd ? u32(mvhd.payload, mvhd.payload[0] === 1 ? 20 : 12) || 1000 : 1000;
  }

  /* --- transformaciones de contenedor --- */
  zeroTimestamps(moov);
  setLanguage(moov, opts.language);

  if (opts.forceBt709) report.colorTagged = addColorTag(video);

  if (compat) {
    setHandlerName(video, opts.handlerName);
    setCompressorName(video, opts.tagName);
    if (audio) {
      setHandlerName(audio, opts.handlerName);
    }

    // Edit list de vídeo: anteponer un edit vacío (16 ticks) si ya existía.
    {
      const elst = pathBox(video, "edts", "elst");
      if (elst) {
        const { version, entries } = readEditList(elst);
        if (entries.length && opts.emptyEditDuration > 0) {
          const empty = makeEmptyEdit(version);
          if (version === 1) viewOf(empty).setBigUint64(0, BigInt(opts.emptyEditDuration), false);
          else setU32(empty, 0, opts.emptyEditDuration);
          writeEditList(elst, version, [empty, entries[0]]);
          report.emptyEdit = true;
        }
      }
    }

    // Edit list de audio: poner a cero solo media_time del primer edit
    // (el original conserva la duración).
    if (audio) {
      const elst = pathBox(audio, "edts", "elst");
      if (elst) {
        const { version, entries } = readEditList(elst);
        if (entries.length) {
          const first = entries[0].slice();
          const mediaTimeSize = version === 1 ? 8 : 4;
          first.fill(0, mediaTimeSize, mediaTimeSize * 2);
          writeEditList(elst, version, [first]);
        }
      }
    }

    // stts: separar el último sample en su propia entrada.
    const stts = pathBox(video, "mdia", "minf", "stbl", "stts");
    if (stts && ghostSamples > 0) {
      const entries = readStts(stts);
      if (entries.length === 1 && entries[0][0] > 1) {
        writeStts(stts, [
          [entries[0][0] - 1, entries[0][1]],
          [1, 1],
        ]);
      }
    }
  }

  // Quitar udta/meta antiguos de moov y añadir la etiqueta propia.
  moov.children = moov.children.filter((box) => box.type !== "udta" && box.type !== "meta");
  stripInsideMoov(moov);
  if (opts.tagOutput) {
    for (const trak of tracks) {
      if (trak.children) trak.children = trak.children.filter((box) => box.type !== "udta");
    }
    moov.children.push(makeUdta(opts.tagName, opts.tagComment));
  }

  /* --- modo quirúrgico: pasp + cola de audio real + pista clonada --- */
  let audioTail = null;
  if (surgical) {
    report.paspAdded = addPasp(video);
    if (audio) {
      // El clon hereda lo que haya en la pista: se limpia antes.
      if (audio.children) audio.children = audio.children.filter((box) => box.type !== "udta");
      audioTail = applyAudioTail(moov, audio, report.movieTimescale);
      report.audioTail = audioTail.report;
      report.audioTrackCloned = audioTail.report.clonedTrack;
    } else {
      report.audioTail = { applied: false, reason: "el archivo no tiene pista de audio" };
    }
  }

  const ftyp = makeFtyp(codec);
  const ftypBytes = serializeBox(ftyp);
  const freeBytes = boxBytes("free", new Uint8Array(0));

  /* --- tablas de muestras: ghost samples --- */
  const stsz = pathBox(video, "mdia", "minf", "stbl", "stsz");
  const stsc = pathBox(video, "mdia", "minf", "stbl", "stsc");
  const stcoBoxes = [...findAll(video, "stco"), ...findAll(video, "co64")];

  if (ghostSamples > 0 && stsz && stsc && stcoBoxes.length) {
    const { sizes } = readSampleSizes(stsz);
    writeSampleSizes(stsz, [...sizes, ...Array(ghostSamples).fill(GHOST_SAMPLE.byteLength)]);

    const chunks = readOffsets(stcoBoxes[0]).length;
    const payload = stsc.payload;
    const entryCount = u32(payload, 4);
    const nextSc = new Uint8Array(payload.byteLength + 12);
    nextSc.set(payload.subarray(0, payload.byteLength));
    setU32(nextSc, 4, entryCount + 1);
    setU32(nextSc, 8 + entryCount * 12, chunks + 1);
    setU32(nextSc, 12 + entryCount * 12, 1);
    setU32(nextSc, 16 + entryCount * 12, 1);
    stsc.payload = nextSc;
  }

  /* --- offsets de la cola de audio (por muestra, sin desplazar todavía) --- */
  const tailTargets = new Set(audioTail && audioTail.report.applied ? audioTail.targets : []);
  if (tailTargets.size) {
    for (const box of tailTargets) writeOffsets(box, audioTail.perSample);
  }

  /* --- recomponer offsets y moov (iterando por si stco pasa a co64) --- */
  const offsetBoxes = [...findAll(moov, "stco"), ...findAll(moov, "co64")];
  const originalOffsets = new Map(offsetBoxes.map((box) => [box, readOffsets(box)]));
  const videoOffsetBoxes = new Set(stcoBoxes);
  const payload = bytes.subarray(mdat.payloadStart, mdat.payloadEnd);
  // Fiel al original: se añaden 8 bytes de relleno fantasma una sola vez,
  // aunque stsz declare `ghostSamples` muestras de 8 bytes cada una.
  const ghostBytes = ghostSamples > 0 ? GHOST_SAMPLE.slice() : new Uint8Array(0);
  const tailBytes = audioTail && audioTail.report.applied ? AUDIO_TAIL_BYTES : new Uint8Array(0);
  const appendBytes = ghostSamples > 0 ? ghostBytes : tailBytes;
  const mdatPayloadSize = payload.byteLength + appendBytes.byteLength;
  let moovBytes = serializeBox(moov);
  let headerSize = mdatPayloadSize + 8 > 0xffffffff ? 16 : 8;
  let stable = false;

  for (let iteration = 0; iteration < 12 && !stable; iteration += 1) {
    const base = ftypBytes.byteLength + freeBytes.byteLength + moovBytes.byteLength + headerSize;
    const delta = base - mdat.payloadStart;
    const appendStart = base + payload.byteLength;

    for (const box of offsetBoxes) {
      const source = originalOffsets.get(box);
      if (!source) continue;
      const shifted = source.map((value) => value + delta);
      // Fiel al original: N offsets de chunk distintos apuntando todos al
      // mismo inicio de la zona fantasma (stsc les asigna 1 sample a cada uno).
      if (videoOffsetBoxes.has(box) && ghostSamples > 0) {
        for (let i = 0; i < ghostSamples; i += 1) shifted.push(appendStart);
      }
      // Quirúrgico: un offset por frame de silencio, al final del mdat.
      if (tailTargets.has(box)) {
        let at = appendStart;
        for (const size of AUDIO_TAIL_SIZES) {
          shifted.push(at);
          at += size;
        }
      }
      writeOffsets(box, shifted);
    }

    const nextMoov = serializeBox(moov);
    const nextHeader = mdatPayloadSize + 8 > 0xffffffff ? 16 : 8;
    stable = nextMoov.byteLength === moovBytes.byteLength && nextHeader === headerSize;
    moovBytes = nextMoov;
    headerSize = nextHeader;
  }

  if (!stable) throw new Mp4Error("No se pudo estabilizar el tamaño de moov.");

  const mdatHeader = new Uint8Array(headerSize);
  if (headerSize === 16) {
    setU32(mdatHeader, 0, 1);
    mdatHeader.set(asciiBytes("mdat"), 4);
    viewOf(mdatHeader).setBigUint64(8, BigInt(mdatPayloadSize + 16), false);
  } else {
    setU32(mdatHeader, 0, mdatPayloadSize + 8);
    mdatHeader.set(asciiBytes("mdat"), 4);
  }

  const parts = [ftypBytes, freeBytes, moovBytes, mdatHeader, payload, appendBytes];
  const output = concat(parts);

  const sttsFinal = pathBox(video, "mdia", "minf", "stbl", "stts");
  const stszFinal = pathBox(video, "mdia", "minf", "stbl", "stsz");
  report.sttsSamples = sttsFinal ? readStts(sttsFinal).reduce((sum, [count]) => sum + count, 0) : 0;
  report.stszSamples = stszFinal ? readSampleSizes(stszFinal).sizes.length : 0;
  report.chunkOffsets = offsetBoxes.reduce((sum, box) => sum + readOffsets(box).length, 0);
  report.ghostOffsets = ghostSamples;
  report.sampleTableMismatch = report.sttsSamples !== report.stszSamples;

  // Coherencia de todas las pistas (no solo la de vídeo). Se recalculan aquí
  // porque el modo quirúrgico añade una pista clonada al moov.
  const finalTracks = moov.children.filter((box) => box.type === "trak");
  report.trackCount = finalTracks.length;
  report.trackTables = finalTracks.map((trak) => {
    const stts = pathBox(trak, "mdia", "minf", "stbl", "stts");
    const stsz = pathBox(trak, "mdia", "minf", "stbl", "stsz");
    const hdlr = pathBox(trak, "mdia", "hdlr");
    return {
      handler: hdlr ? ascii(hdlr.payload, 8, 4) : "?",
      samples: stsz ? readSampleSizes(stsz).sizes.length : 0,
      timing: stts ? readStts(stts).reduce((sum, [count]) => sum + count, 0) : 0,
    };
  });
  report.tablesConsistent = report.trackTables.every((track) => track.samples === track.timing);

  report.inputSize = bytes.byteLength;
  report.outputSize = output.byteLength;
  report.sizeDelta = output.byteLength - bytes.byteLength;
  report.parts = parts.map((part) => part.byteLength);

  return { bytes: output, report };
}

/* ------------------------------------------------------------------ */
/* verificación                                                        */
/* ------------------------------------------------------------------ */

export function verifyMp4(input, options = {}) {
  const { bytes, boxes } = parseMp4(input);
  const issues = [];
  const moovIndex = boxes.findIndex((box) => box.type === "moov");
  const mdatIndex = boxes.findIndex((box) => box.type === "mdat");
  const mdat = boxes[mdatIndex];

  if (moovIndex < 0 || mdatIndex < 0) throw new Mp4Error("Faltan moov o mdat en la salida.");
  if (moovIndex > mdatIndex) issues.push("moov no está antes de mdat (sin faststart).");

  const moov = boxes[moovIndex];
  const offsets = [...findAll(moov, "stco"), ...findAll(moov, "co64")];
  let chunks = 0;
  for (const box of offsets) {
    for (const value of readOffsets(box)) {
      chunks += 1;
      if (value < mdat.payloadStart || value > mdat.payloadEnd) {
        issues.push(`Chunk offset ${value} fuera del mdat.`);
        break;
      }
    }
  }

  // Coherencia de tablas: stts y stsz deben declarar el mismo nº de muestras.
  if (options.expectConsistentTables) {
    for (const trak of (moov.children ?? []).filter((box) => box.type === "trak")) {
      const stts = pathBox(trak, "mdia", "minf", "stbl", "stts");
      const stsz = pathBox(trak, "mdia", "minf", "stbl", "stsz");
      if (!stts || !stsz) continue;
      const timing = readStts(stts).reduce((sum, [count]) => sum + count, 0);
      const samples = readSampleSizes(stsz).sizes.length;
      if (timing !== samples) {
        issues.push(`Tablas descuadradas: stts declara ${timing} muestras y stsz ${samples}.`);
      }
    }
  }

  // Firma: el texto debe existir en algún udta del moov.
  if (options.tagName) {
    const needle = new TextEncoder().encode(options.tagName);
    const found = findAll(moov, "udta").some((box) => indexOfBytes(box.payload, needle) !== -1);
    if (!found) issues.push(`No se encontró la firma "${options.tagName}" en udta.`);
  }

  // Nº mínimo de pistas (el modo quirúrgico deja dos de audio).
  if (options.minAudioTracts) {
    const audioTracks = (moov.children ?? []).filter(
      (box) => box.type === "trak" && handlerType(box) === "soun",
    ).length;
    if (audioTracks < options.minAudioTracts) {
      issues.push(`Se esperaban al menos ${options.minAudioTracts} pistas de audio y hay ${audioTracks}.`);
    }
  }

  const info = inspectMp4(bytes);
  return { ok: issues.length === 0, issues, chunks, info };
}
