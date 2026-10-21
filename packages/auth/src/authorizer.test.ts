import { describe, it, expect } from 'vitest';
import { StaticAuthorizer } from './authorizer.js';

describe('StaticAuthorizer (default grants)', () => {
  const auth = new StaticAuthorizer();

  it('allows a granted read', () => {
    const d = auth.authorize({ agent: 'resolver', domain: 'bigquery', mode: 'read', toolName: 'bq_search' });
    expect(d.allowed).toBe(true);
  });

  it('denies an ungranted domain', () => {
    const d = auth.authorize({ agent: 'reviewer', domain: 'slack', mode: 'read', toolName: 'slack_search' });
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('lacks slack:read');
  });

  it('denies a write to a read-only agent', () => {
    const d = auth.authorize({ agent: 'resolver', domain: 'slack', mode: 'write', toolName: 'slack_send' });
    expect(d.allowed).toBe(false);
  });

  it('allows a write-capable agent to write', () => {
    const d = auth.authorize({ agent: 'reinforcement', domain: 'slack', mode: 'write', toolName: 'slack_send' });
    expect(d.allowed).toBe(true);
  });

  it('lets a write grant imply read on the same domain', () => {
    const d = auth.authorize({ agent: 'reinforcement', domain: 'slack', mode: 'read', toolName: 'slack_search' });
    expect(d.allowed).toBe(true);
  });

  it('honors a custom grant matrix', () => {
    const custom = new StaticAuthorizer({
      reviewer: [],
      resolver: [],
      reinforcement: [{ domain: 'internal', mode: 'write' }],
    });
    expect(custom.authorize({ agent: 'resolver', domain: 'github', mode: 'read', toolName: 't' }).allowed).toBe(false);
    expect(custom.authorize({ agent: 'reinforcement', domain: 'internal', mode: 'write', toolName: 't' }).allowed).toBe(true);
  });
});
