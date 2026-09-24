/** Preguntas de evaluación de la clínica (L–J 9–14 y 16–20; V 9–15; trato de usted). */
import { CLOSED, OPEN, type SectorQuestions } from '../../eval/harness.js';
import { clinic } from '../clinic.js';

export const clinicQuestions: SectorQuestions = {
  fixture: clinic,
  // Jueves 24/09/2026, 12:00 en Madrid.
  at: '2026-09-24T10:00:00Z',
  questions: [
    // Horario
    {
      id: 'cl-horario',
      category: 'horario',
      text: '¿Cuál es su horario?',
      expect: { includes: ['9:00', '14:00', '16:00', '20:00', '15:00'] },
    },
    {
      id: 'cl-viernes',
      category: 'horario',
      text: '¿Hasta qué hora abren los viernes?',
      expect: { includes: ['15:00'] },
    },
    {
      id: 'cl-sabado',
      category: 'horario',
      text: '¿Abren los sábados?',
      expect: { includesAny: [[CLOSED]] },
    },
    // Cierres puntuales
    {
      id: 'cl-nochebuena',
      category: 'cierres',
      text: '¿Qué horario tienen el 24 de diciembre?',
      // Lunes 21/12/2026: Nochebuena dentro de los 14 días; ese día solo de 9 a 14.
      at: '2026-12-21T09:00:00Z',
      expect: { includes: ['9:00', '14:00'], excludes: ['20:00'] },
    },
    {
      id: 'cl-agosto',
      category: 'cierres',
      text: '¿Abren en agosto?',
      at: '2026-07-27T08:00:00Z',
      expect: { includesAny: [['vacaciones', CLOSED]] },
    },
    // Abierto ahora
    {
      id: 'cl-ahora-cerrado',
      category: 'abierto_ahora',
      text: '¿Están abiertos ahora?',
      // Viernes 25/09/2026, 16:00: el viernes cierran a las 15:00.
      at: '2026-09-25T14:00:00Z',
      expect: { includesAny: [[CLOSED]] },
    },
    {
      id: 'cl-ahora-abierto',
      category: 'abierto_ahora',
      text: '¿Están abiertos en este momento?',
      // Lunes 28/09/2026, 11:00.
      at: '2026-09-28T09:00:00Z',
      expect: { includesAny: [[OPEN]] },
    },
    // Ubicación
    {
      id: 'cl-donde',
      category: 'ubicacion',
      text: '¿Dónde están y cómo llego?',
      expect: { includes: ['Constitución 12', 'Puerta Jerez'] },
    },
    // Servicios
    {
      id: 'cl-servicios',
      category: 'servicios',
      text: '¿Qué tratamientos ofrecen?',
      expect: { includes: ['primera visita', 'limpieza', 'empaste', 'ortodoncia'] },
    },
    // FAQ
    {
      id: 'cl-seguros',
      category: 'faq',
      text: '¿Aceptan seguros dentales?',
      expect: { includes: ['aseguradoras'] },
    },
    {
      id: 'cl-ayunas',
      category: 'faq',
      text: '¿Tengo que ir en ayunas?',
      expect: { includesAny: [[/\bno\b/]] },
    },
  ],
};
