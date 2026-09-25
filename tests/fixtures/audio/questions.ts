/**
 * Preguntas de audio de SC-009 (research R10): cada una es una grabación de
 * tests/fixtures/audio/<id>.ogg que dice exactamente `text`. Ver README.md.
 */
import { CLOSED, type EvalQuestion, type SectorQuestions } from '../../eval/harness.js';
import { clinicQuestions } from '../eval/clinic.questions.js';
import { hairSalonQuestions } from '../eval/hair-salon.questions.js';
import { workshopQuestions } from '../eval/workshop.questions.js';

const audio = (
  id: string,
  category: string,
  text: string,
  expect: EvalQuestion['expect'],
): EvalQuestion => ({
  id,
  category,
  criterion: 'SC-009',
  text,
  media: { type: 'audio', file: `${id}.ogg` },
  expect,
});

export const audioQuestions: SectorQuestions[] = [
  {
    ...hairSalonQuestions,
    questions: [
      audio('hs-audio-1', 'horario', '¿Qué horario tenéis?', { includes: ['10:00', '20:00'] }),
      audio('hs-audio-2', 'horario', '¿Abrís los lunes?', { includesAny: [[CLOSED]] }),
      audio('hs-audio-3', 'horario', '¿A qué hora cerráis el sábado?', { includes: ['14:00'] }),
      audio('hs-audio-4', 'ubicacion', '¿Dónde estáis?', { includes: ['calle real 8'] }),
      audio('hs-audio-5', 'precios', '¿Cuánto cuesta un corte?', { includes: ['15'] }),
      audio('hs-audio-6', 'precios', '¿Qué precio tiene el tinte?', {
        includes: ['desde', '35,50'],
      }),
      audio('hs-audio-7', 'faq', '¿Puedo pagar con Bizum?', { includes: ['bizum'] }),
    ],
  },
  {
    ...clinicQuestions,
    questions: [
      audio('cl-audio-1', 'horario', '¿Hasta qué hora abren los viernes?', { includes: ['15:00'] }),
      audio('cl-audio-2', 'horario', '¿Abren los sábados?', { includesAny: [[CLOSED]] }),
      audio('cl-audio-3', 'ubicacion', '¿Dónde está la clínica?', {
        includes: ['constitucion 12'],
      }),
      audio('cl-audio-4', 'precios', '¿Cuánto cuesta una limpieza dental?', { includes: ['45'] }),
      audio('cl-audio-5', 'precios', '¿Qué precio tiene un empaste?', {
        includes: ['desde', '50'],
      }),
      audio('cl-audio-6', 'servicios', '¿Qué tratamientos hacen?', {
        includes: ['limpieza', 'empaste'],
      }),
      audio('cl-audio-7', 'faq', '¿Aceptan seguros dentales?', { includes: ['aseguradoras'] }),
    ],
  },
  {
    ...workshopQuestions,
    questions: [
      audio('ws-audio-1', 'horario', '¿Qué horario tenéis?', { includes: ['8:00', '18:30'] }),
      audio('ws-audio-2', 'horario', '¿Cerráis a mediodía?', { includes: ['13:30', '15:00'] }),
      audio('ws-audio-3', 'horario', '¿Abrís los sábados?', { includesAny: [[CLOSED]] }),
      audio('ws-audio-4', 'ubicacion', '¿Dónde está el taller?', { includes: ['nave 4'] }),
      audio('ws-audio-5', 'precios', '¿Cuánto cuesta la pre-ITV?', { includes: ['35'] }),
      audio('ws-audio-6', 'precios', '¿Cuánto vale cambiar el aceite?', {
        includes: ['desde', '59,90'],
      }),
      audio('ws-audio-7', 'faq', '¿Trabajáis con aseguradoras?', { includes: ['mayoria'] }),
    ],
  },
];
