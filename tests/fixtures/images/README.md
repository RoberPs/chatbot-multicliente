# Imágenes de prueba (011, research R7)

Las genera `generate.ts` (`pnpm tsx tests/fixtures/images/generate.ts`) y se versionan. Los PNG
se pueden abrir en cualquier visor; los JPEG y WebP solo tienen la estructura que comprueba
`src/webchat/design/images.ts` (marcadores, bloques y dimensiones), no píxeles que se puedan
decodificar.

| Fichero | Para qué |
|---|---|
| `valid.png` | PNG 64×64 con CRC correctos: se acepta |
| `valid.jpg` | JPEG con `SOF0` 64×64, `SOS` (con `FF 00` y un `RST0`) y `EOI`: se acepta |
| `valid.webp` | WebP `VP8L` 64×64: se acepta |
| `valid-vp8x.webp` | WebP con `VP8X` + `VP8L` 64×64: se acepta |
| `metadata.png` | como `valid.png` con `tEXt`, `iTXt`, `eXIf` y `tIME`: se aceptan sin ellos |
| `metadata.jpg` | como `valid.jpg` con `APP1` (EXIF), `APP13` y `COM`: se aceptan sin ellos |
| `metadata.webp` | `VP8X` con bloques `EXIF` y `XMP ` y sus banderas: se aceptan sin ellos y sin las banderas |
| `animated.png` | APNG (`acTL`, `fcTL`, `fdAT`): se acepta y sigue animado |
| `animated.webp` | `VP8X` con `ANIM` y dos `ANMF`: se acepta y sigue animado |
| `svg-renamed.png` | SVG con `<script>` y extensión `.png`: formato no admitido |
| `html-renamed.png` | HTML con extensión `.png`: formato no admitido |
| `exe-renamed.png` | cabecera `MZ` de un ejecutable: formato no admitido |
| `gif.gif` | GIF 1×1: formato no admitido |
| `empty.png` | 0 bytes: dañada o vacía |
| `truncated.png` | la mitad de `valid.png`: dañada |
| `bad-crc.png` | `valid.png` con el CRC de `IHDR` roto: dañada |
| `too-small.png` | PNG 8×8: fuera de las dimensiones (16–1024 px) |
| `too-large-dims.png` | PNG 2000×2000 válido y de pocos bytes: fuera de las dimensiones |
| `too-big.png` | PNG 300×300 válido de más de 256 KB: supera el tamaño |
