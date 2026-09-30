/**
 * Catálogo cerrado de códigos de las herramientas de aprovisionamiento (007,
 * contracts/check-result.md y contracts/instance-commands.md): cada código tiene su mensaje y la
 * acción que lo corrige, en español. Los mensajes solo reciben nombres de variable, ids, rutas,
 * servidor/puerto/nombre/usuario de una base de datos y fechas; nunca un valor secreto (FR-007).
 */

/** Datos que puede llevar un mensaje. Ninguno es un valor de una variable secreta. */
export interface MessageContext {
  variable?: string | null;
  otherInstance?: string;
  otherVariable?: string;
  otherCurrent?: boolean;
  /** Mensaje del esquema del arranque (`env.ts`): textos fijos que solo nombran variables. */
  coreMessage?: string;
  path?: string;
  id?: string;
  other?: string;
  host?: string;
  port?: number;
  name?: string;
  user?: string;
  date?: string;
  reason?: string;
  file?: string;
  step?: string;
  status?: string;
  orphan?: boolean;
  field?: string;
}

interface CatalogEntry {
  /** Mensaje completo (salida `--json` y errores de las órdenes). */
  message: (c: MessageContext) => string;
  /** Texto tras `VARIABLE:` en la salida para personas de `instance:check`. */
  detail?: (c: MessageContext) => string;
  action: (c: MessageContext) => string;
}

const v = (c: MessageContext): string => c.variable ?? '?';
const OPENSSL = 'Genera uno nuevo con openssl rand -hex 32.';

/** Nombre legible de una variable del inventario (las de la BD salen de DATABASE_URL). */
export function variableLabel(variable: string | undefined): string {
  switch (variable) {
    case 'DATABASE':
      return 'la base de datos de DATABASE_URL';
    case 'DATABASE_USER':
      return 'el usuario de DATABASE_URL';
    case 'DATABASE_PASSWORD':
      return 'la contraseña de DATABASE_URL';
    default:
      return variable ?? '?';
  }
}

function sameAs(c: MessageContext): string {
  const previous = c.otherCurrent === false ? ' (valor anterior)' : '';
  return `es igual a ${variableLabel(c.otherVariable)}${previous} de la instancia ${c.otherInstance ?? '?'}.`;
}

const duplicate = (action: (c: MessageContext) => string): CatalogEntry => ({
  message: (c) => `${v(c)} ${sameAs(c)}`,
  detail: sameAs,
  action,
});

// ---------------------------------------------------------------------------
// Resultado de instance:check (contracts/check-result.md)
// ---------------------------------------------------------------------------

export const CHECK_ERROR_CODES = [
  'missing',
  'core_rule',
  'not_production',
  'public_url_not_https',
  'whatsapp_incomplete',
  'smtp_incomplete',
  'llm_key_required',
  'trust_proxy_all',
  'backup_key_equals_session',
  'weak_secret',
  'example_database',
  'secret_reused_within',
  'duplicate_instance_id',
  'duplicate_database',
  'duplicate_database_user',
  'duplicate_public_url',
  'duplicate_whatsapp_phone',
  'duplicate_secret',
  'inventory_key_missing',
  'inventory_key_wrong',
  'inventory_unreadable',
] as const;

export const CHECK_WARNING_CODES = [
  'not_compared',
  'not_registered',
  'pending_optional',
  'shared_smtp',
  'shared_backup_dir',
  'trust_proxy_empty',
  'database_superuser',
  'database_localhost',
  'llm_key_format',
  'weak_argon2_params',
  'retired_instance',
] as const;

export type CheckErrorCode = (typeof CHECK_ERROR_CODES)[number];
export type CheckWarningCode = (typeof CHECK_WARNING_CODES)[number];
export type CheckCode = CheckErrorCode | CheckWarningCode;

