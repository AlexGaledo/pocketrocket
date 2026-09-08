import { describe, it, expect } from 'vitest';
import { pathsFromInput } from './pathRules.js';

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
});
