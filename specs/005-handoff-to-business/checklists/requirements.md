# Specification Quality Checklist: Derivación de la conversación al negocio

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-28
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- Iteración 1: quedan dos preguntas abiertas que aparecen como marcadores en varios puntos.
  - Q1 (canal del aviso y cómo contesta el negocio): historia 3 (escenario 2), FR-008, FR-014,
    y de ella dependen FR-016 y la hipótesis sobre el panel de chat.
  - Q2 (tiempos de inactividad y de falta de respuesta del negocio): historia 4 (escenario 2),
    casos límite, FR-017 y FR-019.
- FR-008, FR-014, FR-016, FR-017 y FR-019 no son verificables hasta resolverlas.
- Iteración 2 (2026-09-28): resueltas con el usuario y registradas en `## Clarifications`.
  - Q1 → aviso por WhatsApp y por email siempre que ambas vías estén disponibles; el negocio
    contesta por sus medios y confirma o termina desde el aviso (FR-008, FR-008a, FR-014, FR-016).
  - Q2 → vuelta al bot tras 24 h sin mensajes del cliente; recordatorio y contacto directo al
    cliente si no hay confirmación en 2 h de horario de atención (FR-017, FR-019, SC-009).
  - Todos los ítems pasan. Menciones a WhatsApp y email: son vías de aviso elegidas por el
    usuario, no detalles de implementación; el proveedor de email se fija en el plan.
- Items marked incomplete require spec updates before `/speckit-clarify` or `/speckit-plan`
