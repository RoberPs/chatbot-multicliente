/** Preguntas de evaluación del taller (L–V 8–13:30 y 15–18:30; sin cierres). */
import { CLOSED, OPEN, type SectorQuestions } from '../../eval/harness.js';
import { workshop } from '../workshop.js';

export const workshopQuestions: SectorQuestions = {
  fixture: workshop,
  // Miércoles 23/09/2026, 9:00 en Madrid.
  at: '2026-09-23T07:00:00Z',
  questions: [
    // Horario
    {
      id: 'ws-horario',
      category: 'horario',
      text: '¿Qué horario tenéis?',
      expect: { includes: ['8:00', '13:30', '15:00', '18:30'] },
    },
    {
      id: 'ws-sabado',
      category: 'horario',
      text: '¿Abrís los sábados por la mañana?',
      expect: { includesAny: [[CLOSED]] },
    },
    {
      id: 'ws-mediodia',
      category: 'horario',
      text: '¿Cerráis a mediodía?',
      expect: { includes: ['13:30', '15:00'] },
    },
    // Abierto ahora
    {
      id: 'ws-ahora-abierto',
      category: 'abierto_ahora',
      text: '¿Estáis abiertos ahora?',
      expect: { includesAny: [[OPEN]] },
    },
    {
      id: 'ws-ahora-comida',
      category: 'abierto_ahora',
      text: '¿Estáis abiertos ahora?',
      // Miércoles 23/09/2026, 14:00: pausa del mediodía.
      at: '2026-09-23T12:00:00Z',
      expect: { includesAny: [[CLOSED]] },
    },
    // Ubicación
    {
      id: 'ws-donde',
      category: 'ubicacion',
      text: '¿Dónde está el taller y cómo llego?',
      expect: { includes: ['nave 4', 'salida 12'] },
    },
    // Servicios
    {
      id: 'ws-servicios',
      category: 'servicios',
      text: '¿Qué servicios hacéis?',
      expect: { includes: ['cambio de aceite', 'pre-itv', 'diagnosis', 'chapa'] },
    },
    // FAQ
    {
      id: 'ws-sustitucion',
      category: 'faq',
      text: '¿Tenéis coche de sustitución?',
      expect: { includesAny: [['disponibilidad', 'reserva']] },
    },
    {
      id: 'ws-seguros',
      category: 'faq',
      text: '¿Trabajáis con aseguradoras?',
      expect: { includes: ['mayoria'] },
    },
  ],
};
