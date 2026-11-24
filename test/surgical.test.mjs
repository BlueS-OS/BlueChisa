/**
 * surgical.test.mjs — prueba del motor de Chisa sin navegador.
 *
 * Construye un MP4 sintético (ftyp + moov con pista de vídeo avc1 y pista de
 * audio mp4a/esds 48 kHz + mdat), aplica los tres modos y comprueba la
 * estructura resultante. No hay vídeo real: se valida el contenedor, que es
 * justo lo que el parcheador toca.
 *
 *   node test/surgical.test.mjs
 */

import { inspectMp4, parseMp4, patchMp4, verifyMp4, SURGICAL_BINARY } from "../src/mp4.js";

/* ------------------------------------------------------------------ */
/* mini constructor de bytes                                           */
/* ------------------------------------------------------------------ */

const asciiBytes = (text) => Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);
const zeros = (n) => new Uint8Array(n);

function u16(...values) {
  const out = new Uint8Array(values.length * 2);
  const view = new DataView(out.buffer);
  values.forEach((value, i) => view.setUint16(i * 2, value, false));
  return out;
}

function u32(...values) {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((value, i) => view.setUint32(i * 4, value >>> 0, false));
  return out;
}

function u64(...values) {
  const out = new Uint8Array(values.length * 8);
  const view = new DataView(out.buffer);
  values.forEach((value, i) => view.setBigUint64(i * 8, BigInt(value), false));
  return out;
}

function concat(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function box(type, ...parts) {
  const payload = concat(parts);
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length, false);
  out.set(asciiBytes(type), 4);
  out.set(payload, 8);
  return out;
}

function fullBox(type, version, flags, ...parts) {
  const head = new Uint8Array([version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]);
  return box(type, head, ...parts);
}

const IDENTITY = u32(0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000);

/* ------------------------------------------------------------------ */
/* constructor del MP4 sintético                                       */
/* ------------------------------------------------------------------ */

const VIDEO_SAMPLES = 100;
const VIDEO_SAMPLE_SIZE = 8;
const AUDIO_SAMPLES = 10;
const AUDIO_SAMPLE_SIZE = 20;

function visualEntry(width, height, withPasp = false) {
  return box(
    "avc1",
    zeros(6), u16(1), // reserved + data_reference_index
    u16(0), u16(0), zeros(12), // pre_defined, reserved, pre_defined[3]
    u16(width), u16(height),
    u32(0x00480000), u32(0x00480000),
    zeros(4),
    u16(1), // frame_count
    zeros(32), // compressorname
    u16(0x0018), // depth
    u16(0xffff),
    // Un mux de FFmpeg deja `btrt` al final de la entrada: el pasp debe
    // insertarse DELANTE, como en Shore.
    ...(withPasp ? [box("pasp", u32(1), u32(1))] : []),
    box("btrt", u32(0), u32(0), u32(0)),
  );
}

function audioEntry(sampleRate) {
  const esds = box("esds", zeros(4), asciiBytes("esds-payload"));
  return box(
    "mp4a",
    zeros(6), u16(1),
    u16(0), u16(0),zeros(4),
    u16(2), // channelcount
    u16(16), // samplesize
    u16(0), u16(0),
    u32(sampleRate * 65536), // samplerate 16.16
    esds,
  );
}

