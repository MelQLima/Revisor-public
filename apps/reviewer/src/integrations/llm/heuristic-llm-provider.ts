import { createHash } from 'node:crypto';
import type {
  ReviewInput,
  ValidationInput,
  ValidationResult,
} from '../../domain/review-input.js';
import type { CandidateReview, ReviewFinding } from '../../domain/review.js';
import type {
  ContextChangeProposal,
  ContextEvolutionInput,
} from '../../domain/context-evolution.js';
import type { LLMProvider } from './llm-provider.js';
import { noChangeProposal } from './context-normalize.js';

/**
 * A NON-AI, rule-based reviewer used as an offline fallback so the whole
 * pipeline (context retrieval -> analysis -> validation -> formatting) can be
 * exercised end-to-end with `npm run review` when no ANTHROPIC_API_KEY is set.
 *
 * It is intentionally modest: it flags a handful of concrete, evidence-backed
 * patterns rather than pretending to reason about business rules. Real reviews
 * should use ClaudeLLMProvider.
 */

interface Signal {
  file: string;
  line?: number;
  finding: Omit<ReviewFinding, 'id'>;
}

function addedLines(patch: string | undefined): { text: string; index: number }[] {
  if (!patch) return [];
  const out: { text: string; index: number }[] = [];
  let newLine = 0;
  for (const line of patch.split(/\r?\n/)) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = parseInt(hunk[1]!, 10);
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      out.push({ text: line.slice(1), index: newLine });
      newLine += 1;
    } else if (!line.startsWith('-')) {
      newLine += 1;
    }
  }
  return out;
}

function removedLines(patch: string | undefined): string[] {
  if (!patch) return [];
  return patch
    .split(/\r?\n/)
    .filter((l) => l.startsWith('-') && !l.startsWith('---'))
    .map((l) => l.slice(1));
}

export class HeuristicLLMProvider implements LLMProvider {
  readonly name = 'heuristic-offline';

