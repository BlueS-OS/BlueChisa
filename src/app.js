import { inspectMp4, patchMp4, verifyMp4, Mp4Error } from "./mp4.js";
import { convertToMp4 } from "./ffmpeg.js";

/* Identidad del taller. Este repositorio es independiente: no hay overrides. */
const CONFIG = {
  runLabel: "Cortar el hilo",
  busyLabel: "Cortando…",
  suffix: "chisa",
  signatureLabel: "BlueChisa",
  tagName: "BlueChisa-v2.0.3",
  tagComment: "BlueChisa",
  handlerName: "BlueChisa-coded",
  resultTitle: "Patrón sellado",
  stages: [
    "Midiendo el archivo",
    "Trazando el patrón",
    "Preparando la tela",
    "Cortando el hilo",
    "Revisando la costura",
  ],
};
if (typeof window !== "undefined") window.__CHISA__ = CONFIG;

const $ = (id) => document.getElementById(id);

const els = {
  drop: $("drop"),
  file: $("file"),
  fileInfo: $("fileInfo"),
  fName: $("fName"),
  fSize: $("fSize"),
  fDur: $("fDur"),
  fKind: $("fKind"),
  clear: $("clear"),
  mode: $("mode"),
  ghost: $("ghost"),
  ghostField: $("ghostField"),
  tag: $("tag"),
  modeNote: $("modeNote"),
  compatNote: $("compatNote"),
  tagNote: $("tagNote"),
  run: $("run"),
  error: $("error"),
  progress: $("progress"),
  stage: $("stage"),
  pct: $("pct"),
  bar: $("barFill"),
  stages: $("stages"),
  result: $("result"),
  rTitle: $("rTitle"),
  rMeta: $("rMeta"),
  report: $("report"),
  changes: $("changes"),
  download: $("download"),
};

const STAGES = CONFIG.stages;

if (els.rTitle) els.rTitle.textContent = CONFIG.resultTitle;

let state = { file: null, duration: 0, busy: false, url: null };
let stageIndex = -1;