const MISSING_ACTIONS: Record<string, string> = {
  INSTANCE_ID: 'Indica el identificador de la instancia (minúsculas, cifras y guiones).',
  BACKUP_DIR: 'Indica la ruta absoluta del volumen de copias (p. ej. /var/lib/chatbot/backups).',
  BACKUP_KEY:
    'Genérala con openssl rand -hex 32 y guárdala en el gestor de secretos, fuera de BACKUP_DIR.',
  SESSION_SECRET: 'Genéralo con openssl rand -hex 32.',
  OPERATOR_PASSWORD_HASH: 'Calcula el hash con pnpm operator:hash-password.',
  DATABASE_URL: 'Crea la base de datos con pnpm instance:db <id>.',
  PUBLIC_BASE_URL: 'Indica la URL pública https de la instancia, sin ruta.',
  EMERGENCY_CONTACT_PHONE: 'Indica un teléfono de emergencia en formato E.164 (+34...).',
  NODE_ENV: 'Indica NODE_ENV=production.',
  ANTHROPIC_API_KEY: 'Añade la clave del modelo de lenguaje de la instancia.',
  STT_API_KEY: 'Añade la clave de la API de transcripción o pon AUDIO_TRANSCRIPTION=off.',
};

const PENDING: Record<string, { message: string; detail?: string; action: string }> = {
  ANTHROPIC_API_KEY: {
    message: 'ANTHROPIC_API_KEY está vacía: la instancia no tendrá bot (solo panel).',
    detail: 'está vacía: la instancia no tendrá bot (solo panel).',
    action: 'Complétala con la clave del modelo de lenguaje de esta instancia.',
  },
  SMTP_URL: {
    message: 'SMTP_URL y SMTP_FROM están vacías: no habrá avisos de derivación por email.',
    action: 'Complétalas si el negocio quiere avisos por email.',
  },
  WHATSAPP_PHONE_NUMBER_ID: {
    message: 'Las variables WHATSAPP_* están vacías: la instancia no tendrá canal de WhatsApp.',
    action: 'Complétalas si el negocio atiende por WhatsApp.',
  },
};

