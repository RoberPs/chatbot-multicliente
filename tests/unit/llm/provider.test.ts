/**
 * El clasificador de formas de credencial (017, R3, regla C4). Lo que se fija aquí es que sea
 * conservador: solo da veredicto ante un prefijo conocido, y el orden de evaluación no deja que una
 * clave de Anthropic pase por una de OpenAI.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyKeyShape,
  ineligibleMessage,
  keyVariableOf,
  LLM_PROVIDERS,
  providerDescriptor,
} from '../../../src/llm/provider.js';

describe('classifyKeyShape', () => {
  it('reconoce la forma de Anthropic', () => {
    expect(classifyKeyShape('sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ')).toBe('anthropic');
  });

  it('reconoce las dos formas de OpenAI', () => {
    expect(classifyKeyShape('sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ')).toBe('openai');
    expect(classifyKeyShape('sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ')).toBe('openai');
  });

  it('reconoce las dos formas de Gemini', () => {
    expect(classifyKeyShape('AIzaABCDEFGHIJKLMNOPQRSTUVWXYZ')).toBe('gemini');
    expect(classifyKeyShape('AQ.ABCDEFGHIJKLMNOPQRSTUVWXYZ')).toBe('gemini');
  });

  it.each([
    ['forma desconocida', 'xyz-ABCDEFGHIJKLMNOPQRSTUVWXYZ'],
    ['vacía', ''],
    ['solo espacios', '   '],
    ['prefijo parecido pero no igual', 'skANT-ABCDEFGHIJKLMNOPQRSTUVWXYZ'],
    ['prefijo de Gemini en minúsculas', 'aizaABCDEFGHIJKLMNOPQRSTUVWXYZ'],
  ])('no da veredicto ante una %s', (_caso, valor) => {
    expect(classifyKeyShape(valor)).toBeNull();
  });

  // La trampa 1 de R3: `sk-ant-` es un subconjunto de `sk-`. Si el orden se invirtiera, toda clave
  // de Anthropic se clasificaría como de OpenAI y la comprobación previa acusaría al entorno
  // correcto de estar equivocado. Este test es el que no deja que eso pase inadvertido.
  it('evalúa sk-ant- antes que sk-: una clave de Anthropic no es de OpenAI', () => {
    expect(classifyKeyShape('sk-ant-api03-xxxx')).toBe('anthropic');
    expect(classifyKeyShape('sk-ant-xxxx')).not.toBe('openai');
  });

  it('ignora los espacios de alrededor', () => {
    expect(classifyKeyShape('  sk-ant-xxxx  ')).toBe('anthropic');
  });
});

describe('tabla de proveedores', () => {
  it('tiene los tres elegibles en orden estable', () => {
    expect(LLM_PROVIDERS).toEqual(['anthropic', 'gemini', 'openai']);
  });

  it('da la variable de credencial de cada uno', () => {
    expect(keyVariableOf('anthropic')).toBe('ANTHROPIC_API_KEY');
    expect(keyVariableOf('gemini')).toBe('GEMINI_API_KEY');
    expect(keyVariableOf('openai')).toBe('OPENAI_API_KEY');
  });

  it('solo Anthropic conserva su modelo por defecto', () => {
    expect(providerDescriptor('anthropic').modelRequired).toBe(false);
    expect(providerDescriptor('gemini').modelRequired).toBe(true);
    expect(providerDescriptor('openai').modelRequired).toBe(true);
  });

  it('cada variable de credencial clasifica a su propio proveedor', () => {
    // Coherencia de la tabla: ningún patrón de un proveedor puede reclamar al de otro.
    expect(classifyKeyShape('sk-ant-x')).toBe('anthropic');
    expect(classifyKeyShape('AIza-x')).toBe('gemini');
    expect(classifyKeyShape('sk-proj-x')).toBe('openai');
  });

  it('el mensaje de proveedor no elegible nombra los tres', () => {
    const message = ineligibleMessage('mistral');
    for (const provider of LLM_PROVIDERS) expect(message).toContain(provider);
    expect(message).toContain('mistral');
  });
});
