import { describe, it, expect } from 'vitest';
import { globPrefix, pathsFromInput } from './pathRules.js';

describe('pathsFromInput', () => {
  it('extracts file_path / path / notebook_path', () => {
    expect(pathsFromInput('Read', { file_path: 'a.txt' })).toEqual(['a.txt']);
    expect(pathsFromInput('Grep', { pattern: 'x', path: 'src' })).toEqual(['src']);
    expect(pathsFromInput('NotebookEdit', { notebook_path: 'n.ipynb' })).toEqual(['n.ipynb']);
  });
  it('defaults Glob/Grep without a path to cwd', () => {
    expect(pathsFromInput('Glob', { pattern: '**/*.ts' })).toEqual(['.']);
    expect(pathsFromInput('Bash', { command: 'ls' })).toEqual([]);
  });

  // ---- audit 2026-09-09, B13 ----
  it('extracts the directory prefix embedded in a Glob/Grep glob', () => {
    // The audit's exact payload: the escape rode in `glob`, which was never looked at.
    expect(pathsFromInput('Grep', { pattern: 'BEGIN.*PRIVATE KEY', glob: '../../../**/*' })).toEqual(['../../..']);
    expect(pathsFromInput('Glob', { pattern: '../../secrets/**/*.json' })).toEqual(['../../secrets']);
    expect(pathsFromInput('Glob', { pattern: 'C:/Users/**' })).toEqual(['C:/Users']);
    expect(pathsFromInput('Grep', { pattern: 'x', glob: 'src/**/*.ts' })).toEqual(['src']);
  });

  it('leaves an ordinary Grep regex alone but catches one shaped like an escaping path', () => {
    // `pattern` is a regex for Grep: flagging every regex containing a dot would be noise.
    expect(pathsFromInput('Grep', { pattern: 'foo.*bar' })).toEqual(['.']);
    expect(pathsFromInput('Grep', { pattern: 'a..b' })).toEqual(['.']);
    expect(pathsFromInput('Grep', { pattern: '../../etc/passwd' })).toEqual(['../../etc/passwd']);
    expect(pathsFromInput('Grep', { pattern: '/etc/shadow' })).toEqual(['/etc/shadow']);
  });

  it('keeps explicit path fields alongside the pattern prefix', () => {
    expect(pathsFromInput('Grep', { path: 'src', glob: '../../**/*' })).toEqual(['src', '../..']);
  });
});

describe('globPrefix', () => {
  it('returns everything before the first wildcard, trimmed to a directory', () => {
    expect(globPrefix('**/*.ts')).toBe(null);
    expect(globPrefix('*.ts')).toBe(null);
    expect(globPrefix('src/**/*.ts')).toBe('src');
    expect(globPrefix('src/index.ts')).toBe('src/index.ts');
    expect(globPrefix('../../../**/*')).toBe('../../..');
    expect(globPrefix('a/b/c-*.json')).toBe('a/b');
    expect(globPrefix('')).toBe(null);
  });
});