function videoTrak(videoOffset, withPasp = false, longForm = false) {
  const tkhd = longForm
    ? fullBox(
        "tkhd", 1, 7,
        u64(0), u64(0), u32(1), u32(0), u64(4000),
        zeros(8), u16(0), u16(0), u16(0), u16(0),
        IDENTITY, u32(1080 * 65536), u32(1920 * 65536),
      )
    : fullBox(
        "tkhd", 0, 7,
        u32(0), u32(0), u32(1), u32(0), u32(4000),
        zeros(8), u16(0), u16(0), u16(0), u16(0),
        IDENTITY, u32(1080 * 65536), u32(1920 * 65536),
      );
  const mdhd = longForm
    ? fullBox("mdhd", 1, 0, u64(0), u64(0), u32(1000), u64(4000), u16(0x15c7), u16(0))
    : fullBox("mdhd", 0, 0, u32(0), u32(0), u32(1000), u32(4000), u16(0x15c7), u16(0));
  const hdlr = fullBox("hdlr", 0, 0, u32(0), asciiBytes("vide"), zeros(12), asciiBytes("VideoHandler"), zeros(1));
  const stsd = fullBox("stsd", 0, 0, u32(1), visualEntry(1080, 1920, withPasp));
  const stts = fullBox("stts", 0, 0, u32(1), u32(VIDEO_SAMPLES), u32(40));
  const stsc = fullBox("stsc", 0, 0, u32(1), u32(1), u32(VIDEO_SAMPLES), u32(1));
  const stsz = fullBox("stsz", 0, 0, u32(0), u32(VIDEO_SAMPLES), ...Array(VIDEO_SAMPLES).fill(VIDEO_SAMPLE_SIZE).map((s) => u32(s)));
  const stco = fullBox("stco", 0, 0, u32(1), u32(videoOffset));
  const stbl = box("stbl", stsd, stts, stsc, stsz, stco);
  const minf = box("minf", stbl);
  const mdia = box("mdia", mdhd, hdlr, minf);
  return box("trak", tkhd, mdia);
}

function audioTrak(audioOffset, sampleRate, perChunk = 1, withEdit = false, longForm = false) {
  const tkhd = longForm
    ? fullBox(
        "tkhd", 1, 7,
        u64(0), u64(0), u32(2), u32(0), u64(4000),
        zeros(8), u16(0), u16(0), u16(0), u16(0),
        IDENTITY, u32(0), u32(0),
      )
    : fullBox(
        "tkhd", 0, 7,
        u32(0), u32(0), u32(2), u32(0), u32(4000),
        zeros(8), u16(0), u16(0), u16(0), u16(0),
        IDENTITY, u32(0), u32(0),
      );
  const mdhd = longForm
    ? fullBox("mdhd", 1, 0, u64(0), u64(0), u32(sampleRate), u64(AUDIO_SAMPLES * 1024), u16(0x15c7), u16(0))
    : fullBox("mdhd", 0, 0, u32(0), u32(0), u32(sampleRate), u32(AUDIO_SAMPLES * 1024), u16(0x15c7), u16(0));
  const hdlr = fullBox("hdlr", 0, 0, u32(0), asciiBytes("soun"), zeros(12), asciiBytes("SoundHandler"), zeros(1));
  const stsd = fullBox("stsd", 0, 0, u32(1), audioEntry(sampleRate));
  const stts = fullBox("stts", 0, 0, u32(1), u32(AUDIO_SAMPLES), u32(1024));
  const stsc = fullBox("stsc", 0, 0, u32(1), u32(1), u32(perChunk), u32(1));
  const stsz = fullBox("stsz", 0, 0, u32(0), u32(AUDIO_SAMPLES), ...Array(AUDIO_SAMPLES).fill(AUDIO_SAMPLE_SIZE).map((s) => u32(s)));
  const chunks = Math.ceil(AUDIO_SAMPLES / perChunk);
  const stco = fullBox(
    "stco", 0, 0, u32(chunks),
    ...Array.from({ length: chunks }, (_, i) => u32(audioOffset + i * perChunk * AUDIO_SAMPLE_SIZE)),
  );
  const stbl = box("stbl", stsd, stts, stsc, stsz, stco);
  const minf = box("minf", stbl);
  const mdia = box("mdia", mdhd, hdlr, minf);
  // elst como el que escribe FFmpeg para AAC: 1 entrada, media_time = 0.
  const elst = withEdit ? box("edts", fullBox("elst", 0, 0, u32(1), u32(4000), u32(0), u16(1), u16(0))) : null;
  return box("trak", tkhd, mdia, ...(elst ? [elst] : []));
}

