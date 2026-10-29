/**
 * ffmpeg.js — envoltorio mínimo de FFmpeg.wasm (single-thread).
 *
 * Solo se usa cuando el MP4 no se puede parchear directamente:
 *   - el contenedor no es MP4 convencional (MOV, MKV, WebM, fragmentado…)
 *   - el códec de vídeo no es H.264/HEVC
 *
 * El core se descarga de unpkg (~32 MB la primera vez) y se queda en caché
 * del navegador. No se sube nada a ningún servidor.
 */

const FFMPEG_PKG = "https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js";
const UTIL_PKG = "https://unpkg.com/@ffmpeg/util@0.12.2/dist/esm/index.js";
// worker.js importa ./const.js y ./errors.js: debe servirse desde el mismo origen.
const CLASS_WORKER_URL = new URL("../vendor/worker.js", import.meta.url).href;
const CORE_MIRRORS = [
  "https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm",
  "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm",
];

let instance = null;
let loadingPromise = null;

export function resetFFmpeg() {
  instance = null;
  loadingPromise = null;
}

async function loadFFmpeg(onStatus = () => {}) {
  if (instance) return instance;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    onStatus("Cargando FFmpeg.wasm (solo la primera vez)");
    const [{ FFmpeg }, { toBlobURL }] = await Promise.all([import(FFMPEG_PKG), import(UTIL_PKG)]);

    let lastError = null;
    for (const base of CORE_MIRRORS) {
      const ffmpeg = new FFmpeg();
      try {
        onStatus(`Descargando motor desde ${new URL(base).host}`);
        // El worker se sirve desde el propio proyecto para evitar restricciones
        // de origen (los module workers no cargan scripts de otro dominio).
        const [coreURL, wasmURL] = await Promise.all([
          toBlobURL(`${base}/ffmpeg-core.js`, "text/javascript"),
          toBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm"),
        ]);
        await ffmpeg.load({ coreURL, wasmURL, classWorkerURL: CLASS_WORKER_URL });
        instance = ffmpeg;
        return ffmpeg;
      } catch (error) {
        lastError = error;
        try {
          ffmpeg.terminate();
        } catch {
          /* ignorar */
        }
      }
    }

    throw new Error(
      `No se pudo cargar FFmpeg.wasm (${lastError?.message ?? "error de red"}). ` +
        "Comprueba tu conexión o usa un MP4 H.264 para evitar la conversión.",
    );
  })();

  try {
    return await loadingPromise;
  } finally {
    loadingPromise = null;
  }
}

function extensionOf(name) {
  const match = /\.[a-z0-9]+$/i.exec(name);
  return match ? match[0].toLowerCase() : ".mp4";
}

/**
 * Convierte cualquier vídeo a MP4 con el vídeo en H.264 (o copia si ya lo es).
 * @returns {Promise<{bytes: Uint8Array, method: "remux"|"transcode"}>}
 */
export async function convertToMp4(file, { onStatus = () => {}, onProgress = () => {} } = {}) {
  const ffmpeg = await loadFFmpeg(onStatus);
  const input = `input${extensionOf(file.name)}`;
  const output = "output.mp4";

  const onTick = ({ progress }) => {
    if (Number.isFinite(progress)) onProgress(Math.min(1, Math.max(0, progress)));
  };
  ffmpeg.on("progress", onTick);

  try {
    onStatus("Escribiendo el archivo en el sistema de FFmpeg");
    await ffmpeg.writeFile(input, new Uint8Array(await file.arrayBuffer()));

    const common = [
      "-i", input,
      "-map", "0:v:0",
      "-map", "0:a:0?",
      "-movflags", "+faststart",
      "-y",
    ];

    const audio = ["-c:a", "aac", "-b:a", "192k"];

    onStatus("Remuxeando (sin recodificar vídeo)");
    let code = await ffmpeg.exec([...common, "-c:v", "copy", ...audio, output]);

    let method = "remux";
    if (code !== 0) {
      method = "transcode";
      onProgress(0);
      onStatus("Recodificando a H.264 (CRF 20)");
      const transcode = [
        ...common,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-fpsmax", "120",
        "-color_primaries", "bt709",
        "-color_trc", "bt709",
        "-colorspace", "bt709",
        ...audio,
        output,
      ];
      code = await ffmpeg.exec(transcode);
      if (code !== 0) {
        // Reintento sin -fpsmax por si el core es antiguo.
        code = await ffmpeg.exec(transcode.filter((arg, i) => arg !== "-fpsmax" && transcode[i - 1] !== "-fpsmax"));
      }
    }

    if (code !== 0) throw new Error(`FFmpeg terminó con código ${code}.`);

    const data = await ffmpeg.readFile(output);
    if (!data?.byteLength) throw new Error("FFmpeg produjo un archivo vacío.");

    return { bytes: data instanceof Uint8Array ? data : new Uint8Array(data), method };
  } finally {
    ffmpeg.off("progress", onTick);
    await ffmpeg.deleteFile(input).catch(() => {});
    await ffmpeg.deleteFile(output).catch(() => {});
  }
}
