import { weekdays, type BusinessFixture } from './types.js';

/** Clínica dental con dos profesionales y una higienista. */
export const clinic: BusinessFixture = {
  sector: 'clínica dental',
  business: {
    name: 'Clínica Dental Sonrisa',
    address: 'Avenida de la Constitución 12, 2º B, Sevilla',
    directions: 'Parada de metro Puerta Jerez, a 2 minutos andando.',
    phone: '954 123 456',
    email: 'citas@clinicasonrisa.example',
    timezone: 'Europe/Madrid',
    currency: 'EUR',
  },
  hours: [
    ...weekdays([1, 2, 3, 4], '09:00', '14:00'),
    ...weekdays([1, 2, 3, 4], '16:00', '20:00'),
    [5, '09:00', '15:00'],
  ],
  closures: [
    { start_date: '2026-08-01', end_date: '2026-08-31', reason: 'Vacaciones de verano' },
    {
      start_date: '2026-12-24',
      end_date: '2026-12-24',
      start_time: '14:00',
      end_time: '20:00',
      reason: 'Nochebuena',
    },
  ],
  services: [
    {
      name: 'Primera visita',
      description: 'Revisión y diagnóstico',
      price_type: 'fixed',
      price: '0',
      duration: '30',
      bookable: 'on',
      active: 'on',
    },
    {
      name: 'Limpieza dental',
      price_type: 'fixed',
      price: '45',
      duration: '45',
      bookable: 'on',
      active: 'on',
    },
    {
      name: 'Empaste',
      price_type: 'from',
      price: '50',
      duration: '40',
      bookable: 'on',
      active: 'on',
    },
    {
      name: 'Ortodoncia',
      description: 'Presupuesto tras estudio',
      price_type: 'on_request',
      bookable: '',
      active: 'on',
    },
  ],
  resources: [
    {
      name: 'Dra. García',
      services: ['Primera visita', 'Empaste'],
      hours: weekdays([1, 2, 3, 4], '09:00', '14:00'),
    },
    {
      name: 'Dr. López',
      services: ['Primera visita', 'Empaste'],
      hours: weekdays([1, 2, 3, 4], '16:00', '20:00'),
      absences: [{ start_date: '2026-10-05', end_date: '2026-10-09' }],
    },
    { name: 'Higienista', services: ['Limpieza dental'], hours: [[5, '09:00', '15:00']] },
  ],
  faqs: [
    {
      question: '¿Aceptáis seguros dentales?',
      answer: 'Trabajamos con las principales aseguradoras; pregúntanos por la tuya.',
    },
    {
      question: '¿Hay que ir en ayunas?',
      answer: 'No, salvo que te lo indiquemos para un tratamiento concreto.',
    },
  ],
  policies: {
    cancellation_text: 'Avísanos con al menos 24 horas para anular o cambiar tu cita.',
    cancellation_notice: '24',
    cancellation_notice_unit: 'hours',
    min_advance: '2',
    min_advance_unit: 'hours',
    max_advance: '60',
    max_advance_unit: 'days',
    payment_methods: ['Efectivo', 'Tarjeta', 'Financiación'],
  },
  tone: { address_form: 'formal', style_description: 'Amable y tranquilizador, sin tecnicismos.' },
  handoff: {
    channels: [
      { type: 'phone', value: '954 123 456' },
      { type: 'email', value: 'recepcion@clinicasonrisa.example' },
    ],
    slots: weekdays([1, 2, 3, 4, 5], '09:00', '14:00'),
  },
};
