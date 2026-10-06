import { weekdays, type BusinessFixture } from './types.js';

/** Peluquería con tres puestos, uno de ellos inactivo. */
export const hairSalon: BusinessFixture = {
  sector: 'peluquería',
  business: {
    name: 'Peluquería Tijeras',
    address: 'Calle Real 8, Valencia',
    directions: '',
    phone: '+34 961 234 567',
    email: '',
    timezone: 'Europe/Madrid',
    currency: 'EUR',
  },
  hours: [...weekdays([2, 3, 4, 5], '10:00', '20:00'), [6, '09:00', '14:00']],
  closures: [{ start_date: '2026-12-25', end_date: '2026-12-26', reason: 'Navidad' }],
  services: [
    {
      name: 'Corte',
      price_type: 'fixed',
      price: '15',
      duration: '30',
      bookable: 'on',
      active: 'on',
    },
    {
      name: 'Tinte',
      price_type: 'from',
      price: '35,50',
      duration: '90',
      bookable: 'on',
      active: 'on',
    },
    {
      name: 'Peinado de evento',
      price_type: 'on_request',
      duration: '60',
      bookable: 'on',
      active: 'on',
    },
    {
      name: 'Tratamiento de temporada',
      price_type: 'fixed',
      price: '25',
      duration: '45',
      bookable: 'on',
      active: '',
    },
  ],
  resources: [
    {
      name: 'Puesto 1',
      services: ['Corte', 'Tinte'],
      hours: weekdays([2, 3, 4, 5], '10:00', '20:00'),
    },
    {
      name: 'Puesto 2',
      services: ['Corte', 'Peinado de evento'],
      hours: [...weekdays([2, 3, 4, 5], '10:00', '14:00'), [6, '09:00', '14:00']],
    },
    { name: 'Puesto 3', services: ['Corte'], active: false, hours: [[6, '09:00', '14:00']] },
  ],
  faqs: [
    {
      question: '¿Hace falta cita?',
      answer: 'Recomendamos pedir cita, aunque atendemos sin ella si hay hueco.',
    },
  ],
  policies: { payment_methods: ['Efectivo', 'Tarjeta', 'Bizum'] },
  tone: { address_form: 'informal', style_description: 'Cercano y con buen humor.' },
  handoff: { channels: [{ type: 'whatsapp', value: '612 345 678' }], slots: [] },
};
