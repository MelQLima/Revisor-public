import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from '../config/config.js';
import type { Logger } from '../logging/logger.js';
import { newCorrelationId } from '../ids.js';
import { ReviewPipeline } from '../../application/review-pipeline.js';
import { OctokitGitHubClient } from '../../integrations/github/octokit-github-client.js';
import {
  createContextEvolutionService,
  createContextStore,
  createHistoryProvider,
  createLLMProvider,
  createReviewContextProvider,
  toPolicyConfig,
} from '../../application/providers.js';
import { verifyGithubSignature } from './verify-signature.js';
import { PullRequestWebhookSchema, REVIEW_ACTIONS, isMergedEvent } from './webhook-payload.js';

interface RawBodyRequest {
  rawBody?: string;
}

/**
 * Builds the Fastify webhook server. Responsibilities:
 *  - verify the webhook signature (rejects unsigned/invalid requests);
 *  - validate the payload shape;
 *  - enforce the allowed-repos allowlist;
 *  - trigger a review (async) and 202 immediately.
 *
 * For the MVP the review runs in-process after the ack. The seam where a job
 * queue would go is marked below.
 */
export async function buildServer(config: AppConfig, logger: Logger): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Preserve the raw body so we can verify the HMAC signature.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try {
      const parsed = body ? JSON.parse(body as string) : {};
      done(null, parsed);
    } catch (err) {
      done(err as Error, undefined);
    }
  });
  app.addHook('preValidation', async (req) => {
    // Fastify exposes the raw stream separately; capture the string body.
    (req as unknown as RawBodyRequest).rawBody =
      typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
  });

  // Shared, long-lived providers. When context evolution is on, the review
  // context provider also serves knowledge learned from past merged PRs.
  const contextStore = config.contextEvolution.enabled ? createContextStore(config) : undefined;
  const context = createReviewContextProvider(config, contextStore);
  await context.load();
  const history = createHistoryProvider(config);
  const llm = createLLMProvider(config, logger);
  const policy = toPolicyConfig(config);
  const contextEvolution =
    config.contextEvolution.enabled && contextStore
      ? createContextEvolutionService(config, logger, contextStore).service
      : undefined;

  app.get('/health', async () => ({
    status: 'ok',
    llm: llm.name,
    dryRun: config.policy.dryRun,
    githubConfigured: Boolean(config.github.token),
    webhookConfigured: Boolean(config.github.webhookSecret),
  }));

  app.post('/webhook/github', async (req, reply) => {
    const rawBody = (req as unknown as RawBodyRequest).rawBody ?? '';
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    const eventType = req.headers['x-github-event'] as string | undefined;
    const deliveryId = (req.headers['x-github-delivery'] as string | undefined) ?? newCorrelationId();

    if (!config.github.webhookSecret) {
      logger.error('Webhook received but GITHUB_WEBHOOK_SECRET is not configured — rejecting');
      return reply.code(503).send({ error: 'webhook secret not configured' });
    }
    if (!verifyGithubSignature(config.github.webhookSecret, rawBody, signature)) {
      logger.warn({ deliveryId }, 'Rejected webhook: invalid signature');
      return reply.code(401).send({ error: 'invalid signature' });
    }

    if (eventType === 'ping') return reply.code(200).send({ ok: true });
    if (eventType !== 'pull_request') return reply.code(204).send();

    const parsed = PullRequestWebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      logger.warn({ deliveryId }, 'Rejected webhook: invalid payload');
      return reply.code(400).send({ error: 'invalid payload' });
    }

    const payload = parsed.data;
    const merged = isMergedEvent(payload);
    const isReviewAction = REVIEW_ACTIONS.has(payload.action);

    // The webhook handler only detects + dispatches; it never runs analysis inline.
    if (!merged && !isReviewAction) {
      return reply.code(202).send({ skipped: `action '${payload.action}' not handled` });
    }
    if (isReviewAction && payload.pull_request?.draft) {
      return reply.code(202).send({ skipped: 'draft PR' });
    }

    const repo = { owner: payload.repository.owner.login, name: payload.repository.name };
    const slug = `${repo.owner}/${repo.name}`.toLowerCase();
    if (config.github.allowedRepos.length > 0 && !config.github.allowedRepos.includes(slug)) {
      logger.warn({ deliveryId, slug }, 'Rejected webhook: repo not in allowlist');
      return reply.code(403).send({ error: 'repository not allowed' });
    }

    const pullNumber = payload.pull_request?.number ?? payload.number;
    if (!pullNumber) return reply.code(400).send({ error: 'missing pull request number' });

    if (!config.github.token) {
      logger.error('Cannot process webhook: GITHUB_TOKEN not configured');
      return reply.code(503).send({ error: 'github token not configured' });
    }

    // Ack immediately, THEN process asynchronously. Slow LLM analysis must never
    // hold the webhook open (GitHub would time out and retry). This is the seam
    // for a job queue — in production, enqueue { repo, pullNumber, deliveryId,
    // kind } here instead of firing an in-process promise.
    reply.code(202).send({ accepted: true, kind: merged ? 'context-evolution' : 'review', correlationId: deliveryId });

    const github = new OctokitGitHubClient({
      token: config.github.token,
      logger,
      dryRun: config.policy.dryRun,
    });

    if (merged) {
      if (!contextEvolution) {
        logger.info({ deliveryId }, 'Merged PR received but context evolution is disabled');
        return reply;
      }
      // Fetch the full PR (diff, commits, merge sha) then evolve context.
      void github
        .getPullRequest(repo, pullNumber)
        .then((pr) => contextEvolution.onMergedPR(pr, { correlationId: deliveryId }))
        .catch((err) =>
          logger.error(
            { deliveryId, err: (err as Error).message },
            'Async context evolution failed',
          ),
        );
      return reply;
    }

    const pipeline = new ReviewPipeline({
      github,
      context,
      history,
      llm,
      policy,
      logger,
      contextMaxResults: config.context.maxResults,
    });

    void pipeline
      .review({ repo, pullNumber, correlationId: deliveryId }, { post: true })
      .catch((err) => logger.error({ deliveryId, err: (err as Error).message }, 'Async review failed'));

    return reply;
  });

  return app;
}
