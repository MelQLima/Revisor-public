import type { AgentId, Tool, ToolDescriptor, ToolDomain } from '@triple-r/shared-types';
import { toDescriptor } from '@triple-r/shared-types';

/**
 * Tool registry + per-agent enablement (§21). Enablement (which tools an agent
 * can even SEE) is separate from authorization (whether an action is allowed):
 * a tool is discoverable only if enabled for the agent, and every call is still
 * authorized independently — defense in depth, and the seam for per-user and
 * per-workflow enablement later.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readonly enabled = new Map<AgentId, Set<string>>();

  /** Register a tool and enable it for the given agents. */
  register(tool: Tool, agents: AgentId[]): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
    for (const agent of agents) {
      const set = this.enabled.get(agent) ?? new Set<string>();
      set.add(tool.name);
      this.enabled.set(agent, set);
    }
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  isEnabled(agent: AgentId, name: string): boolean {
    return this.enabled.get(agent)?.has(name) ?? false;
  }

  /** Descriptors an agent may use — what it turns into an LLM tool list (§21). */
  listForAgent(agent: AgentId, opts: { domain?: ToolDomain } = {}): ToolDescriptor[] {
    const names = this.enabled.get(agent) ?? new Set<string>();
    const out: ToolDescriptor[] = [];
    for (const name of names) {
      const tool = this.tools.get(name);
      if (!tool) continue;
      if (opts.domain && tool.domain !== opts.domain) continue;
      out.push(toDescriptor(tool));
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
}
