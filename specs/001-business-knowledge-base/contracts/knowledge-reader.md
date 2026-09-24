# Contrato: puerto de lectura del bot (`KnowledgeReader`)

**Feature**: `001-business-knowledge-base` | Fuente: FR-011b, FR-013, FR-014a, FR-019 – FR-021, FR-029

Interfaz interna del núcleo por la que el bot (y las specs de conversación, disponibilidad y
citas) obtiene la información del negocio. Es el **único** acceso del bot a estos datos:
ningún módulo conversacional consulta las tablas directamente.

## Interfaz

```ts
interface KnowledgeReader {
  /** Lee de la BD en cada llamada; sin caché (FR-021). */
  getSnapshot(): Promise<KnowledgeSnapshot>;
}
```

Garantías:

1. **Frescura**: el snapshot refleja todo cambio confirmado antes de la llamada. El bot debe
   llamarlo al generar cada respuesta, también en conversaciones ya abiertas, y no guardar
   copias entre turnos (FR-021, SC-003).
2. **Solo lo activo**: servicios y recursos inactivos no aparecen, ni tampoco sus asociaciones
   (FR-011b).
3. **Coherencia**: el snapshot se lee en una única transacción de solo lectura
   (`REPEATABLE READ`), así nunca mezcla estados de dos guardados distintos.
4. **Sin datos inventados**: los campos ausentes son `null` o listas vacías; el snapshot nunca
   rellena valores por defecto que el operador no haya registrado, salvo el contacto de
   derivación efectivo de FR-019, marcado con `source`.
5. **Aislamiento**: solo contiene datos de la instancia actual (BD propia, FR-022).

## Forma

```ts
type ISODate = string;      // "2026-12-25"
type LocalTime = string;    // "09:00"
type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7; // ISO, 1 = lunes

interface WeeklySlot { weekday: Weekday; start: LocalTime; end: LocalTime }

interface DateRangeBlock {
  startDate: ISODate;
  endDate: ISODate;                           // inclusiva
  startTime: LocalTime | null;                // null = día completo
  endTime: LocalTime | null;
  reason: string | null;                      // solo en cierres
}

interface KnowledgeSnapshot {
  status: "draft" | "active";                 // el bot atiende solo si "active" (FR-029)
  business: {
    name: string;
    address: string | null;
    directions: string | null;
    phone: string | null;                     // E.164
    email: string | null;
    timezone: string;                         // IANA
    currency: string;                         // ISO 4217
  };
  openingHours: WeeklySlot[];                 // vacío = sin horario registrado
  closures: DateRangeBlock[];                 // prevalecen sobre openingHours (FR-005)

  services: Array<{
    id: string;
    name: string;
    description: string | null;
    price:
      | { type: "fixed"; amountCents: number }
      | { type: "from"; amountCents: number }
      | { type: "on_request" }                // el bot no da ninguna cifra
      | { type: "missing" };                  // fijo/"desde" sin importe: el bot no da cifra
    durationMinutes: number | null;
    bookable: boolean;                        // reservable efectivo (FR-009, FR-013)
    resourceIds: string[];                    // recursos activos que lo prestan
  }>;

  scheduling:
    | { mode: "single_agenda" }               // sin recursos registrados (FR-013)
    | { mode: "resources"; resources: Array<{
        id: string;
        name: string;
        serviceIds: string[];                 // solo servicios activos asignados (FR-011)
        hours: WeeklySlot[];
        absences: DateRangeBlock[];           // prevalecen sobre hours (FR-012)
      }> };

  faqs: Array<{ question: string; answer: string }>; // subordinadas a los datos estructurados (FR-014a)

  policies: {
    cancellationText: string | null;
    cancellationNoticeMinutes: number | null;
    minAdvanceMinutes: number | null;
    maxAdvanceMinutes: number | null;
    paymentMethods: string[];
  };

  tone: {
    addressForm: "informal" | "formal" | null;  // tú / usted
    styleDescription: string | null;
  };

  handoff: {
    source: "configured" | "business_phone" | "none"; // FR-019
    channels: Array<{ type: "phone" | "whatsapp" | "email"; value: string }>;
    hours: WeeklySlot[];                      // vacío = no indicado
  };

  updatedAt: string;                          // máximo updated_at, ISO 8601
}
```

Notas:

- `price.type = "missing"` separa "el operador no ha registrado el importe" de "a consultar"
  para que las specs de conversación puedan aplicar el Principio IV (decir que no hay dato y
  ofrecer contacto) sin reinterpretar reglas.
- `bookable` ya aplica todas las reglas: activo, marcado reservable, con duración y, si hay
  recursos, con al menos un recurso activo que lo presta.
- `scheduling.mode = "resources"` aunque todos los recursos estén inactivos (lista vacía): el
  negocio no pasa a agenda única en ese caso (edge case de la spec).
- En `status = "active"`, `handoff.source` nunca es `"none"` (FR-031, FR-032): el Principio V
  siempre tiene un medio al que derivar.
- Los consumidores del snapshot (specs de conversación y citas) MUST comprobar
  `status === "active"` antes de atender a un cliente final (FR-029). Esta feature solo expone
  el estado; la regla se aplica y se prueba en la spec de conversación.

## Funciones puras auxiliares (entregadas en esta feature)

```ts
/** Intervalos de apertura efectivos de un día, tras aplicar cierres (unión de solapes). */
effectiveIntervals(slots: WeeklySlot[], blocks: DateRangeBlock[], date: ISODate): Array<{ start: LocalTime; end: LocalTime }>;

/** ¿Está abierto en esa fecha y hora local? */
isOpenAt(slots: WeeklySlot[], blocks: DateRangeBlock[], date: ISODate, time: LocalTime): boolean;
```

Se aplican igual al negocio (`openingHours` + `closures`) y a cada recurso (`hours` +
`absences`). El cálculo de huecos para citas queda para la spec de disponibilidad.
