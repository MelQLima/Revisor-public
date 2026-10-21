import { randomUUID } from 'node:crypto';
import type {
  AuditEvent,
  AuditSink,
  Authorizer,
  Tool,
  ToolContext,
  ToolDescriptor,
  ToolDomain,
  ToolOutcome,
  ToolResult,
} from '@triple-r/shared-types';
import type { Logger } from '@triple-r/observability';
import { ToolRegistry } from './registry.js';
import { redactArgs } from './redact.js';
import { InMemoryAuditSink, InMemoryIdempotencyStore, type IdempotencyStore } from './stores.js';

/** Gateway tool events for structured logging (§25). */
export const ToolEvent = {
  Invoked: 'tool_invoked',
  Denied: 'tool_denied',
  NeedsConfirmation: 'tool_needs_confirmation',
  InvalidInput: 'tool_invalid_input',
  Replayed: 'tool_replayed',
  Completed: 'tool_completed',
  Failed: 'tool_failed',
} as const;

export interface ToolGatewayDeps {
  registry: ToolRegistry;
  authorizer: Authorizer;
  logger: Logger;
  audit?: AuditSink;
  idempotency?: IdempotencyStore;
  /** Injectable clock/id for deterministic tests. */
  now?: () => number;
  newId?: () => string;
}

/** A write blocked pending confirmation carries a human preview of its effect. */
export interface ConfirmationRequired {
  toolName: string;
  effect: string;
}

const isOk = (o: ToolOutcome): boolean => o === 'ok';

/**
 * The tool gateway. Every agent tool call goes through `invoke`, which enforces,
 * in order: enablement → authorization → input validation → write-confirmation →
 * idempotency → execution → audit → observability. Connectors never see this
 * logic; agents never bypass it.
 */
export class ToolGateway {
  private readonly registry: ToolRegistry;
  private readonly authorizer: Authorizer;
  private readonly logger: Logger;
  private readonly audit: AuditSink;
  private readonly idempotency: IdempotencyStore;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(deps: ToolGatewayDeps) {
    this.registry = deps.registry;
    this.authorizer = deps.authorizer;
    this.logger = deps.logger;
    this.audit = deps.audit ?? new InMemoryAuditSink();
    this.idempotency = deps.idempotency ?? new InMemoryIdempotencyStore();
    this.now = deps.now ?? (() => Date.now());
    this.newId = deps.newId ?? (() => randomUUID());
  }

  /** Tool descriptors the agent may use — feed these to the LLM, not everything (§21). */
  listTools(ctx: Pick<ToolContext, 'agent'>, opts: { domain?: ToolDomain } = {}): ToolDescriptor[] {
    return this.registry.listForAgent(ctx.agent, opts);
  }