export const CHECK_CATALOG: Record<CheckCode, CatalogEntry> = {
  missing: {
    message: (c) => `Falta ${v(c)}.`,
    detail: () => 'falta.',
    action: (c) => MISSING_ACTIONS[v(c)] ?? `Indica un valor para ${v(c)}.`,
  },
  core_rule: {
    message: (c) => c.coreMessage ?? `${v(c)} no es válida.`,
    action: () => 'Corrige el valor según la regla indicada (la misma que aplica el arranque).',
  },
  not_production: {
    message: () => 'NODE_ENV debe ser production.',
    detail: () => 'debe ser production.',
    action: () => 'Indica NODE_ENV=production.',
  },
  public_url_not_https: {
    message: () => 'PUBLIC_BASE_URL debe ser una URL https pública, sin ruta (no localhost).',
    detail: () => 'debe ser una URL https pública, sin ruta (no localhost).',
    action: () => 'Indica el origen https de la instancia, p. ej. https://chat.ejemplo.com.',
  },
  whatsapp_incomplete: {
    message: (c) => `Falta ${v(c)}: las variables WHATSAPP_* van todas juntas o ninguna.`,
    detail: () => 'falta: las variables WHATSAPP_* van todas juntas o ninguna.',
    action: () => 'Completa todas las variables WHATSAPP_* o déjalas todas vacías.',
  },
  smtp_incomplete: {
    message: (c) => `Falta ${v(c)}: SMTP_URL y SMTP_FROM van juntas.`,
    detail: () => 'falta: SMTP_URL y SMTP_FROM van juntas.',
    action: () => 'Indica las dos o deja las dos vacías.',
  },
  llm_key_required: {
    message: () => 'ANTHROPIC_API_KEY es obligatoria con el canal de WhatsApp.',
    detail: () => 'es obligatoria con el canal de WhatsApp.',
    action: () => 'Añade la clave del modelo de lenguaje de esta instancia.',
  },
  trust_proxy_all: {
    message: () => 'TRUST_PROXY no admite true.',
    detail: () => 'no admite true.',
    action: () => 'Indica el número de saltos (p. ej. 1) o las IP/CIDR del proxy.',
  },
  backup_key_equals_session: {
    message: () => 'BACKUP_KEY es igual a SESSION_SECRET.',
    detail: () => 'es igual a SESSION_SECRET.',
    action: () => 'Genera una BACKUP_KEY nueva con openssl rand -hex 32.',
  },
  weak_secret: {
    message: (c) => `${v(c)} está vacío, es de relleno o es demasiado corto para su tipo.`,
    detail: () => 'está vacío, es de relleno o es demasiado corto para su tipo.',
    action: (c) =>
      c.variable === 'SESSION_SECRET' ||
      c.variable === 'BACKUP_KEY' ||
      c.variable === 'BACKUP_KEYS_PREVIOUS'
        ? OPENSSL
        : c.variable === 'OPERATOR_PASSWORD_HASH'
          ? 'Calcula el hash con pnpm operator:hash-password.'
          : c.variable === 'DATABASE_URL'
            ? 'Usa una contraseña aleatoria de al menos 16 caracteres (pnpm instance:db la genera).'
            : 'Usa el valor real que da el proveedor.',
  },
  example_database: {
    message: () => 'DATABASE_URL es la de .env.example (usuario y contraseña chatbot).',
    detail: () => 'es la de .env.example (usuario y contraseña chatbot).',
    action: () => 'Crea una base de datos propia con pnpm instance:db <id>.',
  },
  secret_reused_within: {
    message: (c) => `${v(c)} es igual a ${variableLabel(c.otherVariable)} del mismo entorno.`,
    detail: (c) => `es igual a ${variableLabel(c.otherVariable)} del mismo entorno.`,
    action: () => 'Cada secreto debe tener un valor propio: genera uno nuevo.',
  },
  duplicate_instance_id: {
    message: (c) =>
      `INSTANCE_ID es el de la instancia ${c.otherInstance ?? '?'}, pero ningún otro valor coincide con ella.`,
    detail: (c) =>
      `es el de la instancia ${c.otherInstance ?? '?'}, pero ningún otro valor coincide con ella.`,
    action: (c) =>
      `Usa un identificador nuevo. Si es la misma instancia tras cambiar todos sus valores, ejecuta pnpm instance:sync ${c.otherInstance ?? '<id>'} <fichero>.`,
  },
  duplicate_database: duplicate(
    () => 'Cada instancia necesita su propia base de datos: pnpm instance:db <id>.',
  ),
  duplicate_database_user: duplicate(
    () => 'Cada instancia necesita su propio usuario de base de datos: pnpm instance:db <id>.',
  ),
  duplicate_public_url: duplicate(() => 'Cada instancia necesita su propia URL pública.'),
  duplicate_whatsapp_phone: duplicate(
    () => 'Cada instancia necesita su propio número de WhatsApp.',
  ),
  duplicate_secret: duplicate((c) =>
    c.variable === 'SESSION_SECRET' || c.variable === 'BACKUP_KEY'
      ? OPENSSL
      : c.variable === 'OPERATOR_PASSWORD_HASH'
        ? 'Genera una contraseña nueva y su hash con pnpm operator:hash-password.'
        : c.variable === 'DATABASE_URL'
          ? 'Crea una base de datos y un usuario propios con pnpm instance:db <id>.'
          : 'Pide al proveedor una credencial propia para esta instancia.',
  ),
  inventory_key_missing: {
    message: (c) => `Hay un inventario en ${c.path ?? '?'} pero falta INSTANCE_INVENTORY_KEY.`,
    action: () =>
      'Cárgala desde tu gestor de secretos. Si la has perdido, crea un inventario nuevo (--inventory <otra ruta>) y vuelve a registrar las instancias con instance:register.',
  },
  inventory_key_wrong: {
    message: () => 'INSTANCE_INVENTORY_KEY no es la clave de este inventario.',
    action: () => 'Carga la clave correcta desde tu gestor de secretos.',
  },
  inventory_unreadable: {
    message: (c) =>
      `No se puede leer el inventario (${c.reason ?? 'formato no válido'}). No se ha modificado.`,
    action: () => 'Revísalo o restaura tu copia.',
  },

  not_compared: {
    message: (c) =>
      `No hay inventario en ${c.path ?? '?'}: solo se ha comprobado la coherencia del entorno.`,
    action: () =>
      'Revisa INSTANCE_INVENTORY o --inventory; si es la primera alta, créalo con instance:new o instance:register.',
  },
  not_registered: {
    message: (c) =>
      `La instancia ${c.id ?? '?'} no está en el inventario (se ha comparado igualmente).`,
    detail: (c) =>
      `la instancia ${c.id ?? '?'} no está en el inventario (se ha comparado igualmente).`,
    action: () => 'Regístrala con pnpm instance:register <fichero> --client <nombre>.',
  },
  pending_optional: {
    message: (c) => PENDING[v(c)]?.message ?? `${v(c)} está vacía.`,
    detail: (c) => PENDING[v(c)]?.detail ?? PENDING[v(c)]?.message ?? 'está vacía.',
    action: (c) => PENDING[v(c)]?.action ?? 'Complétala si hace falta.',
  },
  shared_smtp: {
    message: (c) => `SMTP_URL es igual a la de la instancia ${c.otherInstance ?? '?'}.`,
    detail: (c) => `es igual a la de la instancia ${c.otherInstance ?? '?'}.`,
    action: () => 'Puede ser correcto si es el servidor de avisos del operador; revísalo.',
  },
  shared_backup_dir: {
    message: (c) => `BACKUP_DIR es igual al de la instancia ${c.otherInstance ?? '?'}.`,
    detail: (c) => `es igual al de la instancia ${c.otherInstance ?? '?'}.`,
    action: () =>
      'Las copias no se mezclan, pero borrar ese volumen afectaría a las dos instancias; usa uno propio si puedes.',
  },
  trust_proxy_empty: {
    message: () => 'TRUST_PROXY está vacío: con https suele haber un proxy delante.',
    detail: () => 'está vacío: con https suele haber un proxy delante.',
    action: () => 'Indica el número de saltos (p. ej. 1) si hay un proxy inverso.',
  },
  database_superuser: {
    message: () => 'El usuario de DATABASE_URL es postgres (superusuario).',
    detail: () => 'el usuario es postgres (superusuario).',
    action: () => 'Usa un usuario propio de la instancia: pnpm instance:db <id>.',
  },
  database_localhost: {
    message: () => 'DATABASE_URL apunta a localhost en production.',
    detail: () => 'apunta a localhost en production.',
    action: () => 'Comprueba que es la dirección con la que la instancia ve el servidor.',
  },
  llm_key_format: {
    message: () => 'ANTHROPIC_API_KEY no empieza por sk-ant-.',
    detail: () => 'no empieza por sk-ant-.',
    action: () => 'Comprueba que es una clave de la API del modelo de lenguaje.',
  },
  weak_argon2_params: {
    message: () => 'OPERATOR_PASSWORD_HASH usa parámetros Argon2id por debajo de los mínimos.',
    detail: () => 'usa parámetros Argon2id por debajo de los mínimos.',
    action: () => 'Calcula el hash de nuevo con pnpm operator:hash-password.',
  },
  retired_instance: {
    message: (c) => `La instancia ${c.id ?? '?'} está dada de baja en el inventario.`,
    detail: (c) => `la instancia ${c.id ?? '?'} está dada de baja en el inventario.`,
    action: () => 'No despliegues una instancia dada de baja; da de alta una nueva.',
  },
};