/* ------------------------------------------------------------------ */
/* formato                                                             */
/* ------------------------------------------------------------------ */

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(0, Math.round(bytes / 1e3))} KB`;
}

function fmtDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return m > 0 ? `${m} min ${s.toFixed(1)} s` : `${s.toFixed(1)} s`;
}

function fmtDelta(delta) {
  if (!delta) return "0";
  return `${delta > 0 ? "+" : ""}${fmtBytes(Math.abs(delta))}`;
}

/* ------------------------------------------------------------------ */
/* UI                                                                  */
/* ------------------------------------------------------------------ */

function setError(message) {
  els.error.hidden = !message;
  els.error.textContent = message ?? "";
}

function setBusy(busy) {
  state.busy = busy;
  els.run.disabled = busy || !state.file;
  els.run.textContent = busy ? CONFIG.busyLabel : CONFIG.runLabel;
  els.drop.style.pointerEvents = busy ? "none" : "";
  if (!busy) els.progress.hidden = true;
}

function buildStages() {
  els.stages.innerHTML = "";
  for (const label of STAGES) {
    const li = document.createElement("li");
    li.textContent = label;
    els.stages.append(li);
  }
}

function setStage(name, ratio = 0) {
  const index = Math.max(0, STAGES.indexOf(name));
  if (index !== stageIndex) {
    stageIndex = index;
    els.stage.textContent = name;
    [...els.stages.children].forEach((li, i) => {
      li.classList.toggle("is-done", i < index);
      li.classList.toggle("is-active", i === index);
    });
  }
  const pct = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
  els.pct.textContent = `${pct}%`;
  els.bar.style.width = `${pct}%`;

  if (pct >= 100) {
    [...els.stages.children].forEach((li) => {
      li.classList.remove("is-active");
      li.classList.add("is-done");
    });
  }
}

function showFile(file) {
  state.file = file;
  state.duration = 0;
  els.fileInfo.hidden = false;
  els.fName.textContent = file.name;
  els.fSize.textContent = fmtBytes(file.size);
  els.fDur.textContent = "leyendo…";
  const ext = /\.[a-z0-9]+$/i.exec(file.name);
  els.fKind.textContent = ext ? ext[0].slice(1).toUpperCase() : "desconocido";
  els.run.disabled = false;
  setError(null);
  els.result.hidden = true;

  const probe = document.createElement("video");
  probe.preload = "metadata";
  probe.onloadedmetadata = () => {
    state.duration = probe.duration || 0;
    els.fDur.textContent = fmtDuration(state.duration);
    URL.revokeObjectURL(probe.src);
  };
  probe.onerror = () => {
    els.fDur.textContent = "—";
    URL.revokeObjectURL(probe.src);
  };
  probe.src = URL.createObjectURL(file);

  if (file.size > 300 * 1024 * 1024) {
    setError(
      "Archivo grande: el procesado en navegador puede quedarse sin memoria. " +
        "Si falla, usa ffmpeg de escritorio (ver README).",
    );
  }
}

function clearFile() {
  state.file = null;
  state.duration = 0;
  els.file.value = "";
  els.fileInfo.hidden = true;
  els.run.disabled = true;
  els.result.hidden = true;
  if (state.url) URL.revokeObjectURL(state.url);
  state.url = null;
}

function updateMode() {
  const compat = els.mode.value === "compat";
  els.ghostField.hidden = !compat;
  els.modeNote.hidden = compat;
  els.compatNote.hidden = !compat;
  els.tagNote.hidden = !compat;
}

/* ------------------------------------------------------------------ */
/* procesado                                                           */
/* ------------------------------------------------------------------ */

async function processFile() {
  if (!state.file || state.busy) return;

  const file = state.file;
  const options = {
    mode: els.mode.value,
    ghostSamples: Number(els.ghost.value) || 0,
    tagOutput: els.tag.checked,
  };
  if (CONFIG.tagName) {
    options.tagName = CONFIG.tagName;
    options.tagComment = CONFIG.tagComment ?? CONFIG.tagName;
    options.handlerName = CONFIG.handlerName ?? `${options.tagComment}-coded`;
  }

  setError(null);
  els.result.hidden = true;
  els.progress.hidden = false;
  stageIndex = -1;
  buildStages();
  setBusy(true);
  setStage("Midiendo el archivo", 0.05);

  try {
    const buffer = new Uint8Array(await file.arrayBuffer());

    setStage("Trazando el patrón", 0.15);
    let converted = null;
    let patched;

    try {
      patched = patchMp4(buffer, options);
    } catch (error) {
      const recoverable =
        error instanceof Mp4Error || error instanceof TypeError || error instanceof RangeError;
      if (!recoverable) throw error;

      setStage("Preparando la tela", 0.2);
      converted = await convertToMp4(file, {
        onStatus: (text) => {
          els.stage.textContent = text;
        },
        onProgress: (ratio) => setStage("Preparando la tela", 0.2 + ratio * 0.55),
      });

      setStage("Cortando el hilo", 0.8);
      patched = patchMp4(converted.bytes, options);
    }

    setStage("Revisando la costura", 0.92);
    const verification = verifyMp4(patched.bytes);

    setStage("Revisando la costura", 1);
    showResult(patched, verification, converted);
  } catch (error) {
    console.error(error);
    setError(error?.message ?? String(error));
    els.progress.hidden = true;
  } finally {
    setBusy(false);
  }
}

function showResult({ bytes, report }, verification, converted) {
  if (state.url) URL.revokeObjectURL(state.url);
  state.url = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));

  const baseName = (state.file?.name ?? "video").replace(/\.[^.]+$/, "") || "video";
  els.download.href = state.url;
  els.download.download = `${baseName}_${CONFIG.suffix}.mp4`;

  const info = verification.info;
  const method =
    converted === null
      ? "parcheo directo (sin recodificar)"
      : `FFmpeg · ${converted.method === "remux" ? "remux" : "recodificado H.264"}`;

  els.rMeta.textContent = `${fmtBytes(bytes.byteLength)} · ${method}`;

  const rows = [
    ["Método", method],
    ["Entrada", fmtBytes(report.inputSize)],
    ["Salida", fmtBytes(report.outputSize)],
    ["Diferencia", fmtDelta(report.sizeDelta)],
    ["Códec", info.codec || "—"],
    ["Resolución", info.width && info.height ? `${Math.round(info.width)}×${Math.round(info.height)}` : "—"],
    ["FPS", info.fps ? info.fps.toFixed(2) : "—"],
    ["Duración", fmtDuration(info.durationSec)],
    ["Chunks verificados", String(verification.chunks)],
  ];
  if (report.ghostSamples) {
    rows.push(["Muestras stts / stsz", `${report.sttsSamples} / ${report.stszSamples}`]);
  }

  els.report.innerHTML = "";
  for (const [label, value] of rows) {
    const div = document.createElement("div");
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = label;
    dd.textContent = value;
    div.append(dt, dd);
    els.report.append(div);
  }

  const changes = [
    "faststart: moov movido antes de mdat (reproducción inmediata al subir).",
    "Timestamps de creación/modificación puestos a cero.",
    "Idioma de las pistas normalizado.",
  ];
  if (report.colorTagged) changes.push("Etiqueta de color BT.709 (primaries/transfer/matrix) añadida.");
  if (report.emptyEdit) changes.push("Edit list vacía de 16 ticks antepuesta (modo compat).");
  if (report.ghostSamples) changes.push(`${report.ghostSamples} muestras fantasma de 8 bytes añadidas (modo compat).`);
  if (report.sampleTableMismatch) {
    changes.push(
      `Tablas descuadradas a propósito: stts declara ${report.sttsSamples} muestras y stsz ${report.stszSamples}. ` +
        "Eso es lo que puede atascar el transcoder de la plataforma y dejar el original.",
    );
  }
  if (els.tag.checked) {
    changes.push(`Firma ${CONFIG.signatureLabel} escrita en udta/meta/ilst (©too, ©cmt, ©cprt).`);
  }
  changes.push("Cajas de procedencia (uuid/C2PA/xml/sdtp) eliminadas del interior de moov.");

  els.changes.innerHTML = "";
  for (const text of changes) {
    const li = document.createElement("li");
    li.textContent = text;
    els.changes.append(li);
  }

  if (!verification.ok) {
    setError(`Aviso de verificación: ${verification.issues.join(" ")}`);
  }

  els.result.hidden = false;
  els.result.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ------------------------------------------------------------------ */
/* eventos                                                             */
/* ------------------------------------------------------------------ */

els.drop.addEventListener("click", () => els.file.click());
els.drop.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    els.file.click();
  }
});

els.file.addEventListener("change", () => {
  const file = els.file.files?.[0];
  if (file) showFile(file);
});

for (const type of ["dragenter", "dragover"]) {
  els.drop.addEventListener(type, (event) => {
    event.preventDefault();
    els.drop.classList.add("is-over");
  });
}
for (const type of ["dragleave", "drop"]) {
  els.drop.addEventListener(type, (event) => {
    event.preventDefault();
    els.drop.classList.remove("is-over");
  });
}
els.drop.addEventListener("drop", (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (file) showFile(file);
});

els.clear.addEventListener("click", clearFile);
els.mode.addEventListener("change", updateMode);
els.run.addEventListener("click", processFile);

updateMode();
