# Chisa · taller de hilos

> La piel es de **Chisa** (Kuchiba Chisa, *Wuthering Waves*): uniforme negro,
> cuello hueso, lazo rojo y tijeras de sastre. El motor es el mismo que el de
> Zhezhi; lo que cambia es la firma que queda dentro del MP4: **BlueChisa**. La
> excepción es la **puntada invisible**, que imita a un mux de FFmpeg y firma
> `Lavf62.3.100` (se puede cambiar).

Utilidad **local** que reescribe el contenedor de un MP4 antes de subirlo a TikTok.
No recodifica si el vídeo ya es H.264/HEVC: trabaja a nivel de átomos (boxes), así
que el vídeo no pierde un solo píxel por el camino.

La metáfora es la de Chisa: todo lo que se sostiene está atado por un hilo. La
plataforma tira de ese hilo para recomprimir y bajar la resolución; este taller lo
corta dejando el contenedor con la misma estructura que el archivo de referencia.

**En línea:** <https://blues-os.github.io/BlueChisa/> ·
**En local:** `.\start.cmd` (puerto 5174, sin conexión y sin backend).

![Interfaz de Chisa: grafito, hueso y rojo, con un patrón de costura](docs/preview.png)

> **Aviso honesto:** los modos de sello (corte de hilos y puntada invisible) alteran
> el contenedor para que la plataforma no rebaje la resolución. El corte lo deja
> **inconsistente a propósito**; la puntada invisible busca el mismo efecto con un
> archivo **válido**. Los dos funcionan hoy y con el archivo de referencia que se
> comparó, pero dependen de cómo valide TikTok ese día. Si necesitas publicar con
> seguridad, usa **Dobladillo limpio**.

---

## Arrancar

Requisitos: Windows con PowerShell y un navegador Chromium/Firefox actualizado.
No hace falta Node, Python ni instalar nada.

```powershell
cd chisa
.\start.cmd
```

o manualmente:

```powershell
.\serve.ps1 -Port 5174
# abre http://localhost:5174
```

Si el puerto está ocupado: `.\serve.ps1 -Port 8080`.

El servidor solo sirve archivos estáticos de esta carpeta; no hay backend y el
vídeo nunca sale del navegador.

> La primera vez que uses un formato que no sea MP4 H.264, FFmpeg.wasm descarga
> ~32 MB desde unpkg. Se cachea en el navegador. Necesitas conexión para esa
> primera conversión; el parcheo directo funciona sin red.

---

## Cómo se usa

1. Arrastra un vídeo (MP4, MOV, MKV, WebM…) a la mesa de corte.
2. Elige modo:
   - **Corte de hilos** (por defecto): aplica el descuadre de tablas que provoca
     el efecto. Es el modo más fiel al archivo de referencia, pero deja el
     contenedor inconsistente a propósito.
   - **Puntada invisible**: busca el mismo efecto **sin romper las tablas**. Añade
     una cola real de silencio AAC, una segunda descripción de muestra, una pista
     de audio clonada y `pasp` 1:1. El archivo resultante es válido.
   - **Dobladillo limpio**: solo normaliza el contenedor, sin trucos. Úsalo si el
     vídeo tiene que publicarse sí o sí.
3. Pulsa **Cortar el hilo** y descarga el MP4.

El archivo de salida termina en `_chisa.mp4`.

### Firma en los metadatos

| Campo | Corte de hilos | Puntada invisible |
|---|---|---|
| Writing application (`©too`) | `BlueChisa-v2.0.3` | `Lavf62.3.100` |
| Copyright (`©cprt`) | `BlueChisa` | `Lavf62.3.100` |
| Comment (`©cmt`) | `BlueChisa` | `Lavf62.3.100` |
| Compressor name (en `stsd`) | `BlueChisa-v2.0.3` | (no se toca) |
| Handler de pista (`hdlr`) | `BlueChisa-coded` | (no se toca) |

Se puede cambiar con las opciones `tagName` / `tagComment` / `handlerName`, o
desactivar del todo desmarcando «Firmar la salida con el nombre del taller». En la
puntada invisible, la firma por defecto es la de un mux de FFmpeg porque el objetivo
es parecer un archivo recién salido de `ffmpeg`; si desmarcas la casilla no se
escribe ningún `udta`.

---

## Qué hace exactamente

### Pipeline