  async generateReview(input: ReviewInput): Promise<CandidateReview> {
    const signals: Signal[] = [];
    const businessTerms = collectTerms(input.businessContext.map((c) => c.content).join(' '));

    for (const file of input.pullRequest.changedFiles) {
      const added = addedLines(file.patch);
      const removed = removedLines(file.patch);

      // 1) Removed a guard/validation that business docs care about.
      const removedGuard = removed.find((l) => /\b(validate|assert|guard|check|verify|ensure)\b/i.test(l));
      if (removedGuard && input.businessContext.length > 0) {
        signals.push({
          file: file.filename,
          finding: {
            category: 'business',
            severity: 'IMPORTANT',
            certainty: 'potential',
            confidence: 0.6,
            title: 'A validation/guard was removed near business-critical logic',
            problem: `This change removes a guard (\`${removedGuard.trim().slice(0, 120)}\`). Business context documents invariants for this area.`,
            evidence: input.businessContext.slice(0, 2).map((c) => ({
              source: c.source,
              detail: c.title,
            })),
            impact: 'Removing the guard may allow an invalid state the invariant was protecting against.',
            recommendation: 'Confirm the invariant is still enforced elsewhere before removing this guard.',
          },
        });
      }

      for (const { text, index } of added) {
        // 2) SQL string concatenation.
        if (/(select|insert|update|delete)\b[\s\S]*\+\s*\w/i.test(text) && /['"`]/.test(text)) {
          signals.push(sig(file.filename, index, {
            category: 'technical',
            severity: 'IMPORTANT',
            certainty: 'likely',
            confidence: 0.7,
            title: 'Possible SQL built via string concatenation',
            problem: `Added line concatenates values into a SQL string: \`${text.trim().slice(0, 120)}\`.`,
            evidence: [{ source: `${file.filename}:${index}`, detail: 'concatenated SQL literal' }],
            impact: 'Risk of SQL injection and query errors if any concatenated value is untrusted.',
            recommendation: 'Use parameterized queries / bound parameters instead of string concatenation.',
          }));
        }

        // 3) Loose equality on a domain check.
        if (/[^=!]==[^=]/.test(text) && !/===/.test(text)) {
          signals.push(sig(file.filename, index, {
            category: 'technical',
            severity: 'SUGGESTION',
            certainty: 'likely',
            confidence: 0.55,
            title: 'Loose equality (==) used',
            problem: `\`${text.trim().slice(0, 120)}\` uses == which performs type coercion.`,
            evidence: [{ source: `${file.filename}:${index}`, detail: 'loose equality' }],
            impact: 'Type coercion can produce surprising matches (e.g. 0 == "").',
            recommendation: 'Prefer strict equality (===) unless coercion is intended.',
          }));
        }

        // 4) Domain-term identity association without validation (business-ish).
        if (/\bemail\b/i.test(text) && /\b(find|match|associate|link|reconcile)\b/i.test(text) && businessTerms.has('email')) {
          signals.push(sig(file.filename, index, {
            category: 'business',
            severity: 'IMPORTANT',
            certainty: 'potential',
            confidence: 0.62,
            title: 'Entity associated by email alone',
            problem: `\`${text.trim().slice(0, 120)}\` associates records using email; business context flags email as non-unique identity.`,
            evidence: input.businessContext.slice(0, 2).map((c) => ({ source: c.source, detail: c.title })),
            impact: 'May associate a record with the wrong entity when an email is shared.',
            recommendation: 'Require the documented identity validation before associating by email.',
          }));
        }
      }

      // 5) New non-trivial file with no accompanying test.
    }

    // 6) Missing tests heuristic.
    const touchesCode = input.pullRequest.changedFiles.some((f) => /\.(ts|js|tsx|jsx)$/.test(f.filename) && !/test|spec/i.test(f.filename));
    const touchesTests = input.pullRequest.changedFiles.some((f) => /(test|spec)\./i.test(f.filename));
    const positives: string[] = [];
    if (touchesTests) positives.push('The PR adds or updates tests.');
    if (!touchesTests && touchesCode) {
      signals.push({
        file: input.pullRequest.changedFiles[0]?.filename ?? 'unknown',
        finding: {
          category: 'technical',
          severity: 'SUGGESTION',
          certainty: 'likely',
          confidence: 0.58,
          title: 'No tests accompany a behavior change',
          problem: 'Source files changed but no test files were added or modified.',
          evidence: [{ source: 'diff', detail: 'no *.test.* / *.spec.* files in the changeset' }],
          impact: 'Behavior changes without tests raise regression risk.',
          recommendation: 'Add a test covering the changed behavior.',
        },
      });
    }

    const findings: ReviewFinding[] = signals.map((s, i) => ({
      ...s.finding,
      id: `${input.correlationId}-h${i}-${hash(s.finding.title + s.file)}`,
      file: s.file,
      ...(s.line ? { line: s.line } : {}),
    }));

    return {
      summary: `Offline heuristic review of ${input.pullRequest.changedFiles.length} file(s). ${findings.length} candidate signal(s).`,
      findings,
      positives,
    };
  }

  async validateFindings(input: ValidationInput): Promise<ValidationResult> {
    // The heuristic pass cannot second-guess itself; echo decisions unchanged.
    return {
      decisions: input.candidateFindings.map((f) => ({
        findingId: f.id,
        status: 'UNCERTAIN' as const,
        contradictionFound: false,
        contradictingEvidence: '',
        keep: true,
        adjustedConfidence: f.confidence,
        adjustedCertainty: f.certainty,
        reason: 'heuristic provider: no independent validation available',
      })),
    };
  }

  async proposeContextChange(input: ContextEvolutionInput): Promise<ContextChangeProposal> {
    // A rule-based system cannot reliably judge "durable domain knowledge"
    // without over-generating rules, so it stays conservative: NO_CHANGE.
    // Use a real model (qwen/claude) for meaningful context evolution.
    return noChangeProposal(
      input.pullRequest,
      'offline heuristic provider does not infer context changes',
    );
  }
}

function sig(file: string, line: number, finding: Omit<ReviewFinding, 'id' | 'file' | 'line'>): Signal {
  return { file, line, finding: { ...finding } };
}

function hash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 6);
}

function collectTerms(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3));
}
