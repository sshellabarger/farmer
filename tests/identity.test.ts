// Producer identity resolution (SPEC §7.9, Phase 2 contract §6). Every name
// and address below is invented for the test — never a real survey row.
import { describe, it, expect } from 'vitest';
import {
  normalizeEmail,
  emailDomain,
  nameKey,
  looksLikeBusiness,
  chooseCanonicalName,
  UnionFind,
  resolveProducerIdentity,
} from '../src/services/identity.js';

describe('normalizeEmail', () => {
  it('lower-cases and trims', () => {
    expect(normalizeEmail('  Hello@Testfield.Example  ')).toBe('hello@testfield.example');
  });

  it('unwraps "Name <addr>"', () => {
    expect(normalizeEmail('Terry Testfield <terry@testfield.example>')).toBe('terry@testfield.example');
  });

  it('strips a mailto: prefix', () => {
    expect(normalizeEmail('mailto:hello@testfield.example')).toBe('hello@testfield.example');
  });

  it('drops embedded whitespace', () => {
    expect(normalizeEmail('hello @ testfield . example')).toBe('hello@testfield.example');
  });

  it('returns null for a non-email', () => {
    expect(normalizeEmail('not an email')).toBeNull();
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
  });
});

describe('emailDomain', () => {
  it('returns the domain of a valid email', () => {
    expect(emailDomain('hello@testfield.example')).toBe('testfield.example');
  });

  it('returns null for a non-email', () => {
    expect(emailDomain('nope')).toBeNull();
    expect(emailDomain(null)).toBeNull();
  });
});

describe('nameKey', () => {
  it('picks the first significant word', () => {
    expect(nameKey('The Testfield Farm')).toBe('testfield');
    expect(nameKey("Sarah's Sweets")).toBe('sarah');
    expect(nameKey('Sarah Sample')).toBe('sarah');
    expect(nameKey('J & J Produce')).toBe('produce');
    expect(nameKey('Émile Gâteaux')).toBe('emile');
    expect(nameKey('')).toBe('');
  });
});

describe('looksLikeBusiness', () => {
  it('flags names containing a business word', () => {
    expect(looksLikeBusiness('Testfield Farm')).toBe(true);
    expect(looksLikeBusiness('Ridgeline Orchard')).toBe(true);
    expect(looksLikeBusiness('Terry Testfield')).toBe(false);
    expect(looksLikeBusiness('')).toBe(false);
  });
});

describe('chooseCanonicalName', () => {
  it('prefers a business-looking name over a more frequent person name', () => {
    const variants = new Map([
      ['Quincy Quill', 9],
      ['Quill Family Farm', 2],
    ]);
    expect(chooseCanonicalName(variants)).toBe('Quill Family Farm');
  });

  it('merges whitespace-only variants of the same name before scoring', () => {
    const variants = new Map([
      ['Sample Farm', 3],
      ['  Sample   Farm  ', 2],
    ]);
    expect(chooseCanonicalName(variants)).toBe('Sample Farm');
  });

  it('breaks a tie between equally-scored names alphabetically', () => {
    const variants = new Map([
      ['Bravo Farm', 1],
      ['Alpha Farm', 1],
    ]);
    expect(chooseCanonicalName(variants)).toBe('Alpha Farm');
  });

  it('returns the empty string for an empty map', () => {
    expect(chooseCanonicalName(new Map())).toBe('');
  });
});

describe('UnionFind', () => {
  it('groups unioned indexes, sets ordered by their smallest member', () => {
    const uf = new UnionFind(5);
    uf.union(0, 1);
    uf.union(3, 4);
    expect(uf.groups()).toEqual([[0, 1], [2], [3, 4]]);
  });

  it('is a no-op when the two indexes are already in the same set', () => {
    const uf = new UnionFind(3);
    uf.union(0, 1);
    uf.union(1, 0);
    expect(uf.groups()).toEqual([[0, 1], [2]]);
  });
});

describe('resolveProducerIdentity', () => {
  it('(a) links a business name, a person name and a lower-case variant through a shared domain and a shared first word into one cluster', () => {
    const rows = [
      { name: 'Maple Hollow Farm', emails: ['info@maplehollow.example'] },
      { name: 'Pat Maple', emails: ['pat@maplehollow.example'] },
      { name: 'maple hollow farm', emails: [] },
    ];
    const clusters = resolveProducerIdentity(rows);
    expect(clusters).toHaveLength(1);
    const [cluster] = clusters;
    expect(cluster.rows).toEqual([0, 1, 2]);
    expect(cluster.canonical_name).toBe('Maple Hollow Farm');
    expect(cluster.aliases).toEqual(['Pat Maple', 'maple hollow farm']);
    expect(cluster.emails).toEqual(['info@maplehollow.example', 'pat@maplehollow.example']);
    expect(cluster.domains).toEqual(['maplehollow.example']);
    expect(cluster.name_keys).toEqual(['maple', 'pat']);
  });

  it('(b) links a person name and a business name that share one gmail address into one cluster (email links; the generic domain does not)', () => {
    const rows = [
      { name: 'Jordan Rivers', emails: ['jordan.rivers@gmail.com'] },
      { name: 'Rivers Bend Farm', emails: ['jordan.rivers@gmail.com'] },
    ];
    const clusters = resolveProducerIdentity(rows);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].rows).toEqual([0, 1]);
    expect(clusters[0].domains).toEqual([]); // gmail.com never links by domain
  });

  it('(c) two unrelated gmail users stay separate', () => {
    const rows = [
      { name: 'Alex Baker', emails: ['alex.baker@gmail.com'] },
      { name: 'Casey Cook', emails: ['casey.cook@gmail.com'] },
    ];
    const clusters = resolveProducerIdentity(rows);
    expect(clusters).toHaveLength(2);
    expect(clusters.map((c) => c.rows)).toEqual([[0], [1]]);
  });

  it('(d) "Terry Testfield" does not join "Testfield Farm" (first word differs), but "Testfield, Terry" does', () => {
    const withoutComma = resolveProducerIdentity([
      { name: 'Terry Testfield', emails: [] },
      { name: 'Testfield Farm', emails: [] },
    ]);
    expect(withoutComma).toHaveLength(2);

    const withComma = resolveProducerIdentity([
      { name: 'Testfield, Terry', emails: [] },
      { name: 'Testfield Farm', emails: [] },
    ]);
    expect(withComma).toHaveLength(1);
    expect(withComma[0].rows).toEqual([0, 1]);
  });

  it('(e) rows with no email and no usable name form singleton clusters with an empty canonical name', () => {
    const rows = [
      { name: '', emails: [] },
      { name: '   ', emails: [null, undefined] },
    ];
    const clusters = resolveProducerIdentity(rows);
    expect(clusters).toHaveLength(2);
    for (const cluster of clusters) {
      expect(cluster.canonical_name).toBe('');
      expect(cluster.emails).toEqual([]);
    }
  });
});