  async invoke<Data = unknown>(
    toolName: string,
    args: unknown,
    ctx: ToolContext,
  ): Promise<ToolResult<Data>> {
    const started = this.now();

    // 1. Enablement — is this tool even wired to this agent?
    const tool = this.registry.get(toolName);
    if (!tool || !this.registry.isEnabled(ctx.agent, toolName)) {
      return this.finish<Data>(
        { outcome: 'denied', success: false, toolName, domain: 'internal', mode: 'read',
          message: `Tool "${toolName}" is not available to ${ctx.agent}` },
        { ctx, args, started, authorization: { allowed: false, reason: 'tool not enabled for agent' },
          event: ToolEvent.Denied },
      );
    }

    const meta = { toolName: tool.name, domain: tool.domain, mode: tool.mode };

    // 2. Authorization.
    const decision = this.authorizer.authorize({
      agent: ctx.agent, domain: tool.domain, mode: tool.mode, toolName: tool.name,
      ...(ctx.user ? { user: ctx.user } : {}),
    });
    if (!decision.allowed) {
      return this.finish<Data>(
        { outcome: 'denied', success: false, ...meta, message: decision.reason },
        { ctx, args, started, authorization: decision, event: ToolEvent.Denied },
      );
    }

    // 3. Input validation.
    let parsed: unknown;
    try {
      parsed = tool.inputSchema.parse(args);
    } catch (err) {
      return this.finish<Data>(
        { outcome: 'invalid_input', success: false, ...meta, message: (err as Error).message },
        { ctx, args, started, authorization: decision, event: ToolEvent.InvalidInput },
      );
    }

    // 4. Write-confirmation (§12) — never execute an unconfirmed write.
    if (tool.mode === 'write' && !ctx.confirmed) {
      const effect = tool.describeEffect ? tool.describeEffect(parsed) : `Execute ${tool.name}`;
      return this.finish<Data>(
        { outcome: 'needs_confirmation', success: false, ...meta,
          message: `Confirmation required: ${effect}` },
        { ctx, args, started, authorization: decision, event: ToolEvent.NeedsConfirmation },
      );
    }

    // 5. Idempotency (§13) — replay a prior write result instead of re-executing.
    if (tool.mode === 'write' && ctx.idempotencyKey) {
      const prior = await this.idempotency.get(ctx.idempotencyKey);
      if (prior) {
        const replayed: ToolResult<Data> = { ...(prior as ToolResult<Data>), replayed: true };
        return this.finish<Data>(replayed, {
          ctx, args, started, authorization: decision, event: ToolEvent.Replayed,
        });
      }
    }

    // 6. Execute — a thrown/failed connector becomes `unavailable`, never silent success (§24).
    let result: ToolResult<Data>;
    try {
      const exec = await tool.execute(parsed, ctx);
      result = {
        outcome: exec.outcome,
        success: isOk(exec.outcome),
        ...meta,
        ...(exec.data !== undefined ? { data: exec.data as Data } : {}),
        ...(exec.message !== undefined ? { message: exec.message } : {}),
        ...(exec.source !== undefined ? { source: exec.source } : {}),
      };
    } catch (err) {
      result = {
        outcome: 'unavailable', success: false, ...meta,
        message: `${tool.name} could not be executed: ${(err as Error).message}`,
      };
    }

    // 7. Persist idempotent success so a retry replays it.
    if (tool.mode === 'write' && ctx.idempotencyKey && result.success) {
      await this.idempotency.set(ctx.idempotencyKey, result);
    }

    return this.finish<Data>(result, {
      ctx, args, started, authorization: decision,
      event: result.success ? ToolEvent.Completed : ToolEvent.Failed,
    });
  }

  /** Stamp audit + logs and return — the single exit for every path above. */
  private async finish<Data>(
    result: ToolResult<Data>,
    meta: {
      ctx: ToolContext;
      args: unknown;
      started: number;
      authorization: { allowed: boolean; reason: string };
      event: string;
    },
  ): Promise<ToolResult<Data>> {
    const durationMs = this.now() - meta.started;
    const event: AuditEvent = {
      id: this.newId(),
      timestamp: new Date(this.now()).toISOString(),
      correlationId: meta.ctx.correlationId,
      agent: meta.ctx.agent,
      ...(meta.ctx.user ? { user: meta.ctx.user.id } : {}),
      tool: result.toolName,
      domain: result.domain,
      mode: result.mode,
      args: redactArgs(meta.args),
      outcome: result.outcome,
      success: result.success,
      durationMs,
      ...(meta.ctx.idempotencyKey ? { idempotencyKey: meta.ctx.idempotencyKey } : {}),
      authorization: meta.authorization,
      ...(result.outcome === 'unavailable' && result.message ? { error: result.message } : {}),
    };
    await this.audit.record(event);
    this.logger.info(
      {
        event: meta.event,
        correlationId: meta.ctx.correlationId,
        agent: meta.ctx.agent,
        tool: result.toolName,
        domain: result.domain,
        mode: result.mode,
        outcome: result.outcome,
        durationMs,
      },
      `${result.toolName} → ${result.outcome}`,
    );
    return result;
  }
}
