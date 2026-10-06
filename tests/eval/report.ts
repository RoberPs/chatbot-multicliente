/** Resultados de la suite `eval` por criterio de éxito y tabla final (quickstart.md). */

interface Row {
  criterion: string;
  category: string;
  total: number;
  ok: number;
  failures: string[];
}

const rows = new Map<string, Row>();
const latencies: number[] = [];

export function record(criterion: string, category: string, ok: boolean, failure?: string): void {
  const key = `${criterion}|${category}`;
  const row = rows.get(key) ?? { criterion, category, total: 0, ok: 0, failures: [] };
  row.total += 1;
  if (ok) row.ok += 1;
  else if (failure) row.failures.push(failure);
  rows.set(key, row);
}

export function recordLatency(ms: number): void {
  latencies.push(ms);
}

export function p95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? null;
}

const pct = (ok: number, total: number) =>
  total === 0 ? '—' : `${Math.round((ok / total) * 100)} %`;

export function printReport(title: string): void {
  if (rows.size === 0 && latencies.length === 0) return;
  const lines = [`\n=== ${title} ===`, 'Criterio | Categoría | Correctas | %'];
  const totals = new Map<string, { ok: number; total: number }>();
  for (const row of rows.values()) {
    lines.push(
      `${row.criterion} | ${row.category} | ${row.ok}/${row.total} | ${pct(row.ok, row.total)}`,
    );
    const total = totals.get(row.criterion) ?? { ok: 0, total: 0 };
    total.ok += row.ok;
    total.total += row.total;
    totals.set(row.criterion, total);
  }
  for (const [criterion, total] of totals) {
    lines.push(`${criterion} | TOTAL | ${total.ok}/${total.total} | ${pct(total.ok, total.total)}`);
  }
  const latency = p95(latencies);
  if (latency !== null) {
    lines.push(
      `SC-003 | p95 latencyMs (${latencies.length} respuestas) | ${latency} ms | ` +
        `${latency < 10_000 ? 'cumple' : 'NO cumple'} (< 10 000 ms)`,
    );
  }
  const failures = [...rows.values()].flatMap((r) => r.failures);
  if (failures.length > 0) lines.push('', 'Fallos:', ...failures.map((f) => `- ${f}`));
  console.log(lines.join('\n'));
}