```
archivo
  └─ ¿MP4 convencional con vídeo H.264/HEVC?
       ├─ sí → patchMp4()            (sin pérdida, sin recodificar)
       └─ no → FFmpeg.wasm remux     (copia vídeo, AAC 192k)
                └─ si falla → FFmpeg.wasm transcode (libx264 CRF 20)
                     └─ patchMp4() sobre el resultado
  └─ verifyMp4()  (moov antes de mdat, offsets dentro del mdat y, en puntada
                   invisible, stts == stsz en todas las pistas + firma + 2 pistas)
```

### Dobladillo limpio

| Transformación | Para qué |
|---|---|
| `ftyp` normalizado (`isom/iso2/avc1/mp41`) | compatibilidad de marcas |
| `moov` antes de `mdat` (faststart) | reproducción inmediata al subir |
| timestamps de creación/modificación a 0 | elimina fechas y ruido |
| `mdhd` language = `eng` | metadato de idioma consistente |
| `colr`/`nclx` BT.709 si falta | evita el "lavado" de color en otros móviles |
| elimina `uuid`, `c2pa`, `xml `, `sdtp`, `free` dentro de `moov` | quita procedencia y basura |
| `udta/meta/ilst` propio | firma la salida |

### Corte de hilos

Añade a lo anterior:

- handlers de pista renombrados (`BlueChisa-coded`),
- nombre del compresor en el `stsd` de vídeo (no en el de audio),
- etiquetas `©too` / `©cmt` / `©cprt` con `version/flags = 1` (no estándar),
- edit list vacía de **16 ticks** en vídeo; en audio solo se pone a cero el
  `media_time` (la duración se conserva),
- `stts` partido para separar el último sample,
- **9.112 muestras fantasma** de 8 bytes declaradas en `stsz`,
- **9.112 offsets extra** en `stco`, todos apuntando al mismo byte,
- una entrada extra en `stsc`,
- reescritura completa de offsets (incluido el paso `stco` → `co64` si hace falta).

El resultado queda **descuadrado a propósito**: `stts` declara 1.929 muestras y
`stsz` 11.041; hay 12.968 chunks para 1.928 samples reales, y al final del `mdat`
solo hay **8 bytes** de relleno, no 9.112 × 8. Los navegadores lo reproducen
igual (leen `stts`), pero un transcoder estricto se atasca o rechaza el archivo.

### Puntada invisible

Mismo objetivo que el corte, pero **sin descuadrar ninguna tabla**: `stts` y `stsz`
declaran siempre el mismo número de muestras. La técnica se midió en
**Shore Uploader** (`shoreuploader.com/upload`, build 2026-11) extrayendo su
patcher y comparando los binarios que escribe en el `moov`.

Añade a lo común (faststart, timestamps a cero, `colr`, limpieza, firma):

| Transformación | Detalle |
|---|---|
| Cola real de silencio | **125 B** = 18 frames AAC (23 B de descriptor `Lavc62.11.100` + 17 frames de 6 B) = **0,384 s** a 48 kHz |
| `stsz` de audio | se añaden 18 tamaños reales (`23, 6, 6, …`) |
| `stts` de audio | se **añade** una entrada `[18, 1024]` en vez de sobrescribir la primera (así la suma sigue cuadrando) |
| `stsc` de audio | se reescribe a 2 entradas: `[1, 1, 1]` y `[n−7, 1, 2]` |
| `stsd` de audio | se sustituye por **2 entradas** (107 B + 113 B) con `esds` etiquetado `Lavc62.11.100` |
| `stco` de audio | pasa de offsets por chunk a **un offset por muestra**, más 18 offsets al final del `mdat` |
| `mdhd` / `tkhd` / `elst` de audio | duración ampliada en 0,384 s |
| Pista de audio clonada | `trak` completa con `track_ID` nuevo y `stsd` de **1 entrada** (123 B) |
| `mvhd` | `next_track_ID` incrementado; duración = máx(vídeo, audio) |
| `pasp` de vídeo | `1:1` (16 B) insertado **antes de `btrt`**, como el mux de referencia |
| Firma | `Lavf62.3.100` en `©too` / `©cmt` / `©cprt` |

Las constantes de bytes (cola, `stsd` de 2 entradas, `stsd` de 1 entrada y `pasp`)
están verificadas byte a byte contra el patcher de referencia en
`test/surgical.test.mjs`.

