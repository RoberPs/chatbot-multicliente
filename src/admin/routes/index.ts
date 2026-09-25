import type { FastifyInstance } from 'fastify';
import { businessRoutes } from './business.js';
import { dashboardRoutes } from './dashboard.js';
import { faqRoutes } from './faqs.js';
import { handoffRoutes } from './handoff.js';
import { hoursRoutes } from './hours.js';
import { partialRoutes } from './partials.js';
import { playgroundRoutes } from './playground.js';
import { policiesRoutes } from './policies.js';
import { resourceRoutes } from './resources.js';
import { serviceRoutes } from './services.js';
import { toneRoutes } from './tone.js';

/** Rutas del panel bajo `/admin`; todas exigen sesión del operador (contracts/admin-panel.md). */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  await app.register(dashboardRoutes);
  await app.register(businessRoutes);
  await app.register(hoursRoutes);
  await app.register(serviceRoutes);
  await app.register(resourceRoutes);
  await app.register(faqRoutes);
  await app.register(policiesRoutes);
  await app.register(toneRoutes);
  await app.register(handoffRoutes);
  await app.register(playgroundRoutes);
  await app.register(partialRoutes);
}
