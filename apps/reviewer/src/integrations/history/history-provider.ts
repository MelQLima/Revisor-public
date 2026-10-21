import type { ContextResult } from '../../domain/context.js';
import type { PullRequest } from '../../domain/pull-request.js';

/**
 * Repository history abstraction.
 *
 * The purpose is to let the reviewer discover context like "this guard was
 * introduced in commit X to prevent Y". Historical evidence should *increase*
 * confidence in a finding, never automatically prove correctness.
 *
 * MVP: a no-op/simple implementation. The interface anticipates git log/blame,
 * prior PRs, and incident records so those can be added without a rewrite.
 */
export interface HistoryProvider {
  readonly name: string;
  /**
   * Return history signals relevant to the changed files/lines in a PR.
   * MUST NOT throw when history is unavailable — return [].
   */
  findRelevantHistory(pullRequest: PullRequest): Promise<ContextResult[]>;
}

/** A HistoryProvider that returns nothing — the safe default. */
export class NullHistoryProvider implements HistoryProvider {
  readonly name = 'null-history';
  async findRelevantHistory(): Promise<ContextResult[]> {
    return [];
  }
}