**Cuándo no se aplica.** La cola es un bloque AAC fijo, así que solo encaja si el
audio es `mp4a` con `esds`, **2 canales**, **48 kHz** y `mdhd.timescale = 48000`.
Si no, el modo sigue adelante con el resto (faststart, `pasp`, color, firma) y el
informe indica el motivo. Nunca lanza una excepción por esto.

**Honestidad sobre el truco.** Es una imitación, no una mejora: se sustituye el
`esds` original de la pista de audio por el del descriptor de referencia, y el
`stsc` deja solo los **últimos 8** frames de la cola con la segunda descripción
(el resto usa la primera). Es exactamente lo que hace el patcher original; el
archivo es válido y decodifica, pero no es una obra de ingeniería limpia: es una
huella.

### Las tres costuras, de un vistazo

| | Dobladillo limpio | Corte de hilos | Puntada invisible |
|---|---|---|---|
| `stts` vs `stsz` | cuadran | descuadrados a propósito | **cuadran** |
| `stco` con offsets fantasma | no | 9.112 | no |
| Muestras fantasma | no | 9.112 × 8 B | no |
| Cola de audio real | no | no | **125 B / 0,384 s** |
| Pista de audio clonada | no | no | **sí** |
| `pasp` 1:1 | no | no | **sí** |
| Firma | taller | taller | **`Lavf62.3.100`** |
| Reproduce en navegador | sí | sí (normalmente) | sí |
| Riesgo de «procesando» | bajo | **alto** | medio |

### Verificación

La estructura se comparó contra un archivo de referencia generado a partir del
mismo vídeo de entrada. Con la firma del taller los bytes ya no coinciden (los
textos son distintos), pero todo lo demás sí:

| | Referencia | BlueChisa |
|---|---|---|
| `ftyp:free:moov:mdat` | 32:8:139553:77845775 | **idéntico** |
| `stts` / `stsz` | 1.929 / 11.041 | **idéntico** |
| `stsc` | 3 entradas, última `[1929,1,1]` | **idéntico** |
| `stco` | 1928 + 9112 | **idéntico** |
| `elst` vídeo / audio | `[16,-1]` / `media_time 0` | **idéntico** |
| `mdat` final | 8 bytes de relleno | **idéntico** |
| Firma `udta` | (la del original) | `BlueChisa*` |

También probado con HEVC 4K (`hvc1`, 2160×3836): el parcheo no toca el códec y el
resultado se reproduce y hace *seek* sin problema.

### Verificación automática

Además de la comprobación manual, hay una suite en Node que construye MP4
sintéticos (vídeo `avc1` 1080×1920 + audio `mp4a`/`esds` 48 kHz) y comprueba la
estructura resultante de los tres modos:

```powershell
node test/surgical.test.mjs   # o: npm test
```

Cubre 92 comprobaciones: constantes byte a byte, coherencia `stts`/`stsz` en todas
las pistas, offsets dentro del `mdat`, cola al final del archivo, `pasp` antes de
`btrt`, `next_track_ID`, idioma `und`, degradación segura sin audio o a 44,1 kHz,
`stco` con varios samples por chunk, `elst` ampliado y cabeceras de 64 bits
(`mvhd`/`tkhd`/`mdhd` versión 1). No sustituye a la prueba de reproducción real:
para eso está `test/test.html`.

### Qué hace la plataforma con cada caso (medido con este mismo motor)

| Subida | Resolución | Resultado |
|---|---|---|
| 1080p con sello | 1080×1920 AVC | **archivo original intacto**, sin recomprimir |
| 1080p sin sello (Dobladillo limpio) | 1080×1920 AVC | recomprimido y degradado a **576p** |
| 4K con sello | 2160×3836 HEVC | recomprimido, pero **conserva 2160×3836** a 9,3 Mbps |

Es decir: el corte no siempre evita el reencode. En 1080p sirvió el original tal
cual; en 4K sí transcodificó, pero **mantuvo la resolución** en vez de bajarla. Lo
que el sello parece evitar es el *downscale*, no necesariamente el *transcode*.

> Estas medidas son del **corte de hilos** con su archivo de referencia. Las de la
> **puntada invisible** aún no están medidas por nuestra parte: la técnica se copió
> de Shore Uploader y se ha validado a nivel de contenedor, no subiéndola a la
> plataforma. Si lo pruebas, anota resolución y bitrate de salida.

