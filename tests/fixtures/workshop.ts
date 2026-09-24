import { weekdays, type BusinessFixture } from './types.js';

/** Taller mecánico sin recursos (agenda única) y sin contacto de derivación propio. */
export const workshop: BusinessFixture = {
  sector: 'taller mecánico',
  business: {
    name: 'Taller Motor Rápido',
    address: 'Polígono Industrial Norte, nave 4, Zaragoza',
    directions: 'Salida 12 de la autovía, segunda calle a la derecha.',
    phone: '976 555 010',
    email: 'taller@motorrapido.example',
    timezone: 'Europe/Madrid',
    currency: 'EUR',
  },
  hours: [
    ...weekdays([1, 2, 3, 4, 5], '08:00', '13:30'),
    ...weekdays([1, 2, 3, 4, 5], '15:00', '18:30'),
  ],
  closures: [],
  services: [
    {
      name: 'Cambio de aceite',
      price_type: 'from',
      price: '59,90',
      duration: '45',
      bookable: 'on',
      active: 'on',
    },
    {
      name: 'Pre-ITV',
      price_type: 'fixed',
      price: '35',
      duration: '60',
      bookable: 'on',
      active: 'on',
    },
    {
      name: 'Diagnosis electrónica',
      price_type: 'fixed',
      price: '',
      duration: '30',
      bookable: 'on',
      active: 'on',
    },
    { name: 'Reparación de chapa', price_type: 'on_request', bookable: '', active: 'on' },
  ],
  resources: [],
  faqs: [
    {
      question: '¿Tenéis vehículo de sustitución?',
      answer: 'Sí, bajo disponibilidad y con reserva previa.',
    },
    { question: '¿Trabajáis con aseguradoras?', answer: 'Sí, con la mayoría.' },
  ],
  policies: {
    min_advance: '1',
    min_advance_unit: 'days',
    max_advance: '30',
    max_advance_unit: 'days',
    payment_methods: ['Tarjeta', 'Transferencia'],
  },
  tone: { address_form: 'informal', style_description: '' },
  handoff: { channels: [], slots: [] },
};
