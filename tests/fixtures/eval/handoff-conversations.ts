/**
 * Conversaciones de evaluación de la derivación (005): lo que el cliente escribió, en orden, con
 * la petición de persona al final (SC-003), y peticiones en mitad de otra gestión (SC-001).
 * Solo textos del cliente: es lo único que ve el resumen (R4).
 */
import { clinic } from '../clinic.js';
import { hairSalon } from '../hair-salon.js';
import type { BusinessFixture } from '../types.js';
import { workshop } from '../workshop.js';

export interface HandoffConversation {
  id: string;
  /** Mensajes del cliente, en orden; el último pide la persona. */
  texts: string[];
}

export interface SectorHandoffConversations {
  fixture: BusinessFixture;
  /** Para el resumen (SC-003). */
  conversations: HandoffConversation[];
  /** Peticiones en mitad de otra gestión, que tienen que derivar igual (SC-001). */
  midFlow: string[];
}

export const handoffConversations: SectorHandoffConversations[] = [
  {
    fixture: hairSalon,
    conversations: [
      { id: 'hs-h1', texts: ['¿Cuánto cuesta el tinte?', 'Quiero hablar con una persona'] },
      {
        id: 'hs-h2',
        texts: [
          'Hola, el sábado pasado me hicieron un corte',
          'Me quedó más corto de lo que pedí y quiero que me lo arreglen',
          'Pásame con alguien, por favor',
        ],
      },
      {
        id: 'hs-h3',
        texts: [
          'Tengo una boda el 17 de octubre y somos cuatro personas',
          '¿Podéis hacernos el peinado a las cuatro a las 9:00?',
          'Mejor que me llame alguien al 612 345 678',
        ],
      },
      { id: 'hs-h4', texts: ['Quiero hablar con una persona'] },
    ],
    midFlow: [
      '¿Me reservas un corte para el sábado? Bueno, mejor pásame con alguien',
      '¿Cuánto cuesta el tinte? Da igual, quiero hablar con una persona',
    ],
  },
  {
    fixture: clinic,
    conversations: [
      {
        id: 'cl-h1',
        texts: [
          'Me duele una muela desde hace tres días',
          '¿Me pueden ver hoy? Quiero hablar con alguien de la clínica',
        ],
      },
      {
        id: 'cl-h2',
        texts: [
          'Mi hija lleva ortodoncia con vosotros',
          'Se le ha soltado un bracket',
          '¿Me puede llamar alguien?',
        ],
      },
      {
        id: 'cl-h3',
        texts: ['La factura de la limpieza dental está mal', 'Quiero hablar con un responsable'],
      },
      { id: 'cl-h4', texts: ['No quiero hablar con un bot'] },
    ],
    midFlow: [
      'Quería pedir cita para una limpieza dental, aunque prefiero que me llame una persona',
      '¿Aceptáis tarjeta? Y ponme con alguien, por favor',
    ],
  },
  {
    fixture: workshop,
    conversations: [
      {
        id: 'ws-h1',
        texts: [
          'El coche hace un ruido raro al frenar',
          'Es un monovolumen de 2015',
          'Quiero hablar con el encargado',
        ],
      },
      {
        id: 'ws-h2',
        texts: ['¿Cuánto tardáis en un cambio de aceite?', 'Que me llamen, por favor'],
      },
      {
        id: 'ws-h3',
        texts: [
          'Me cobrasteis 180 € por la diagnosis electrónica y me dijisteis 90 €',
          'Quiero hablar con alguien',
        ],
      },
      { id: 'ws-h4', texts: ['Pásame con una persona real'] },
    ],
    midFlow: [
      '¿Puedo llevar el coche mañana a la pre-ITV? Mejor pásame con alguien',
      'Tengo el testigo del motor encendido y quiero hablar con una persona',
    ],
  },
];
