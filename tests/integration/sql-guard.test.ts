import { describe, expect, it } from 'vitest';
import { classifyStatement, normalizeType, quoteIdent } from '../../services/api/src/lib/sql.js';

describe('identifier quoting', () => {
  it('quotes valid identifiers', () => {
    expect(quoteIdent('users')).toBe('"users"');
    expect(quoteIdent('user_profiles_2')).toBe('"user_profiles_2"');
  });

  it('rejects anything that could break out of the quotes', () => {
    for (const bad of ['users; DROP TABLE x', 'a"b', '1abc', '', 'a'.repeat(64), 'drop table']) {
      expect(() => quoteIdent(bad)).toThrow();
    }
  });
});

describe('type normalisation', () => {
  it('accepts known types and parameters', () => {
    expect(normalizeType('TEXT')).toBe('text');
    expect(normalizeType('varchar(255)')).toBe('varchar(255)');
    expect(normalizeType('numeric(12,2)')).toBe('numeric(12,2)');
    expect(normalizeType('text[]')).toBe('text[]');
    expect(normalizeType('vector(1536)')).toBe('vector(1536)');
  });

  it('rejects smuggled expressions', () => {
    expect(() => normalizeType('text; DROP TABLE users')).toThrow();
    expect(() => normalizeType('(select 1)')).toThrow();
  });
});

describe('statement classification', () => {
  it('sees through comments', () => {
    expect(classifyStatement('/* hi */ DROP TABLE users')).toBe('destructive');
    expect(classifyStatement('-- comment\nselect 1')).toBe('read');
    expect(classifyStatement('insert into t values (1)')).toBe('write');
    expect(classifyStatement('create index on t(a)')).toBe('ddl');
  });
});
