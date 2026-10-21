import type { PullRequest } from '../domain/pull-request.js';
import { tokenize } from './tokenize.js';

/**
 * Derive a retrieval query from a PR ("identify relevant code and domain
 * concepts"). We weight signal from filenames and changed identifiers over the
 * (untrusted, possibly noisy) PR description.
 *
 * Identifiers are pulled from *added* diff lines so we bias toward what the PR
 * introduces. The result is a de-duplicated, frequency-ordered term string.
 */
export function buildContextQuery(pr: PullRequest): string {
  const counts = new Map<string, number>();
  const add = (text: string, weight: number) => {
    for (const term of tokenize(text)) counts.set(term, (counts.get(term) ?? 0) + weight);
  };

  add(pr.title, 3);

  for (const file of pr.changedFiles) {
    add(file.filename, 3);
    if (file.previousFilename) add(file.previousFilename, 1);
    if (!file.patch) continue;
    for (const line of file.patch.split(/\r?\n/)) {
      // Only added lines (leading '+', excluding the '+++' file header).
      if (line.startsWith('+') && !line.startsWith('+++')) {
        add(line.slice(1), 2);
      }
    }
  }

  // PR description last and lightly weighted — it is untrusted and noisy.
  add(pr.body, 1);

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([term]) => term)
    .join(' ');
}