// ---------------------------------------------------------------------------
// Órdenes (contracts/instance-commands.md)
// ---------------------------------------------------------------------------

const COMMAND_CATALOG = {
  usage: { exit: 2, message: (c: MessageContext) => c.reason ?? 'Argumentos no válidos.' },
  unexpected: {
    exit: 2,
    message: () =>
      'Error inesperado. No se muestra su detalle para no exponer secretos; repite la orden y, si se repite, revisa los ficheros.',
  },
  inventory_key_missing: {
    exit: 2,
    message: (c: MessageContext) =>
      `Hay un inventario en ${c.path ?? '?'} pero falta INSTANCE_INVENTORY_KEY. Cárgala desde tu gestor de secretos. Si la has perdido, crea un inventario nuevo (--inventory <otra ruta>) y vuelve a registrar las instancias con instance:register.`,
  },
  inventory_key_wrong: {
    exit: 2,
    message: () => 'INSTANCE_INVENTORY_KEY no es la clave de este inventario.',
  },
  inventory_unreadable: {
    exit: 2,
    message: (c: MessageContext) =>
      `No se puede leer el inventario (${c.reason ?? 'formato no válido'}). No se ha modificado. Revísalo o restaura tu copia.`,
  },
  inventory_busy: {
    exit: 2,
    message: (c: MessageContext) =>
      c.orphan === true
        ? `Otra operación está usando el inventario desde hace más de 10 min: puede ser un bloqueo huérfano. Si no hay otra operación en curso, borra ${c.path ?? '?'}.lock y repite.`
        : 'Otra operación está usando el inventario. Inténtalo de nuevo.',
  },
  inventory_in_repo: {
    exit: 2,
    message: () =>
      'El inventario no puede estar dentro del repositorio del núcleo: contiene nombres de clientes.',
  },
  inventory_missing: {
    exit: 2,
    message: (c: MessageContext) =>
      `No existe un inventario en ${c.path ?? '?'}. Si ya tienes uno, revisa INSTANCE_INVENTORY o --inventory. Si es la primera alta, confirma su creación en la terminal o repite con --create-inventory.`,
  },
  inventory_not_created: {
    exit: 1,
    message: () => 'No se ha creado el inventario. No se ha escrito nada.',
  },
  unknown_instance: {
    exit: 1,
    message: (c: MessageContext) => `No hay ninguna instancia ${c.id ?? '?'} en el inventario.`,
  },
  not_interactive: {
    exit: 2,
    message: () =>
      'Esta orden muestra un secreto una sola vez y necesita una terminal; no redirijas su salida.',
  },
  env_unreadable: {
    exit: 2,
    message: (c: MessageContext) =>
      `No se puede leer el fichero de entorno ${c.path ?? '?'}.${c.reason === 'default' ? ' Indica el fichero con --env <fichero>.' : ''}`,
  },
  write_failed: {
    exit: 1,
    message: (c: MessageContext) => `No se ha podido escribir ${c.path ?? '?'}.`,
  },
  invalid_id: {
    exit: 1,
    message: () =>
      'El identificador (--id) debe tener de 1 a 40 caracteres: minúsculas, cifras y guiones (sin guion al principio ni al final).',
  },
  invalid_client: {
    exit: 1,
    message: () => 'El nombre del cliente (--client) debe tener entre 1 y 120 caracteres.',
  },
  duplicate_instance_id: {
    exit: 1,
    message: (c: MessageContext) =>
      `Ya hay una instancia ${c.id ?? '?'} en el inventario${c.status === 'retired' ? ' (dada de baja)' : ''}; los identificadores no se reutilizan.`,
  },
  invalid_url: {
    exit: 1,
    message: () =>
      'La URL pública (--url) debe ser https://servidor[:puerto], sin ruta y distinta de localhost.',
  },
  duplicate_public_url: {
    exit: 1,
    message: (c: MessageContext) =>
      `La URL pública (--url) ya es la de la instancia ${c.other ?? '?'}.`,
  },
  duplicate_value: {
    exit: 1,
    message: () =>
      'No se ha podido generar un valor que no coincida con el inventario tras 3 intentos. No se ha escrito nada.',
  },
  invalid_timezone: {
    exit: 1,
    message: () =>
      'La zona horaria (--timezone) no es una zona IANA válida (p. ej. Europe/Madrid).',
  },
  invalid_region: {
    exit: 1,
    message: () => 'La región telefónica (--region) debe ser un código de país de 2 letras (ES).',
  },
  invalid_currency: {
    exit: 1,
    message: () => 'La moneda (--currency) debe ser un código ISO 4217 de 3 letras (EUR).',
  },
  invalid_phone: {
    exit: 1,
    message: () =>
      'El teléfono de emergencia (--emergency-phone) no es un número válido en la región indicada.',
  },
  invalid_backup_dir: {
    exit: 1,
    message: () =>
      'El directorio de copias (--backup-dir) debe ser una ruta absoluta POSIX (/var/lib/chatbot/backups).',
  },
  output_exists: {
    exit: 1,
    message: (c: MessageContext) => `Ya existe ${c.path ?? '?'}; indica otra ruta con --out.`,
  },
  output_in_repo: {
    exit: 1,
    message: (c: MessageContext) =>
      `${c.path ?? '?'} está dentro del repositorio y no está excluida del control de versiones.`,
  },
  db_exists: {
    exit: 1,
    message: (c: MessageContext) =>
      `Ya existe una base de datos ${c.name ?? '?'} en el servidor. No se ha modificado nada.`,
  },
  role_exists: {
    exit: 1,
    message: (c: MessageContext) =>
      `Ya existe un usuario ${c.user ?? '?'} en el servidor. No se ha modificado nada.`,
  },
  database_already_registered: {
    exit: 1,
    message: (c: MessageContext) =>
      `La instancia ${c.id ?? '?'} ya tiene base de datos en el inventario; no se crea dos veces.`,
  },
  database_url_set: {
    exit: 1,
    message: (c: MessageContext) =>
      `DATABASE_URL ya tiene valor en ${c.path ?? '?'}; no se sobrescribe.`,
  },
  env_other_instance: {
    exit: 1,
    message: (c: MessageContext) => `El INSTANCE_ID del fichero de entorno no es ${c.id ?? '?'}.`,
  },
  env_invalid_instance: {
    exit: 1,
    message: () => 'El fichero de entorno no tiene un INSTANCE_ID válido.',
  },
  instance_retired: {
    exit: 1,
    message: (c: MessageContext) => `La instancia ${c.id ?? '?'} está dada de baja.`,
  },
  admin_url_required: {
    exit: 2,
    message: () =>
      'Falta INSTANCE_DB_ADMIN_URL y no hay terminal para pedirla. Defínela o usa --print-sql --host <servidor> --port <puerto>.',
  },
  admin_url_invalid: {
    exit: 2,
    message: () => 'La URL de administración no es una URL postgres:// válida.',
  },
  print_sql_needs_host: {
    exit: 2,
    message: () =>
      '--print-sql necesita --host y --port (la dirección con la que la instancia ve el servidor).',
  },
  admin_connect_failed: {
    exit: 1,
    message: (c: MessageContext) =>
      `No se pudo conectar con las credenciales de administración a ${c.host ?? '?'}:${String(c.port ?? '?')}.`,
  },
  permission_denied: {
    exit: 1,
    message: () =>
      'La cuenta de administración no puede crear bases de datos o usuarios. Usa --print-sql y ejecuta las órdenes con una cuenta que pueda.',
  },
  step_failed: {
    exit: 1,
    message: (c: MessageContext) => `Fallo al crear la base de datos (paso: ${c.step ?? '?'}).`,
  },
  probe_failed: {
    exit: 1,
    message: () => 'El usuario nuevo no ha podido conectarse a su base de datos (paso: probe).',
  },
  inventory_not_updated: {
    exit: 1,
    message: (c: MessageContext) =>
      `Base de datos creada y DATABASE_URL escrita en ${c.path ?? '?'}, pero el inventario no se ha actualizado.\nEjecuta: pnpm instance:sync ${c.id ?? '<id>'} ${c.path ?? '<fichero>'}`,
  },
  invalid_transition: {
    exit: 1,
    message: (c: MessageContext) =>
      `No se puede pasar la instancia ${c.id ?? '?'} de «${c.status ?? '?'}» a ese estado${c.field ? ` (${c.field})` : ''}.`,
  },
  invalid_date: {
    exit: 1,
    message: () => 'La fecha debe tener el formato AAAA-MM-DD.',
  },
  looks_like_secret: {
    exit: 1,
    message: (c: MessageContext) =>
      `El texto de ${c.field ?? '?'} parece un secreto o una URL con credenciales; el inventario no guarda secretos.`,
  },
  invalid_report: {
    exit: 1,
    message: () => 'El fichero no es un informe de pnpm db:verify --json.',
  },
  other_instance: {
    exit: 1,
    message: (c: MessageContext) =>
      `La copia ${c.file ?? '?'} es de la instancia ${c.other ?? '?'}.`,
  },
  confirmation_failed: {
    exit: 1,
    message: () => 'Confirmación incorrecta. No se ha modificado nada.',
  },
} satisfies Record<string, { exit: 1 | 2; message: (c: MessageContext) => string }>;

export type CommandCode = keyof typeof COMMAND_CATALOG;

export function commandMessage(code: CommandCode, ctx: MessageContext = {}): string {
  return COMMAND_CATALOG[code].message(ctx);
}

export function commandExitCode(code: CommandCode): 1 | 2 {
  return COMMAND_CATALOG[code].exit;
}

/**
 * Error de las herramientas con un código del catálogo. Su `message` es solo el código: un
 * `pg` o `node:fs` traducido nunca arrastra su texto original (que podría llevar credenciales).
 */
export class ProvisioningError extends Error {
  constructor(
    readonly code: CommandCode,
    readonly ctx: MessageContext = {},
  ) {
    super(code);
    this.name = 'ProvisioningError';
  }
}
