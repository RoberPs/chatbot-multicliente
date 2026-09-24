/** Preguntas de evaluación de la peluquería (L y D cerrado; M–V 10–20; S 9–14). */
import { CLOSED, OPEN, type SectorQuestions } from '../../eval/harness.js';
import { hairSalon } from '../hair-salon.js';

export const hairSalonQuestions: SectorQuestions = {
  fixture: hairSalon,
  // Jueves 24/09/2026, 12:00 en Madrid.
  at: '2026-09-24T10:00:00Z',
  questions: [
    // Horario
    {
      id: 'hs-horario',
      category: 'horario',
      text: '¿Qué horario tenéis?',
      expect: { includes: ['10:00', '20:00', '9:00', '14:00'] },
    },
    {
      id: 'hs-lunes',
      category: 'horario',
      text: '¿Abrís los lunes?',
      expect: { includesAny: [[CLOSED]] },
    },
    {
      id: 'hs-sabado',
      category: 'horario',
      text: '¿A qué hora cerráis el sábado?',
      expect: { includes: ['14:00'] },
    },
    {
      id: 'hs-domingo',
      category: 'horario',
      text: '¿Y los domingos abrís?',
      expect: { includesAny: [[CLOSED]] },
    },
    // Cierres puntuales (el martes 22/12/2026 están dentro de los 14 días)
    {
      id: 'hs-navidad',
      category: 'cierres',
      text: '¿Abrís el 25 de diciembre?',
      at: '2026-12-22T09:00:00Z',
      expect: { includesAny: [[CLOSED]] },
    },
    {
      id: 'hs-navidad-dias',
      category: 'cierres',
      text: '¿Qué días cerráis por Navidad?',
      at: '2026-12-22T09:00:00Z',
      expect: { includes: ['25', '26'] },
    },
    // Abierto ahora
    {
      id: 'hs-ahora-abierto',
      category: 'abierto_ahora',
      text: '¿Estáis abiertos ahora?',
      expect: { includesAny: [[OPEN]] },
    },
    {
      id: 'hs-ahora-lunes',
      category: 'abierto_ahora',
      text: '¿Estáis abiertos ahora mismo?',
      // Lunes 28/09/2026, 11:00.
      at: '2026-09-28T09:00:00Z',
      expect: { includesAny: [[CLOSED]] },
    },
    // Ubicación
    {
      id: 'hs-donde',
      category: 'ubicacion',
      text: '¿Dónde estáis?',
      expect: { includes: ['Calle Real 8', 'Valencia'] },
    },
    // Servicios
    {
      id: 'hs-servicios',
      category: 'servicios',
      text: '¿Qué servicios tenéis?',
      expect: {
        includes: ['corte', 'tinte', 'peinado de evento'],
        excludes: ['tratamiento de temporada'],
      },
    },
    // FAQ y políticas
    {
      id: 'hs-cita',
      category: 'faq',
      text: '¿Hace falta pedir cita?',
      expect: { includesAny: [['recomendamos', 'sin cita', 'sin ella', 'hueco']] },
    },
    {
      id: 'hs-bizum',
      category: 'faq',
      text: '¿Puedo pagar con Bizum?',
      expect: { includes: ['bizum'], includesAny: [[OPEN, 'aceptamos', 'puedes']] },
    },
  ],
};
