import { describe, expect, it } from 'vitest';
import { foldEnumAdditions, journal } from '../../../src/backup/schema-version.js';

describe('foldEnumAdditions', () => {
  it('integra un ADD VALUE posterior en el CREATE TYPE y quita el ALTER TYPE', () => {
    const result = foldEnumAdditions([
      [`CREATE TYPE "public"."estado" AS ENUM('a', 'b');`, 'CREATE TABLE "t" ("e" "estado");'],
      [`-- comentario\nALTER TYPE "public"."estado" ADD VALUE 'c';`, 'SELECT 1;'],
    ]);
    expect(result).toEqual([
      [`CREATE TYPE "public"."estado" AS ENUM('a', 'b', 'c');`, 'CREATE TABLE "t" ("e" "estado");'],
      ['SELECT 1;'],
    ]);
  });

  it('respeta BEFORE y AFTER, IF NOT EXISTS y nombres sin esquema', () => {
    const [[create] = []] = foldEnumAdditions([
      [`CREATE TYPE "estado" AS ENUM('a', 'c');`],
      [
        `ALTER TYPE "public"."estado" ADD VALUE 'b' BEFORE 'c';`,
        `ALTER TYPE "estado" ADD VALUE 'd' AFTER 'a';`,
        `ALTER TYPE "estado" ADD VALUE IF NOT EXISTS 'a';`,
        `ALTER TYPE "estado" ADD VALUE 'o''k';`,
      ],
    ]);
    expect(create).toBe(`CREATE TYPE "estado" AS ENUM('a', 'd', 'b', 'c', 'o''k');`);
  });

  it('un ADD VALUE de un tipo que no se crea en estas migraciones se deja tal cual', () => {
    const statements = [[`ALTER TYPE "public"."ajeno" ADD VALUE 'x';`]];
    expect(foldEnumAdditions(statements)).toEqual(statements);
  });

  it('con las migraciones del núcleo, message_status nace con forwarded y no queda ningún ADD VALUE', () => {
    const folded = foldEnumAdditions(journal().map((m) => m.sql)).flat();
    expect(folded.some((s) => /ADD VALUE/i.test(s))).toBe(false);
    const create = folded.find((s) => s.includes('"message_status" AS ENUM'));
    expect(create).toContain(
      `AS ENUM('pending', 'answered', 'discarded', 'rate_limited', 'sending', 'sent', 'failed', 'forwarded')`,
    );
  });
});