function buildSample({
  videoOffset = 0,
  audioOffset = 0,
  withAudio = true,
  sampleRate = 48000,
  audioPerChunk = 1,
  audioEdit = false,
  videoPasp = false,
  longForm = false,
} = {}) {
  const ftyp = box("ftyp", asciiBytes("isom"), u32(512), asciiBytes("isom"), asciiBytes("iso2"), asciiBytes("avc1"), asciiBytes("mp41"));
  const mvhd = longForm
    ? fullBox(
        "mvhd", 1, 0,
        u64(0), u64(0), u32(1000), u64(4000),
        u32(0x00010000), u16(0x0100), u16(0), zeros(8),
        IDENTITY, zeros(24), u32(withAudio ? 3 : 2),
      )
    : fullBox(
        "mvhd", 0, 0,
        u32(0), u32(0), u32(1000), u32(4000),
        u32(0x00010000), u16(0x0100), u16(0), zeros(8),
        IDENTITY, zeros(24), u32(withAudio ? 3 : 2),
      );
  const traks = [videoTrak(videoOffset, videoPasp, longForm)];
  if (withAudio) traks.push(audioTrak(audioOffset, sampleRate, audioPerChunk, audioEdit, longForm));
  const moov = box("moov", mvhd, ...traks);
  const mdatPayload = zeros(VIDEO_SAMPLES * VIDEO_SAMPLE_SIZE + AUDIO_SAMPLES * AUDIO_SAMPLE_SIZE);
  const mdat = box("mdat", mdatPayload);
  return concat([ftyp, moov, mdat]);
}

/** Construye el archivo con offsets reales (dos pasadas, mismo tamaño). */
function sample(options = {}) {
  const draft = buildSample(options);
  const { boxes } = parseMp4(draft);
  const mdat = boxes.find((b) => b.type === "mdat");
  const videoOffset = mdat.payloadStart;
  const audioOffset = mdat.payloadStart + VIDEO_SAMPLES * VIDEO_SAMPLE_SIZE;
  return buildSample({ ...options, videoOffset, audioOffset });
}

/* ------------------------------------------------------------------ */
/* aserciones                                                          */
/* ------------------------------------------------------------------ */

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function trakList(bytes) {
  const { boxes } = parseMp4(bytes);
  const moov = boxes.find((b) => b.type === "moov");
  return {
    moov,
    mdat: boxes.find((b) => b.type === "mdat"),
    tracks: (moov.children ?? []).filter((b) => b.type === "trak"),
  };
}

function handlerOf(trak) {
  const mdia = trak.children.find((b) => b.type === "mdia");
  const hdlr = mdia.children.find((b) => b.type === "hdlr");
  return String.fromCharCode(...hdlr.payload.subarray(8, 12));
}

function stblOf(trak) {
  return trak.children
    .find((b) => b.type === "mdia")
    .children.find((b) => b.type === "minf")
    .children.find((b) => b.type === "stbl");
}

function pathIn(box, ...types) {
  let current = box;
  for (const type of types) {
    if (!current || !current.children) return null;
    current = current.children.find((child) => child.type === type) ?? null;
  }
  return current;
}

const u32at = (bytes, at) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at, false);
const u16at = (bytes, at) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(at, false);

function sampleCounts(trak) {
  const stbl = stblOf(trak);
  const stts = stbl.children.find((b) => b.type === "stts");
  const stsz = stbl.children.find((b) => b.type === "stsz");
  let timing = 0;
  const entries = u32at(stts.payload, 4);
  for (let i = 0; i < entries; i += 1) timing += u32at(stts.payload, 8 + i * 8);
  return { timing, sizes: u32at(stsz.payload, 8) };
}