### Lo que **no** hace

- No cambia resolución, ni fps, ni bitrate (salvo el transcode de emergencia).
- No "mejora" la compresión: hace que la plataforma **no pueda** recomprimir.
- No sube nada a un servidor ni guarda copias.
- No añade HDR ni "4K · 120 fps".

---

## La costurera

Kuchiba Chisa es estudiante de la Academia Startorch. Viste un uniforme marinero
negro con cuello blanco y pañuelo rojo, lleva el pelo negro hasta la cintura y un
lazo rojo en la sien derecha. Su habilidad le permite ver la estructura de lo que
mira y cortar los hilos que sostienen las cosas; su arma son unas tijeras de
sastre enormes con regla.

Este taller toma prestada esa idea: mirar la estructura del MP4 y cortar el hilo
que la plataforma usa para recomprimir. Nada más.

Homenaje no oficial. Chisa y *Wuthering Waves* pertenecen a Kuro Games; este
proyecto no está afiliado al juego ni a TikTok.

---

## Estructura

```
chisa/
├─ index.html          UI (grafito, hueso y rojo)
├─ package.json        solo para `npm test` (type: module)
├─ assets/             favicon SVG + PNG y apple-touch-icon
├─ docs/               captura usada en este README
├─ serve.ps1           servidor estático (HttpListener, sin dependencias)
├─ start.cmd           arranque + abrir navegador
├─ src/
│  ├─ mp4.js           parser, sellador y verificador de MP4 (3 modos)
│  ├─ ffmpeg.js        wrapper de FFmpeg.wasm + fallback remux/transcode
│  ├─ app.js           lógica de la UI
│  └─ styles.css       paleta y patrón de costura
├─ test/
│  ├─ surgical.test.mjs  suite de Node (92 comprobaciones, sin navegador)
│  └─ test.html        prueba con un MP4 real: los 3 modos + reproductor
├─ vendor/
│  ├─ worker.js        worker de @ffmpeg/ffmpeg 0.12.10 (mismo origen)
│  ├─ const.js
│  └─ errors.js
└─ LICENSE
```

Abre `http://localhost:5174/test/test.html`, elige un MP4 y verás el informe de los
tres modos, la verificación y un reproductor para cada uno. Si dejas un
`test/sample.mp4`, se prueba solo al cargar. La muestra no se incluye en el
repositorio (`*.mp4` está ignorado).

---

## Uso programático

```js
import { inspectMp4, patchMp4, verifyMp4 } from "./src/mp4.js";

const input = new Uint8Array(await file.arrayBuffer());
console.log(inspectMp4(input)); // { codec, width, height, fps, durationSec, ... }

const { bytes, report } = patchMp4(input, { mode: "surgical" });

// Verificación específica de la puntada invisible:
const check = verifyMp4(bytes, {
  expectConsistentTables: true,
  tagName: "Lavf62.3.100",
  minAudioTracts: 2,
});
console.log(report, check.ok, check.issues);

const blob = new Blob([bytes], { type: "video/mp4" });
```

Opciones de `patchMp4`:

```js
{
  mode: "compat",                  // "safe" | "compat" | "surgical"
  ghostSamples: 9112,              // solo compat: muestras fantasma declaradas
  emptyEditDuration: 16,           // solo compat: duración del edit vacío
  language: "eng",                 // quirúrgico lo pone en "und" si no se indica
  faststart: true,
  tagOutput: true,
  tagName: "BlueChisa-v2.0.3",     // en compat se ajusta solo
  tagComment: "BlueChisa",         // en compat se ajusta solo
                                   // en quirúrgico: "Lavf62.3.100" por defecto
  handlerName: "BlueChisa-coded",  // handler de pista en compat
  forceBt709: true,
}
```

Opciones de `verifyMp4(input, options)`:

| Opción | Efecto |
|---|---|
| `expectConsistentTables: true` | exige `stts == stsz` en todas las pistas |
| `tagName: "…"` | exige que el texto exista en algún `udta` del `moov` |
| `minAudioTracts: 2` | exige al menos N pistas de audio (`soun`) |

El `report` de `patchMp4` incluye, además de lo común, `paspAdded`,
`audioTrackCloned`, `audioTail` (`{ applied, frames, bytes, seconds, reason }`),
`tablesConsistent`, `trackTables` (por pista), `trackCount`, `movieTimescale`,
`tagName` y `language`.

