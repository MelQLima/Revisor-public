import type { ZodType } from 'zod';
import type { InputValidator } from '@triple-r/shared-types';

/**
 * Adapt a Zod schema to the platform's dependency-free `InputValidator`
 * contract, optionally carrying a hand-written JSON shape for LLM tool
 * discovery (§21). Keeps connectors terse without leaking Zod into shared-types.
 */
export function zodInput<Args>(schema: ZodType<Args>, jsonSchema?: unknown): InputValidator<Args> {
  return {
    parse: (input: unknown) => schema.parse(input),
    ...(jsonSchema !== undefined ? { jsonSchema } : {}),
  };
}
