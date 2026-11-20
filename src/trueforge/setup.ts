/**
 * TrueForge REST helpers (PURE, no vscode): health check, model listing and idempotent
 * registration of the editor MCP server, the Forgelight agent and model providers.
 *
 * Upsert semantics (from /api/v1/openapi.json, TrueForge 0.185):
 *  - PUT /settings/mcp-servers and PUT /settings/model-providers are "create or replace by name".
 *  - Agents have an immutable server id: POST /agents creates (409 if the name is taken),
 *    PUT /agents/{agent_id} replaces. So we look the agent up by name first.
 *  - Creating an agent validates its mcp_servers, so register the MCP server first.
 */
import { MCP_SERVER_NAME, MCP_TOKEN_HEADER } from '../contracts';

export interface AgentDefinition {
  name: string;
  description: string;
  manifest: Record<string, unknown>;
}

/** A configured model and what TrueForge knows about its limits (Feature 4: context X-ray). */
export interface ModelDetails {
  name: string;
  /** Context window in tokens. */
  contextLength?: number;
  maxOutputTokens?: number;
}

export class TrueForgeApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'TrueForgeApiError';
  }
}

const MCP_DESCRIPTION =
  "Forgelight: the user's VS Code workspace exposed as tools: retrieve context, read and search files, find symbols, " +
  'propose edits (reviewed hunk by hunk by the user before anything is written) and run commands (with approval).';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class TrueForgeSetup {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /** True when TrueForge answers GET /api/v1/models within 3 s. */
  async health(): Promise<boolean> {
    try {
      const res = await fetch(this.api('/models'), { signal: AbortSignal.timeout(3000) });
      await res.body?.cancel();
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Configured model FQNs, e.g. ["ollama/qwen3-6-35b"]. */
  async listModels(): Promise<string[]> {
    const body = await this.request<{ data?: Array<{ name?: unknown }> }>('GET', '/models');
    return (body?.data ?? []).map((m) => m.name).filter((n): n is string => typeof n === 'string');
  }

  /**
   * Configured models with their capability metadata (GET /models, data[].properties:
   * context_length, max_output_tokens). Fields TrueForge does not report are left undefined.
   */
  async modelDetails(): Promise<ModelDetails[]> {
    const body = await this.request<{ data?: Array<{ name?: unknown; properties?: Record<string, unknown> | null }> }>(
      'GET',
      '/models',
      undefined,
      5000,
    );
    const positive = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
    const out: ModelDetails[] = [];
    for (const m of body?.data ?? []) {
      if (typeof m?.name !== 'string') continue;
      const props = m.properties && typeof m.properties === 'object' ? m.properties : {};
      out.push({ name: m.name, contextLength: positive(props.context_length), maxOutputTokens: positive(props.max_output_tokens) });
    }
    return out;
  }

  /**
   * Create or replace the remote MCP server (header auth) and wait until TrueForge can list its
   * tools. Returns the tool names. `name` defaults to MCP_SERVER_NAME (tests may use another).
   */
  async registerMcpServer(url: string, token: string, name: string = MCP_SERVER_NAME): Promise<string[]> {
    const manifest = {
      type: 'remote',
      name,
      url,
      description: MCP_DESCRIPTION,
      auth: { type: 'header', headers: { [MCP_TOKEN_HEADER]: token } },
    };
    try {
      await this.request('PUT', '/settings/mcp-servers', { manifest });
    } catch (err) {
      if (err instanceof TrueForgeApiError && /Outbound URL blocked/i.test(err.message)) {
        throw new TrueForgeApiError(
          `TrueForge blocks loopback URLs such as ${url} by default. Restart it with scripts/start-trueforge.sh ` +
            '(sets OUTBOUND_URL_ALLOWED_HOSTS=\'["localhost","127.0.0.1"]\'), then run "Forgelight: Re-register MCP Server and Agent with TrueForge".',
          err.status,
        );
      }
      throw err;
    }

    let lastError = 'it listed no tools';
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const body = await this.request<{ data?: Array<{ name?: unknown }> }>(
          'GET',
          `/mcp-servers/${encodeURIComponent(name)}/tools`,
          undefined,
          15000,
        );
        const tools = (body?.data ?? []).map((t) => t.name).filter((n): n is string => typeof n === 'string');
        if (tools.length > 0) return tools;
        lastError = 'it listed no tools';
      } catch (err) {
        lastError = errorMessage(err);
      }
      await delay(400 * (attempt + 1));
    }
    throw new TrueForgeApiError(
      `TrueForge saved the MCP server "${name}" (${url}) but cannot list its tools: ${lastError}. ` +
        'TrueForge must be started with scripts/start-trueforge.sh so it is allowed to reach 127.0.0.1.',
    );
  }

  /**
   * Create or update the agent (agent/forgelight.agent.json, REST snake_case) so it shows up in
   * the TrueForge UI, with its model set to `modelFqn`. Returns the agent id.
   */
  async registerAgent(definition: AgentDefinition, modelFqn: string): Promise<{ id: string; created: boolean }> {
    const currentModel = definition.manifest.model;
    const manifest = {
      ...definition.manifest,
      model: { ...(currentModel && typeof currentModel === 'object' ? currentModel : {}), name: modelFqn },
    };
    const update = async (id: string) => {
      await this.request('PUT', `/agents/${encodeURIComponent(id)}`, { description: definition.description, manifest });
      return { id, created: false };
    };

    const existing = await this.findAgentId(definition.name);
    if (existing) return update(existing);
    try {
      const body = await this.request<{ data?: { id?: string } }>('POST', '/agents', {
        name: definition.name,
        description: definition.description,
        manifest,
      });
      const id = body?.data?.id;
      if (!id) throw new TrueForgeApiError('TrueForge created the agent but returned no id.');
      return { id, created: true };
    } catch (err) {
      // Lost a race with another registration: fall back to update.
      if (err instanceof TrueForgeApiError && err.status === 409) {
        const id = await this.findAgentId(definition.name);
        if (id) return update(id);
      }
      throw err;
    }
  }

  /**
   * TrueForge web UI page for a session: the "Agent Sessions" trace view (turns, tool calls,
   * sub-agents, approvals, event timeline). `/sessions/:id` is the chat view instead.
   */
  sessionUrl(sessionId: string): string {
    return `${this.baseUrl}/sessions?view=sessions&sessionId=${encodeURIComponent(sessionId)}`;
  }

  /** URL TrueForge currently has registered for an MCP server, or undefined if none. */
  async registeredMcpUrl(name: string = MCP_SERVER_NAME): Promise<string | undefined> {
    try {
      // TrueForge 0.185 returns { data: { name, url, ... } }; older builds nested it under manifest.
      const res = await this.request<{ data?: { url?: string; manifest?: { url?: string } } }>('GET', `/mcp-servers/${encodeURIComponent(name)}`, undefined, 5000);
      return res?.data?.url ?? res?.data?.manifest?.url;
    } catch {
      return undefined;
    }
  }

  /** Create or replace a model provider (POST/PUT /settings/model-providers manifest). */
  async upsertModelProvider(manifest: Record<string, unknown>): Promise<void> {
    await this.request('PUT', '/settings/model-providers', { manifest });
  }

  /** Remove a registered MCP server (ignores "not found"). */
  async removeMcpServer(name: string = MCP_SERVER_NAME): Promise<void> {
    try {
      await this.request('DELETE', `/settings/mcp-servers/${encodeURIComponent(name)}`);
    } catch (err) {
      if (!(err instanceof TrueForgeApiError && err.status === 404)) throw err;
    }
  }

  /** Remove a registered agent by name (no-op when absent). */
  async removeAgent(name: string): Promise<void> {
    const id = await this.findAgentId(name);
    if (id) await this.request('DELETE', `/agents/${encodeURIComponent(id)}`);
  }

  /** Exact-name lookup; the list endpoint filters by substring and is paginated. */
  private async findAgentId(name: string): Promise<string | undefined> {
    let pageToken: string | undefined;
    for (let page = 0; page < 20; page++) {
      const query = new URLSearchParams({ agent_name: name, limit: '100' });
      if (pageToken) query.set('page_token', pageToken);
      const body = await this.request<{
        data?: Array<{ id?: string; name?: string }>;
        pagination?: { next_page_token?: string };
      }>('GET', `/agents?${query}`);
      const hit = (body?.data ?? []).find((a) => a.name === name);
      if (hit?.id) return hit.id;
      pageToken = body?.pagination?.next_page_token;
      if (!pageToken) return undefined;
    }
    return undefined;
  }

  private api(path: string): string {
    return `${this.baseUrl}/api/v1${path}`;
  }

  /** JSON request; errors carry TrueForge's error message but never the request body (it may hold secrets). */
  private async request<T = unknown>(method: string, path: string, body?: unknown, timeoutMs = 15000): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.api(path), {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new TrueForgeApiError(
        `Cannot reach TrueForge at ${this.baseUrl} (${errorMessage(err)}). Start it with scripts/start-trueforge.sh`,
      );
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const apiMessage = (json as { error?: { message?: unknown } } | undefined)?.error?.message;
      const detail = typeof apiMessage === 'string' ? apiMessage : text.slice(0, 300) || res.statusText;
      throw new TrueForgeApiError(`TrueForge ${method} ${path.split('?')[0]} failed (${res.status}): ${detail}`, res.status);
    }
    return json as T;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: { code?: string; message?: string } }).cause;
    const extra = cause?.code ?? cause?.message;
    return extra && !err.message.includes(extra) ? `${err.message}: ${extra}` : err.message;
  }
  return String(err);
}
