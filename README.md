# Chisa · taller de hilos

> La piel es de **Chisa** (Kuchiba Chisa, *Wuthering Waves*): uniforme negro,
> cuello hueso, lazo rojo y tijeras de sastre. El motor es el mismo que el de
> Zhezhi; lo que cambia es la firma que queda dentro del MP4: **BlueChisa**.

Utilidad **local** que reescribe el contenedor de un MP4 antes de subirlo a TikTok.
No recodifica si el vídeo ya es H.264/HEVC: trabaja a nivel de átomos (boxes), así
que el vídeo no pierde un solo píxel por el camino.

La metáfora es la de Chisa: todo lo que se sostiene está atado por un hilo. La
plataforma tira de ese hilo para recomprimir y bajar la resolución; este taller lo
corta dejando el contenedor con la misma estructura que el archivo de referencia.

**En línea:** <https://blues-os.github.io/BlueChisa/> ·
**En local:** `.\start.cmd` (puerto 5174, sin conexión y sin backend).

![Interfaz de Chisa: grafito, hueso y rojo, con un patrón de costura](docs/preview.png)

> **Aviso honesto:** el modo corte deja el MP4 inconsistente a propósito. Funciona
> hoy y con el archivo de referencia que se comparó, pero depende de cómo valide
> TikTok ese día: puede quedarse en «procesando» para siempre o ser rechazado. Si
> necesitas publicar con seguridad, usa **Dobladillo limpio**.

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
     el efecto. Es el modo que impide que la plataforma rebaje la resolución.
   - **Dobladillo limpio**: solo normaliza el contenedor, sin descuadrar tablas.
     Úsalo si el vídeo tiene que publicarse sí o sí.
3. Pulsa **Cortar el hilo** y descarga el MP4.

El archivo de salida termina en `_chisa.mp4`.

### Firma en los metadatos

| Campo | Valor |
|---|---|
| Writing application (`©too`) | `BlueChisa-v2.0.3` |
| Copyright (`©cprt`) | `BlueChisa` |
| Comment (`©cmt`) | `BlueChisa` |
| Compressor name (en `stsd`) | `BlueChisa-v2.0.3` |
| Handler de pista (`hdlr`) | `BlueChisa-coded` |

Se puede cambiar con las opciones `tagName` / `tagComment` / `handlerName`, o
desactivar del todo desmarcando «Firmar la salida con el nombre del taller».

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
  └─ verifyMp4()  (moov antes de mdat, offsets dentro del mdat)
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

### Qué hace la plataforma con cada caso (medido con este mismo motor)

| Subida | Resolución | Resultado |
|---|---|---|
| 1080p con sello | 1080×1920 AVC | **archivo original intacto**, sin recomprimir |
| 1080p sin sello (Dobladillo limpio) | 1080×1920 AVC | recomprimido y degradado a **576p** |
| 4K con sello | 2160×3836 HEVC | recomprimido, pero **conserva 2160×3836** a 9,3 Mbps |

Es decir: el corte no siempre evita el reencode. En 1080p sirvió el original tal
cual; en 4K sí transcodificó, pero **mantuvo la resolución** en vez de bajarla. Lo
que el sello parece evitar es el *downscale*, no necesariamente el *transcode*.

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
├─ assets/             favicon SVG + PNG y apple-touch-icon
├─ docs/               captura usada en este README
├─ serve.ps1           servidor estático (HttpListener, sin dependencias)
├─ start.cmd           arranque + abrir navegador
├─ src/
│  ├─ mp4.js           parser, sellador y verificador de MP4
│  ├─ ffmpeg.js        wrapper de FFmpeg.wasm + fallback remux/transcode
│  ├─ app.js           lógica de la UI
│  └─ styles.css       paleta y patrón de costura
├─ vendor/
│  ├─ worker.js        worker de @ffmpeg/ffmpeg 0.12.10 (mismo origen)
│  ├─ const.js
│  └─ errors.js
└─ LICENSE
```

---

## Uso programático

```js
import { inspectMp4, patchMp4, verifyMp4 } from "./src/mp4.js";

const input = new Uint8Array(await file.arrayBuffer());
console.log(inspectMp4(input)); // { codec, width, height, fps, durationSec, ... }

const { bytes, report } = patchMp4(input, { mode: "compat" });
const check = verifyMp4(bytes);
console.log(report, check.ok, check.issues);

const blob = new Blob([bytes], { type: "video/mp4" });
```

Opciones de `patchMp4`:

```js
{
  mode: "compat",                  // por defecto en la UI: corte de hilos
  ghostSamples: 9112,              // solo compat: muestras fantasma declaradas
  emptyEditDuration: 16,           // solo compat: duración del edit vacío
  language: "eng",
  faststart: true,
  tagOutput: true,
  tagName: "BlueChisa-v2.0.3",     // en compat se ajusta solo
  tagComment: "BlueChisa",         // en compat se ajusta solo
  handlerName: "BlueChisa-coded",  // handler de pista en compat
  forceBt709: true,
}
```

---

## Límites

- **Memoria del navegador**: por encima de ~300 MB el procesado local puede
  fallar, sobre todo si hay que pasar por FFmpeg.wasm. El parcheo directo de un
  MP4 grande consume menos, pero sigue cargando el archivo entero en memoria
  (entrada + salida + blob: ~3× el tamaño). Para 4K de más de 500 MB, remuxea
  antes con FFmpeg de escritorio y luego pasa el resultado por el sellador.
- **FFmpeg.wasm single-thread**: es lento (aprox. 2–10× tiempo real según el
  equipo). Para vídeos largos, usa FFmpeg de escritorio y luego el sellador web.
- **Solo la primera pista de vídeo y la primera de audio**.
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
| El vídeo no reproduce tras el corte | usa Dobladillo limpio; las muestras fantasma pueden romper decodificadores estrictos |
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

## Licencia

MIT. Haz lo que quieras con el código, pero sin garantía: el modo corte crea
archivos deliberadamente inconsistentes y la plataforma puede rechazarlos.

No está afiliado a Kuro Games, *Wuthering Waves* ni TikTok. Chisa y *Wuthering
Waves* son propiedad de Kuro Games; este proyecto es un homenaje no oficial.
