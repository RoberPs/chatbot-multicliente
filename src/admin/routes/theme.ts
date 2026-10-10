import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { csrfOnPost, isHtmx } from '../auth/plugin.js';
import { safeNext, THEME_CHOICES, themeCookieHeader } from '../theme.js';

const themeForm = z.object({
  theme: z.enum(THEME_CHOICES),
  next: z.string().optional(),
});

/**
 * Elección de tema del panel (014, contracts/admin-theme.md). Se registra en el ámbito `/admin`
 * pero **fuera** del ámbito del operador, para que el control también funcione en la pantalla de
 * acceso (R5). Lo único que hace es poner una cookie: no consulta la base de datos, no lee ni
 * escribe configuración del negocio y no toca la sesión (FR-013).
 */
export async function themeRoutes(app: FastifyInstance): Promise<void> {
  const production = app.env.NODE_ENV === 'production';

  app.post('/theme', { preHandler: csrfOnPost(app) }, async (request, reply) => {
    const form = themeForm.safeParse(request.body);
    if (!form.success) {
      return reply.code(422).type('text/plain; charset=utf-8').send('Tema no válido');
    }
    reply.header('set-cookie', themeCookieHeader(form.data.theme, { production }));
    // Con htmx no hace falta recargar: el atributo lo pone `app.js` al cambiar la opción (R6).
    if (isHtmx(request)) return reply.code(204).send();
    return reply.redirect(safeNext(form.data.next), 303);
  });
}
