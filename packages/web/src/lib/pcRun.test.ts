import { describe, expect, it } from 'vitest';
import { canResume, jobActive, modeLabel, newRunBody, originLabel, pcBlockedReason, promptOk, resumeBody, statusLabel } from './pcRun';

const online = { paired: true, online: true };

describe('pcBlockedReason', () => {
  it('is clear when signed in with the PC online', () => {
    expect(pcBlockedReason({ status: online, signedIn: true })).toBeNull();
  });
  it('asks for a password sign-in first', () => {
    expect(pcBlockedReason({ status: online, signedIn: false })).toMatch(/Sign in with your password/);
  });
  it('explains an offline or unpaired PC', () => {
    expect(pcBlockedReason({ status: { paired: true, online: false }, signedIn: true })).toMatch(/offline/);
    expect(pcBlockedReason({ status: { paired: false, online: false }, signedIn: true })).toMatch(/No PC is paired/);
    expect(pcBlockedReason({ status: null, signedIn: true })).toMatch(/Checking/);
  });
});

describe('request bodies', () => {
  it('builds the resume body with a trimmed prompt', () => {
    expect(resumeBody('abc-123', '  keep going \n')).toEqual({ mode: 'resume', sessionId: 'abc-123', prompt: 'keep going' });
  });
  it('builds the new-run body from the chosen folder', () => {
    expect(newRunBody('site', ' fix the tests ')).toEqual({ mode: 'new', folder: 'site', prompt: 'fix the tests' });
  });
  it('only resumes a top-level session', () => {
    expect(canResume('abc')).toBe(true);
    expect(canResume('abc:agent-1')).toBe(false);
  });
  it('limits the prompt to 1..8000 characters', () => {
    expect(promptOk('  ')).toBe(false);
    expect(promptOk('x')).toBe(true);
    expect(promptOk('x'.repeat(8001))).toBe(false);
  });
});

describe('job labels', () => {
  it('maps every status to a plain label', () => {
    expect(statusLabel('queued')).toBe('Waiting for your PC');
    expect(statusLabel('running')).toBe('Running');
    expect(statusLabel('pending_approval')).toBe('Waiting for you');
    expect(statusLabel('refused')).toBe('Refused on PC');
    expect(statusLabel('done')).toBe('Done');
  });
  it('knows which jobs are still moving', () => {
    expect(jobActive('claimed')).toBe(true);
    expect(jobActive('done')).toBe(false);
    expect(jobActive('failed')).toBe(false);
  });
  it('labels mode and origin, defaulting to an old-style bot job', () => {
    expect(modeLabel({ mode: 'resume' })).toBe('Resume');
    expect(modeLabel({})).toBe('New');
    expect(originLabel({ origin: 'owner' })).toBe('You');
    expect(originLabel({})).toBe('Bot');
  });
});
