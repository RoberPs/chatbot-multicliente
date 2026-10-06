/** Mensajes al negocio de cada derivación, por vía (005, data-model.md § handoff_notice). */
import { and, asc, eq } from 'drizzle-orm';
import { handoff, handoffNotice } from '../../db/schema.js';
import type { DbOrTx } from '../../conversation/repositories/customer.js';
import type { RouteName } from '../types.js';

export type NoticeType = 'alert' | 'reminder' | 'forward';

export interface NewNotice {
  handoffId: string;
  type: NoticeType;
  route: RouteName;
  status: 'sent' | 'failed';
  /** Código corto de fallo; nunca textos del cliente. */
  failure?: string | null;
  providerRef?: string | null;
  messagesCovered?: number | null;
  /** Solo con la vía simulada (playground, FR-021). */
  body?: string | null;
  createdAt: Date;
}

export interface NoticeRow {
  id: string;
  handoffId: string;
  type: NoticeType;
  route: RouteName;
  status: 'sent' | 'failed';
  failure: string | null;
  providerRef: string | null;
  messagesCovered: number | null;
  body: string | null;
  createdAt: Date;
}

export async function insertMany(tx: DbOrTx, notices: NewNotice[]): Promise<void> {
  if (notices.length === 0) return;
  await tx.insert(handoffNotice).values(
    notices.map((n) => ({
      ...n,
      // El texto solo se guarda para la vía simulada (FR-021).
      body: n.route === 'simulated' ? (n.body ?? null) : null,
    })),
  );
}

/** `Message-ID` del aviso por email: hilo del recordatorio y los reenvíos (R7). */
export async function emailThreadRef(tx: DbOrTx, handoffId: string): Promise<string | null> {
  const [row] = await tx
    .select({ ref: handoffNotice.providerRef })
    .from(handoffNotice)
    .where(
      and(
        eq(handoffNotice.handoffId, handoffId),
        eq(handoffNotice.type, 'alert'),
        eq(handoffNotice.route, 'email'),
        eq(handoffNotice.status, 'sent'),
      ),
    )
    .limit(1);
  return row?.ref ?? null;
}

/** Avisos de una derivación en orden (información técnica del playground). */
export async function listForHandoff(tx: DbOrTx, handoffId: string): Promise<NoticeRow[]> {
  return tx
    .select()
    .from(handoffNotice)
    .where(eq(handoffNotice.handoffId, handoffId))
    .orderBy(asc(handoffNotice.createdAt), asc(handoffNotice.id));
}

export interface SimulatedNotice {
  handoffId: string;
  type: NoticeType;
  body: string;
  createdAt: Date;
}

/** Avisos simulados de una conversación (playground, FR-021), en orden. */
export async function listSimulatedForConversation(
  tx: DbOrTx,
  conversationId: string,
): Promise<SimulatedNotice[]> {
  const rows = await tx
    .select({
      handoffId: handoffNotice.handoffId,
      type: handoffNotice.type,
      body: handoffNotice.body,
      createdAt: handoffNotice.createdAt,
    })
    .from(handoffNotice)
    .innerJoin(handoff, eq(handoff.id, handoffNotice.handoffId))
    .where(and(eq(handoff.conversationId, conversationId), eq(handoffNotice.route, 'simulated')))
    .orderBy(asc(handoffNotice.createdAt), asc(handoffNotice.id));
  return rows.map((r) => ({ ...r, body: r.body ?? '' }));
}