function chunkOffsets(trak) {
  const stbl = stblOf(trak);
  const box = stbl.children.find((b) => b.type === "stco" || b.type === "co64");
  const count = u32at(box.payload, 4);
  const stride = box.type === "co64" ? 8 : 4;
  const view = new DataView(box.payload.buffer, box.payload.byteOffset, box.payload.byteLength);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push(stride === 8 ? Number(view.getBigUint64(8 + i * 8, false)) : view.getUint32(8 + i * 4, false));
  }
  return out;
}

const containsText = (bytes, text) => {
  const needle = asciiBytes(text);
  outer: for (let i = 0; i + needle.length <= bytes.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) if (bytes[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
};

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/* ------------------------------------------------------------------ */
/* 1. binarios de referencia                                           */
/* ------------------------------------------------------------------ */

console.log("\n[1] binarios del modo quirúrgico");

const REF_TAIL_HEAD = "de02004c61766336322e31312e31303000422008c11838";
const REF_TAIL_FRAME = "211004608c1c";
const REF_PASP = "00000010706173700000000100000001";
const REF_STSD_ONE =
  "0000007b7374736400000000000000010000006b6d7034610000000000000001" +
  "00000000000000000002001000000000bb8000000000003365736473000000" +
  "000380808022000200048080801440150000000001f3f60001ea8d05808080" +
  "0211900680808001020000001462747274000000000001f3f60001ea8d";

check("cola de audio = 125 bytes", SURGICAL_BINARY.audioTail.length === 125, String(SURGICAL_BINARY.audioTail.length));
check("cola: descriptor Lavc (23 B)", hex(SURGICAL_BINARY.audioTail.subarray(0, 23)) === REF_TAIL_HEAD);
check(
  "cola: 17 frames de 6 B",
  Array.from({ length: 17 }, (_, i) => hex(SURGICAL_BINARY.audioTail.subarray(23 + 6 * i, 29 + 6 * i))).every(
    (chunk) => chunk === REF_TAIL_FRAME,
  ),
);
check("tamaños de la cola suman 125", SURGICAL_BINARY.audioTailSizes.reduce((a, b) => a + b, 0) === 125);
check("pasp 1:1", hex(SURGICAL_BINARY.pasp) === REF_PASP);
check("stsd de una entrada", hex(SURGICAL_BINARY.stsdOneEntry) === REF_STSD_ONE.slice(16));
{
  // La caja mide 236 B = 8 (cabecera) + 8 (version/flags + nº entradas) +
  // 107 (entrada real) + 113 (entrada `Lavc62.11.100`). Debe encajar exacto.
  const two = SURGICAL_BINARY.stsdTwoEntries;
  const at = (offset) => new DataView(two.buffer, two.byteOffset, two.byteLength).getUint32(offset, false);
  check("stsd de dos entradas: 228 B de payload", two.length === 228, String(two.length));
  check("stsd de dos entradas: entry_count = 2", at(4) === 2, String(at(4)));
  check("stsd de dos entradas: 1ª entrada de 107 B en el offset 8", at(8) === 0x6b, String(at(8)));
  check("stsd de dos entradas: 2ª entrada de 113 B en el offset 115", at(115) === 0x71, String(at(115)));
  check(
    "stsd de dos entradas: ambas entradas son mp4a",
    hex(two.subarray(12, 16)) === "6d703461" && hex(two.subarray(119, 123)) === "6d703461",
    `${hex(two.subarray(12, 16))} / ${hex(two.subarray(119, 123))}`,
  );
  check("stsd de dos entradas: suma exacta 8 + 107 + 113", 8 + at(8) + at(115) === two.length);
}

/* ------------------------------------------------------------------ */
/* 2. modo safe                                                        */
/* ------------------------------------------------------------------ */

console.log("\n[2] modo safe");

{
  const input = sample();
  const { bytes, report } = patchMp4(input, { mode: "safe" });
  const { tracks } = trakList(bytes);
  const audio = tracks.filter((t) => handlerOf(t) === "soun");
  const video = tracks.find((t) => handlerOf(t) === "vide");

  check("una sola pista de audio", audio.length === 1, String(audio.length));
  check("no añade cola de audio", report.audioTail === null);
  check("no añade pasp", report.paspAdded === false);
  check("tablas coherentes", tracks.every((t) => { const c = sampleCounts(t); return c.timing === c.sizes; }));
  check("offsets dentro del mdat", verifyMp4(bytes).ok, verifyMp4(bytes).issues.join("; "));
  check("vídeo conserva 100 muestras", sampleCounts(video).sizes === VIDEO_SAMPLES);
}

/* ------------------------------------------------------------------ */
/* 3. modo compat (no debe cambiar)                                    */
/* ------------------------------------------------------------------ */

console.log("\n[3] modo compat");

{
  const input = sample();
  const { bytes, report } = patchMp4(input, { mode: "compat", ghostSamples: 100 });
  const { tracks } = trakList(bytes);
  check("una sola pista de audio", tracks.filter((t) => handlerOf(t) === "soun").length === 1);
  check("no añade cola de audio", report.audioTail === null);
  check("descuadre intacto", report.sampleTableMismatch === true);
  check("ghost offsets declarados", report.ghostOffsets === 100);
  check("firma del taller por defecto", containsText(bytes, "BlueChisa-v2.0.3"));
  check("verificación estructural", verifyMp4(bytes).ok, verifyMp4(bytes).issues.join("; "));
}

/* ------------------------------------------------------------------ */
/* 4. modo quirúrgico                                                  */
/* ------------------------------------------------------------------ */

console.log("\n[4] modo quirúrgico");

{
  const input = sample();
  const { bytes, report } = patchMp4(input, { mode: "surgical" });
  const { tracks, mdat } = trakList(bytes);
  const audio = tracks.filter((t) => handlerOf(t) === "soun");
  const video = tracks.find((t) => handlerOf(t) === "vide");

  check("dos pistas de audio", audio.length === 2, String(audio.length));
  check("cola aplicada", report.audioTail?.applied === true, report.audioTail?.reason ?? "");
  check("18 frames de silencio", report.audioTail?.frames === 18);
  check("0,384 s de cola", Math.abs(report.audioTail.seconds - 0.384) < 1e-9);
  check("pista clonada", report.audioTrackCloned === true);
  check("pasp añadido", report.paspAdded === true);
  const videoStsd = stblOf(video).children.find((b) => b.type === "stsd").payload;
  // safe añade `colr`; quirúrgico añade lo mismo + `pasp` (16 B exactos).
  const safeVideo = trakList(patchMp4(input, { mode: "safe" }).bytes).tracks.find((t) => handlerOf(t) === "vide");
  const safeEntrySize = u32at(stblOf(safeVideo).children.find((b) => b.type === "stsd").payload, 8);
  check("pasp visible en el stsd de vídeo", containsText(videoStsd, "pasp"));
  {
    // El pasp va delante de btrt, igual que en el patcher de referencia.
    const at = (needle) => {
      const bytes = asciiBytes(needle);
      outer: for (let i = 0; i + 4 <= videoStsd.length; i += 1) {
        for (let j = 0; j < 4; j += 1) if (videoStsd[i + j] !== bytes[j]) continue outer;
        return i;
      }
      return -1;
    };
    check("pasp antes de btrt", at("pasp") !== -1 && at("btrt") !== -1 && at("pasp") < at("btrt"), `${at("pasp")} / ${at("btrt")}`);
    // La entrada mide exactamente 16 B más que en modo safe.
    check(
      "tamaño de la entrada stsd = safe + 16 B",
      u32at(videoStsd, 8) === safeEntrySize + 16,
      `${u32at(videoStsd, 8)} vs ${safeEntrySize + 16}`,
    );
  }

  for (const [i, trak] of tracks.entries()) {
    const counts = sampleCounts(trak);
    check(`pista ${i} (${handlerOf(trak)}): stts == stsz`, counts.timing === counts.sizes, `${counts.timing} vs ${counts.sizes}`);
  }

  const original = sampleCounts(tracks.find((t) => handlerOf(t) === "soun"));
  check("audio declara 28 muestras", original.sizes === AUDIO_SAMPLES + 18, String(original.sizes));

  const offsets = chunkOffsets(audio[0]);
  check("un offset por muestra (28)", offsets.length === AUDIO_SAMPLES + 18, String(offsets.length));
  check(
    "los 18 offsets de la cola apuntan dentro del mdat",
    offsets.slice(-18).every((value) => value >= mdat.payloadStart && value <= mdat.payloadEnd),
  );
  check("ambas pistas de audio comparten offsets", JSON.stringify(chunkOffsets(audio[1])) === JSON.stringify(offsets));
  check(
    "la cola empieza donde acaba el audio original",
    offsets[AUDIO_SAMPLES] === offsets[AUDIO_SAMPLES - 1] + AUDIO_SAMPLE_SIZE,
    `${offsets[AUDIO_SAMPLES]} vs ${offsets[AUDIO_SAMPLES - 1] + AUDIO_SAMPLE_SIZE}`,
  );

  const { moov } = trakList(bytes);
  const mvhd = moov.children.find((b) => b.type === "mvhd");
  check("next_track_ID = 4", u32at(mvhd.payload, mvhd.payload.length - 4) === 4);

  check("firma Lavf por defecto", containsText(bytes, "Lavf62.3.100"));
  check("no deja firma del taller", !containsText(bytes, "BlueChisa"));
  {
    const inputMdat = trakList(input).mdat;
    const grown = mdat.payloadEnd - mdat.payloadStart;
    const before = inputMdat.payloadEnd - inputMdat.payloadStart;
    check("el payload del mdat crece exactamente 125 B", grown === before + 125, `${grown} vs ${before}`);
  }
  check("los 10 offsets originales siguen contiguos", offsets.slice(0, AUDIO_SAMPLES).every((v, i) => v === offsets[0] + i * AUDIO_SAMPLE_SIZE));
  check("cola al final del archivo", hex(bytes.subarray(bytes.length - 125)) === hex(SURGICAL_BINARY.audioTail));

  const verification = verifyMp4(bytes, {
    expectConsistentTables: true,
    tagName: "Lavf62.3.100",
    minAudioTracts: 2,
  });
  check("verificación completa", verification.ok, verification.issues.join("; "));
  check("tablas coherentes en todas las pistas", report.tablesConsistent === true);

  // El fixture declara idioma `eng` (0x15c7): quirúrgico debe dejarlo en `und`.
  const languages = tracks
    .map((t) => pathIn(t, "mdia", "mdhd"))
    .map((mdhd) => u16at(mdhd.payload, mdhd.payload[0] === 1 ? 32 : 20));
  check("idioma und por defecto", languages.every((value) => value === 0x55c4), languages.map((v) => v.toString(16)).join(","));
  check("report.tagName = Lavf", report.tagName === "Lavf62.3.100", String(report.tagName));
  check("report.trackCount = 3", report.trackCount === 3, String(report.trackCount));
  check("report.movieTimescale = 1000", report.movieTimescale === 1000, String(report.movieTimescale));
}

{
  // Sin firma: no debe quedar ningún udta ni mención a Lavf.
  const input = sample();
  const { bytes, report } = patchMp4(input, { mode: "surgical", tagOutput: false });
  check("sin firma: report.tagName nulo", report.tagName === null);
  check("sin firma: no hay texto Lavf", !containsText(bytes, "Lavf62.3.100"));
  check("sin firma: cola igual aplicada", report.audioTail?.applied === true);
  const verification = verifyMp4(bytes, { expectConsistentTables: true });
  check("sin firma: verificación válida", verification.ok, verification.issues.join("; "));
}

/* ------------------------------------------------------------------ */
/* 5. casos en los que la cola NO debe aplicarse                       */
/* ------------------------------------------------------------------ */

console.log("\n[5] degradación segura");

{
  const input = sample({ withAudio: false });
  const { bytes, report } = patchMp4(input, { mode: "surgical" });
  check("sin audio: cola no aplicada", report.audioTail?.applied === false);
  check("sin audio: motivo informado", typeof report.audioTail?.reason === "string" && report.audioTail.reason.length > 0);
  check("sin audio: salida válida", verifyMp4(bytes).ok, verifyMp4(bytes).issues.join("; "));
}

{
  const input = sample({ sampleRate: 44100 });
  const { bytes, report } = patchMp4(input, { mode: "surgical" });
  check("44,1 kHz: cola no aplicada", report.audioTail?.applied === false);
  check("44,1 kHz: motivo informado", /44100/.test(report.audioTail?.reason ?? ""), report.audioTail?.reason ?? "");
  check("44,1 kHz: una sola pista de audio", trakList(bytes).tracks.filter((t) => handlerOf(t) === "soun").length === 1);
  check("44,1 kHz: salida válida", verifyMp4(bytes).ok, verifyMp4(bytes).issues.join("; "));
}

/* ------------------------------------------------------------------ */
/* 6. formas reales: chunks múltiples, elst, pasp ya presente           */
/* ------------------------------------------------------------------ */

console.log("\n[6] formas reales");

{
  // Audio con 5 muestras por chunk (stco con 2 offsets) y elst de FFmpeg.
  const input = sample({ audioPerChunk: 5, audioEdit: true });
  const { bytes, report } = patchMp4(input, { mode: "surgical" });
  const { tracks, mdat } = trakList(bytes);
  const audio = tracks.filter((t) => handlerOf(t) === "soun");

  check("chunks múltiples: cola aplicada", report.audioTail?.applied === true, report.audioTail?.reason ?? "");
  check("chunks múltiples: dos pistas de audio", audio.length === 2, String(audio.length));

  const offsets = chunkOffsets(audio[0]);
  const tailOffsets = offsets.slice(AUDIO_SAMPLES);
  check("chunks múltiples: 28 offsets por muestra", offsets.length === AUDIO_SAMPLES + 18, String(offsets.length));
  check(
    "chunks múltiples: los 10 offsets originales se expanden por muestra",
    offsets.slice(0, AUDIO_SAMPLES).every((value, i) => value === offsets[0] + i * AUDIO_SAMPLE_SIZE),
  );
  check(
    "chunks múltiples: los 18 offsets de la cola son contiguos",
    tailOffsets.length === 18 &&
      tailOffsets.every((value, i) => (i === 0 ? true : value - tailOffsets[i - 1] === SURGICAL_BINARY.audioTailSizes[i - 1])),
  );
  check("chunks múltiples: offsets dentro del mdat", offsets.every((v) => v >= mdat.payloadStart && v <= mdat.payloadEnd));

  // elst: se extiende para no recortar la cola.
  const elst = pathIn(audio[0], "edts", "elst");
  check("elst: sigue existiendo", Boolean(elst));
  check("elst: duración ampliada a 4,384 s", elst && u32at(elst.payload, 8) === 4000 + 384, elst ? String(u32at(elst.payload, 8)) : "sin elst");

  check("chunks múltiples: tablas coherentes", report.tablesConsistent === true);
  check("chunks múltiples: salida válida", verifyMp4(bytes, { expectConsistentTables: true }).ok, verifyMp4(bytes, { expectConsistentTables: true }).issues.join("; "));
}

{
  // Vídeo que ya trae pasp: no se debe duplicar.
  const input = sample({ videoPasp: true });
  const { bytes, report } = patchMp4(input, { mode: "surgical" });
  const video = trakList(bytes).tracks.find((t) => handlerOf(t) === "vide");
  const stsdPayload = stblOf(video).children.find((b) => b.type === "stsd").payload;
  let count = 0;
  for (let i = 0; i + 4 <= stsdPayload.length; i += 1) {
    if (hex(stsdPayload.subarray(i, i + 4)) === "70617370") count += 1;
  }
  check("pasp existente: no se añade otro", report.paspAdded === false && count === 1, `${report.paspAdded} / ${count}`);
  check("pasp existente: cola sigue aplicándose", report.audioTail?.applied === true);
}

/* ------------------------------------------------------------------ */
/* 7. cabeceras de 64 bits (versión 1)                                 */
/* ------------------------------------------------------------------ */

console.log("\n[7] cabeceras versión 1 (64 bits)");

{
  const input = sample({ longForm: true });
  const { bytes, report } = patchMp4(input, { mode: "surgical" });
  const { tracks } = trakList(bytes);
  const audio = tracks.filter((t) => handlerOf(t) === "soun");

  check("v1: dos pistas de audio", audio.length === 2, String(audio.length));
  check("v1: cola aplicada", report.audioTail?.applied === true, report.audioTail?.reason ?? "");
  check("v1: movieTimescale = 1000", report.movieTimescale === 1000, String(report.movieTimescale));
  check("v1: tablas coherentes", report.tablesConsistent === true);

  // mdhd duración de audio = 28 muestras × 1024, en 64 bits.
  const audioMdhd = pathIn(audio[0], "mdia", "mdhd");
  const mdhdDuration = new DataView(audioMdhd.payload.buffer, audioMdhd.payload.byteOffset).getBigUint64(24, false);
  check("v1: mdhd de audio = 28 × 1024", mdhdDuration === BigInt(28 * 1024), String(mdhdDuration));

  const audioTkhd = pathIn(audio[0], "tkhd");
  const tkhdDuration = new DataView(audioTkhd.payload.buffer, audioTkhd.payload.byteOffset).getBigUint64(28, false);
  check("v1: tkhd de audio ampliado a 597 ticks", tkhdDuration === 597n, String(tkhdDuration));

  const idOf = (trak) => {
    const tkhd = pathIn(trak, "tkhd");
    return new DataView(tkhd.payload.buffer, tkhd.payload.byteOffset).getUint32(tkhd.payload[0] === 1 ? 20 : 12, false);
  };
  check("v1: la pista original conserva track_ID 2", idOf(audio[0]) === 2, String(idOf(audio[0])));
  check("v1: el clon recibe track_ID 3 (offset 20)", idOf(audio[1]) === 3, String(idOf(audio[1])));

  const { moov } = trakList(bytes);
  const mvhd = moov.children.find((b) => b.type === "mvhd");
  const nextId = new DataView(mvhd.payload.buffer, mvhd.payload.byteOffset).getUint32(mvhd.payload.byteLength - 4, false);
  check("v1: next_track_ID = 4", nextId === 4, String(nextId));

  check(
    "v1: verificación completa",
    verifyMp4(bytes, { expectConsistentTables: true, minAudioTracts: 2 }).ok,
    verifyMp4(bytes, { expectConsistentTables: true, minAudioTracts: 2 }).issues.join("; "),
  );
}

/* ------------------------------------------------------------------ */
/* 8. inspección                                                       */
/* ------------------------------------------------------------------ */

console.log("\n[8] inspección del original");

{
  const input = sample();
  const info = inspectMp4(input);
  check("códec avc1", info.codec === "avc1");
  check("1080×1920", Math.round(info.width) === 1080 && Math.round(info.height) === 1920);
  check("25 fps", Math.abs(info.fps - 25) < 1e-9, String(info.fps));
  check("4 s de duración", Math.abs(info.durationSec - 4) < 1e-9, String(info.durationSec));
  check("tiene audio", info.hasAudio === true);
  check("2 pistas", info.trackCount === 2);
}

/* ------------------------------------------------------------------ */

console.log(`\n${passed} comprobaciones ok, ${failures.length} fallos`);
if (failures.length) {
  console.log(failures.map((name) => ` - ${name}`).join("\n"));
  process.exit(1);
}