---

## Límites

- **Memoria del navegador**: por encima de ~300 MB el procesado local puede
  fallar, sobre todo si hay que pasar por FFmpeg.wasm. El parcheo directo de un
  MP4 grande consume menos, pero sigue cargando el archivo entero en memoria
  (entrada + salida + blob: ~3× el tamaño). Para 4K de más de 500 MB, remuxea
  antes con FFmpeg de escritorio y luego pasa el resultado por el sellador.
- **FFmpeg.wasm single-thread**: es lento (aprox. 2–10× tiempo real según el
  equipo). Para vídeos largos, usa FFmpeg de escritorio y luego el sellador web.
- **Solo la primera pista de vídeo y la primera de audio**. La puntada invisible,
  además, solo actúa sobre el audio si es **AAC-LC estéreo a 48 kHz** con `esds`.
- **MP4 fragmentado** (`moof`/`sidx`): se convierte primero con FFmpeg.

### Flujo recomendado para vídeos grandes

```bash
# 1) remux sin pérdida (rápido)
ffmpeg -i entrada.mov -map 0:v:0 -map 0:a:0? -c copy -movflags +faststart salida.mp4

# 2) si el códec no es H.264/HEVC, recodifica con calidad alta
ffmpeg -i entrada.mov -map 0:v:0 -map 0:a:0? ^
  -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p ^
  -color_primaries bt709 -color_trc bt709 -colorspace bt709 ^
  -c:a aac -b:a 256k -movflags +faststart salida.mp4
```

Luego pasa `salida.mp4` por el sellador web para aplicar faststart/color/firma.

---

## Problemas comunes

| Síntoma | Causa / solución |
|---|---|
| "No se pudo cargar FFmpeg.wasm" | sin red o unpkg bloqueado; el parcheo directo sigue funcionando |
| Se queda en "Preparando la tela" | prueba el mirror de jsdelivr (ya incluido) o usa un MP4 H.264 |
| El vídeo no reproduce tras el corte | usa puntada invisible o dobladillo limpio; las muestras fantasma pueden romper decodificadores estrictos |
| La puntada dice "cola de audio omitida" | el audio no es AAC estéreo 48 kHz (`reason` lo indica); el resto del sello sí se aplica |
| La puntada no clona la pista de audio | no había pista `soun`; revisa que el MP4 tenga audio |
| "Chunk offset fuera del mdat" | MP4 atípico; conviértelo primero (el modo automático lo hace) |
| El puerto 5174 está ocupado | `.\serve.ps1 -Port 8080` |

---

## Otras pieles del taller

- **Zhezhi** · papel de jade y tinta: <https://blues-os.github.io/ZhezhiUploader/>
- **Phrolova** · carmesí y lirio de araña:
  <https://blues-os.github.io/ZhezhiUploader/phrolova/>
- **Hilo de subida** · la extensión de navegador que corta el JSON antes de
  publicar: <https://blues-os.github.io/ChisaUploader/>

Las tres pieles comparten motor; cada una firma sus MP4 con su propio nombre. La
extensión es otra cosa: va justo antes de la subida, en el navegador.

---

## Pendiente

- **Medir la puntada invisible en la plataforma.** La técnica está validada a nivel
  de contenedor, no subiéndola. Falta confirmar que evita el *downscale* igual que
  el corte de hilos.
- **`WORKERFS` en `src/ffmpeg.js`.** Hoy el archivo se copia entero a la memoria
  del wasm con `writeFile` (~2× RAM). Montarlo como `WORKERFS` desde el `File`
  evitaría la copia. No se ha hecho porque no se pudo probar sin navegador y sin
  red: fallaría en silencio para todo el flujo de conversión.
- **Audio con otro perfil.** Ampliar la cola a 44,1 kHz y a mono exigiría generar
  los frames en tiempo de ejecución o guardar más binarios.

---

## Licencia

MIT. Haz lo que quieras con el código, pero sin garantía: el corte de hilos crea
archivos deliberadamente inconsistentes y la plataforma puede rechazarlos; la
puntada invisible también es una huella, no una mejora.

No está afiliado a Kuro Games, *Wuthering Waves* ni TikTok. Chisa y *Wuthering
Waves* son propiedad de Kuro Games; este proyecto es un homenaje no oficial.
