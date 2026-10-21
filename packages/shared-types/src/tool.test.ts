import { describe, it, expect } from 'vitest';
import { toDescriptor } from './tool.js';
import type { Tool } from './tool.js';

const tool: Tool = {
  name: 'demo',
  domain: 'internal',
  mode: 'read',
  description: 'demo tool',
  inputSchema: { parse: (i) => i, jsonSchema: { type: 'object' } },
  async execute() {
    return { outcome: 'ok', data: null };
  },
};

describe('toDescriptor', () => {
  it('projects a tool to its discoverable descriptor including jsonSchema', () => {
    expect(toDescriptor(tool)).toEqual({
      name: 'demo',
      domain: 'internal',
      mode: 'read',
      description: 'demo tool',
      jsonSchema: { type: 'object' },
    });
  });

  it('omits jsonSchema when the validator has none', () => {
    const d = toDescriptor({ ...tool, inputSchema: { parse: (i) => i } });
    expect(d.jsonSchema).toBeUndefined();
  });
});
