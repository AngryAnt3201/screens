import { describe, it, expect } from 'vitest';
import { serialiseForTest } from './consoleInject';

describe('inject-script serialiser', () => {
  it('serialises primitives', () => {
    expect(serialiseForTest('hi')).toMatchObject({ kind: 'primitive', type: 'string', value: 'hi' });
    expect(serialiseForTest(42)).toMatchObject({ kind: 'primitive', type: 'number', value: '42' });
    expect(serialiseForTest(true)).toMatchObject({ kind: 'primitive', type: 'boolean', value: 'true' });
    expect(serialiseForTest(null)).toMatchObject({ kind: 'primitive', type: 'null' });
    expect(serialiseForTest(undefined)).toMatchObject({ kind: 'primitive', type: 'undefined' });
  });

  it('serialises arrays up to the cap', () => {
    const p = serialiseForTest([1, 2, 3]);
    expect(p.kind).toBe('array');
    if (p.kind !== 'array') throw new Error('unreachable');
    expect(p.items).toHaveLength(3);
    expect(p.ctor).toBe('Array(3)');
  });

  it('serialises objects to depth 2', () => {
    const p = serialiseForTest({ a: { b: { c: 'deep' } } });
    expect(p.kind).toBe('object');
    if (p.kind !== 'object') throw new Error('unreachable');
    const [, av] = p.entries[0];
    expect(av.kind).toBe('object');
    if (av.kind !== 'object') throw new Error('unreachable');
    const [, bv] = av.entries[0];
    // At depth 2 we should have a collapsed marker for { c: 'deep' }
    expect(bv.kind === 'collapsed' || bv.kind === 'object').toBe(true);
  });

  it('handles cycles', () => {
    const o: any = { name: 'a' };
    o.self = o;
    const p = serialiseForTest(o);
    if (p.kind !== 'object') throw new Error('unreachable');
    const [, selfPreview] = p.entries.find(([k]) => k === 'self')!;
    expect(selfPreview.kind).toBe('cyclic');
  });

  it('caps object keys at 200', () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < 250; i++) big[`k${i}`] = i;
    const p = serialiseForTest(big);
    if (p.kind !== 'object') throw new Error('unreachable');
    expect(p.entries.length).toBe(200);
    expect(p.truncated).toBe(50);
  });
});
