/**
 * Quejas y comentarios negativos de evaluación (005, SC-006). Las quejas reclaman algo al
 * negocio o a un servicio recibido y se tienen que derivar sin intentar resolverlas; los
 * comentarios negativos no reclaman nada y se atienden con normalidad.
 */
import { clinic } from '../clinic.js';
import { hairSalon } from '../hair-salon.js';
import type { BusinessFixture } from '../types.js';
import { workshop } from '../workshop.js';

export interface SectorComplaints {
  fixture: BusinessFixture;
  complaints: string[];
  negativeComments: string[];
}

export const sectorComplaints: SectorComplaints[] = [
  {
    fixture: hairSalon,
    complaints: [
      'Quiero poner una reclamación, el trabajo me lo hicieron mal',
      'El tinte que me pusisteis ayer se me ha ido en dos lavados, esto no puede ser',
      'Me cortasteis mucho más de lo que pedí y estoy muy disgustada',
      'Tenía cita a las 11 y me tuvisteis esperando una hora, quiero quejarme',
      'Me cobrasteis el doble de lo que ponía en el precio',
      'La peluquera fue muy borde conmigo, quiero que lo sepa el dueño',
      'Me quemasteis el cuero cabelludo con el alisado, exijo una solución',
    ],
    negativeComments: [
      'Qué caro el tinte, ¿no?',
      'Vaya horario más corto tenéis',
      'Uf, qué pena que no abráis los lunes. ¿Y el sábado?',
      'No me gusta mucho pedir cita, ¿se puede ir sin ella?',
      'Qué rollo tener que esperar, ¿cuánto dura un corte?',
    ],
  },
  {
    fixture: clinic,
    complaints: [
      'Quiero poner una queja: después del empaste me sigue doliendo muchísimo',
      'Me hicieron una limpieza y me dejaron la encía sangrando, esto es una vergüenza',
      'Me cobraron una primera visita que me dijeron que era gratis',
      'Llevo dos semanas esperando que me llamen con los resultados y nadie lo hace',
      'La recepcionista me trató fatal por teléfono, quiero reclamar',
      'Me cancelaron la cita el mismo día sin avisar, quiero una explicación',
      'El empaste se me cayó a los tres días, exijo que me lo arreglen',
    ],
    negativeComments: [
      'Qué caro es el dentista, madre mía. ¿Cuánto cuesta una limpieza?',
      'Me dan pánico los dentistas, ¿la limpieza duele?',
      'Vaya, qué lejos estáis. ¿Dónde está exactamente la clínica?',
      'Qué pocas horas abrís por la tarde',
      'Odio ir al dentista, pero bueno, ¿abrís el viernes?',
    ],
  },
  {
    fixture: workshop,
    complaints: [
      'Recogí el coche ayer y sigue haciendo el mismo ruido, quiero reclamar',
      'Me cobrasteis piezas que no me cambiasteis, esto es un timo',
      'Me devolvisteis el coche con un arañazo en la puerta',
      'Me dijisteis que estaría el martes y aún no está, quiero poner una queja',
      'Después del cambio de aceite pierde aceite por debajo, exijo que lo arregléis',
      'El mecánico me habló fatal cuando fui a recoger el coche',
      'Me cobrasteis la diagnosis dos veces, quiero que me devolváis el dinero',
    ],
    negativeComments: [
      'Qué caro está todo en los talleres. ¿Cuánto cuesta un cambio de aceite?',
      'Vaya horario, ¿no abrís los sábados?',
      'Uf, odio llevar el coche al taller. ¿Hay que pedir cita?',
      'Qué rollo, se me ha encendido una luz del motor otra vez',
      'Qué lata tener que dejar el coche todo el día, ¿cuánto se tarda en una revisión?',
    ],
  },
];
