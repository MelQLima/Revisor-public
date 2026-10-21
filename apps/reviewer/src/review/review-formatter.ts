import type { ReviewComment } from '../integrations/github/github-client.js';
import type { ReviewFinding, ReviewResult, ReviewSeverity } from '../domain/review.js';

/**
 * Renders a ReviewResult into the GitHub review body (markdown) and the set of
 * inline comments. Presentation only — no policy decisions happen here.
 */

const SEVERITY_HEADER: Record<ReviewSeverity, string> = {
  BLOCKER: '### 🔴 BLOCKER',
  IMPORTANT: '### 🟠 IMPORTANT',
  SUGGESTION: '### 🟡 SUGGESTION',
};

const VERDICT_LABEL = {
  approve: 'Approve',
  comment: 'Comment',
  request_changes: 'Changes requested',
} as const;

function renderFinding(f: ReviewFinding): string {
  const location = f.file ? `\`${f.file}${f.line ? `:${f.line}` : ''}\`` : '_(no specific location)_';
  const evidence =
    f.evidence.length > 0
      ? f.evidence.map((e) => `- \`${e.source}\` — ${e.detail}`).join('\n')
      : '- _(no evidence provided)_';
  const rule = f.businessRule ? `\n**Business rule:** ${f.businessRule}\n` : '';
  const contested = f.contested
    ? `\n> ⚠️ **Escalated to a human reviewer** (criticality ${f.contested.criticality}/6). ` +
      `The automated validator tried to drop this without concrete contradictory evidence, so it was RETAINED. ` +
      `Validator note: ${f.contested.reason}\n`
    : '';

  return [
    SEVERITY_HEADER[f.severity],
    '',
    `**${f.title}**`,
    '',
    location,
    '',
    f.problem,
    contested,
    rule,
    '**Evidence:**',
    evidence,
    '',
    `**Impact:** ${f.impact}`,
    '',
    `**Recommendation:** ${f.recommendation}`,
    '',
    `_Category: ${f.category} · Certainty: ${f.certainty} · Confidence: ${f.confidence.toFixed(2)}_`,
  ].join('\n');
}

export function formatReviewBody(result: ReviewResult): string {
  const { stats } = result;
  const parts: string[] = [];

  parts.push('## AI Code Review');
  parts.push('');
  parts.push('### Summary');
  parts.push('');
  parts.push(result.summary || '_No summary provided._');
  parts.push('');
  parts.push(
    [
      'Reviewed:',
      `- ${stats.changedFiles} changed file(s)`,
      `- ${stats.contextResults} context snippet(s)`,
      `- ${stats.businessRulesConsulted} business rule reference(s)`,
      `- ${stats.historyReferences} historical reference(s)`,
    ].join('\n'),
  );
  parts.push('');

  if (result.findings.length === 0) {
    parts.push('No actionable findings above the confidence threshold. ✅');
  } else {
    for (const f of result.findings) {
      parts.push('---');
      parts.push('');
      parts.push(renderFinding(f));
      parts.push('');
    }
  }

  if (result.positives.length > 0) {
    parts.push('---');
    parts.push('');
    parts.push('### 🟢 Positive observations');
    parts.push('');
    parts.push(result.positives.map((p) => `- ${p}`).join('\n'));
    parts.push('');
  }

  parts.push('---');
  parts.push('');
  parts.push(`### Verdict`);
  parts.push('');
  parts.push(`**${VERDICT_LABEL[result.verdict]}**`);
  parts.push('');
  parts.push(`<sub>correlation: ${result.correlationId}</sub>`);

  return parts.join('\n');
}

/** Findings that have a concrete file+line become inline comments. */
export function toInlineComments(result: ReviewResult): ReviewComment[] {
  return result.findings
    .filter((f): f is ReviewFinding & { file: string; line: number } => Boolean(f.file && f.line))
    .map((f) => ({
      path: f.file,
      line: f.line,
      body: [
        `**${f.severity}: ${f.title}**`,
        '',
        f.problem,
        '',
        `**Recommendation:** ${f.recommendation}`,
        `<sub>confidence ${f.confidence.toFixed(2)} · ${f.certainty}</sub>`,
      ].join('\n'),
    }));
}
