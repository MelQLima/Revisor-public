import type { CodeSnippet, PullRequest } from '../domain/pull-request.js';
import type { GitHubClient } from '../integrations/github/github-client.js';

const MAX_FILES = 6;
const MAX_CHARS_PER_FILE = 6_000;
const CODE_FILE = /\.(ts|tsx|js|jsx|py|go|rb|java|kt|cs|php|sql)$/i;

/**
 * Collect "relevant code" for the review: the full content (at HEAD) of the
 * changed source files, so the reviewer sees each change in the context of its
 * surrounding file rather than just an isolated diff hunk.
 *
 * Bounded on purpose (Rule 21: avoid sending unnecessary repo content to the
 * LLM). A future version can expand this to symbol resolution / call graphs.
 */
export async function collectRelevantCode(
  github: GitHubClient,
  pr: PullRequest,
): Promise<CodeSnippet[]> {
  const candidates = pr.changedFiles
    .filter((f) => f.status !== 'removed' && CODE_FILE.test(f.filename))
    .slice(0, MAX_FILES);

  const snippets: CodeSnippet[] = [];
  for (const file of candidates) {
    const content = await github.getFileContent(pr.repo, file.filename, pr.headSha);
    if (!content) continue;
    snippets.push({
      filename: file.filename,
      content: content.length > MAX_CHARS_PER_FILE ? content.slice(0, MAX_CHARS_PER_FILE) : content,
      reason: 'full file at HEAD for the change under review',
    });
  }
  return snippets;
}
