#!/usr/bin/env node
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../infrastructure/config/config.js';
import { createLogger } from '../infrastructure/logging/logger.js';
import { FileContextStore } from '../infrastructure/context-store/file-context-store.js';
import { createContextEvolutionService } from '../application/providers.js';
import { loadContextFixture, seedContextStore } from '../application/context-fixture.js';

/**
 * Offline context-evolution runner:
 *   npm run context:review -- ./fixtures/merged-pr.json [--json]
 *
 * Runs the full merge → analyze → validate → persist flow against a fixture in
 * an ephemeral store (no GitHub). Seeds any prior context declared in the
 * fixture (e.g. so a revert can be demonstrated self-contained).
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fixturePath = args.find((a) => !a.startsWith('--'));
  const asJson = args.includes('--json');
  if (!fixturePath) {
    console.error('Usage: npm run context:review -- <path-to-fixture.json> [--json]');
    process.exit(2);
    return;
  }

  const config = loadConfig();
  const logger = createLogger({ level: asJson ? 'warn' : config.logLevel });

  const fixture = await loadContextFixture(resolve(fixturePath));

  // Ephemeral store per run so demos are reproducible and side-effect free.
  const dir = await mkdtemp(join(tmpdir(), 'revisor-ctx-'));
  const store = new FileContextStore(join(dir, 'context-store.json'));
  await seedContextStore(store, fixture);

  const { service } = createContextEvolutionService(config, logger, store);
  const outcome = await service.onMergedPR(fixture.pullRequest);

  const current = await store.getCurrent(outcome.proposal.topic);
  const history = await store.getHistory(outcome.proposal.topic);

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ outcome, current, history }, null, 2)}\n`);
    return;
  }

  const p = outcome.proposal;
  const lines = [
    '',
    '## Context Evolution',
    '',
    `PR #${p.sourcePullRequest.number} — ${p.sourcePullRequest.title}`,
    outcome.revert?.isRevert
      ? `Revert: yes (confidence ${outcome.revert.confidence}, reverts #${outcome.revert.originalPullRequestNumber ?? '?'})`
      : 'Revert: no',
    '',
    `Decision:   ${outcome.status}${outcome.idempotent ? ' (idempotent no-op)' : ''}`,
    `Reason:     ${outcome.decisionReason}`,
    `Change:     ${p.type}  ·  topic: ${p.topic}  ·  category: ${p.category}  ·  confidence: ${p.confidence.toFixed(2)}`,
    `Summary:    ${p.summary}`,
    p.proposedContent ? `Content:    ${p.proposedContent}` : '',
    `Evidence:   ${p.evidence.map((e) => `${e.source}:${e.reference}`).join(', ') || '(none)'}`,
    '',
  ];
  if (current) {
    lines.push(`Current context for "${p.topic}": v${current.version} [${current.status}] — ${current.content}`);
  } else if (p.topic !== 'none') {
    lines.push(`Current context for "${p.topic}": (none active)`);
  }
  if (history.length > 0) {
    lines.push('History:');
    for (const h of history) {
      lines.push(`  v${h.version} [${h.status}] ${h.changeType} · PR #${h.source.number} — ${h.summary}`);
    }
  }
  process.stdout.write(`${lines.filter((l) => l !== '').join('\n')}\n\n`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
