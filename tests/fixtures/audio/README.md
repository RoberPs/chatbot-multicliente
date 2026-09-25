# Audios de prueba (SC-009)

Grabaciones para `tests/eval/sc009-audio.test.ts`, que mide la atención de audios con
Whisper real. Solo se usan con `AUDIO_TRANSCRIPTION=on`, que por defecto está apagado.

## Qué hay que grabar

Un fichero `.ogg` (Opus, como las notas de voz de WhatsApp) por cada entrada de
[questions.ts](questions.ts), con el nombre `<id>.ogg`, por ejemplo `hs-audio-1.ogg`.
Cada audio dice en español, con naturalidad, el texto de su pregunta. Son 21 en total.

- Duración máxima: 120 s. Tamaño máximo: 2 MB. Una nota de voz de 5 s ocupa unos 10 KB.
- Voces variadas si es posible (distintas personas, algo de ruido de fondo), porque se mide
  el comportamiento real.
- No uses la voz de clientes reales: son datos personales.

Una forma sencilla: grabar notas de voz en WhatsApp, reenviártelas a ti mismo y exportarlas,
o grabar con cualquier grabadora y convertir con
`ffmpeg -i entrada.m4a -c:a libopus -b:a 24k hs-audio-1.ogg`.

## Cómo se ejecuta

```bash
pnpm test:eval audio     # necesita ANTHROPIC_API_KEY y STT_API_KEY en .env
```

La suite se omite si falta alguna de las dos claves o alguno de los ficheros, e indica cuáles.
