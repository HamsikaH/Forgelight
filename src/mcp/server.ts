/**
 * Loopback MCP server exposing the editor tools to TrueForge (PURE: no vscode).
 *
 * Stateless streamable HTTP: a fresh McpServer + transport per POST, JSON responses, and a
 * per-start shared secret in the MCP_TOKEN_HEADER header.
 */
import { randomBytes, timingSafeEqual, webcrypto } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { MCP_SERVER_NAME, MCP_TOKEN_HEADER } from '../contracts';
import { registerEditorTools, type EditorToolDeps } from './tools';

// The SDK transport calls the Web Crypto global (crypto.randomUUID), which Node 18 (the
// VS Code 1.84 extension host) does not define; every request would fail with a parse error.
const g = globalThis as { crypto?: unknown };
if (!g.crypto) g.crypto = webcrypto;

export type EditorMcpServerDeps = EditorToolDeps;

export interface EditorMcpEndpoint {
  url: string;
  token: string;
  port: number;
}

const MCP_PATH = '/mcp';
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const SERVER_VERSION = '0.1.0';

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function sendJsonRpcError(res: http.ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

function tokenMatches(header: string | string[] | undefined, token: string): boolean {
  const got = Buffer.from(Array.isArray(header) ? (header[0] ?? '') : (header ?? ''));
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large.');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

export class EditorMcpServer {
  private server: http.Server | undefined;
  private endpoint: EditorMcpEndpoint | undefined;

  constructor(private readonly deps: EditorMcpServerDeps) {}

  /** The endpoint while running, otherwise undefined. */
  get current(): EditorMcpEndpoint | undefined {
    return this.endpoint;
  }

  /** Listen on 127.0.0.1:preferredPort, or on a free port if that is busy or 0. Idempotent. */
  async start(preferredPort: number): Promise<EditorMcpEndpoint> {
    if (this.endpoint) return this.endpoint;
    const token = randomBytes(24).toString('hex');
    const create = () => http.createServer((req, res) => void this.handle(req, res, token));

    let server = create();
    let port: number;
    if (preferredPort > 0) {
      try {
        port = await listen(server, preferredPort);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== 'EADDRINUSE' && code !== 'EACCES') throw e;
        server = create();
        port = await listen(server, 0);
      }
    } else {
      port = await listen(server, 0);
    }
    this.server = server;
    this.endpoint = { url: `http://127.0.0.1:${port}${MCP_PATH}`, token, port };
    return this.endpoint;
  }

  /** Stop listening and drop open connections (in-flight tool calls are abandoned). */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.endpoint = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private buildMcpServer(): McpServer {
    const mcp = new McpServer({ name: MCP_SERVER_NAME, version: SERVER_VERSION });
    registerEditorTools(mcp, this.deps);
    return mcp;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse, token: string): Promise<void> {
    try {
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (pathname !== MCP_PATH) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
      if (!tokenMatches(req.headers[MCP_TOKEN_HEADER.toLowerCase()], token)) {
        res.writeHead(401, { 'Content-Type': 'text/plain' }).end('Unauthorized');
        return;
      }
      if (req.method !== 'POST') {
        // Stateless server: no standalone SSE stream (GET) and no sessions to delete (DELETE).
        sendJsonRpcError(res, 405, -32000, 'Method not allowed.', { Allow: 'POST' });
        return;
      }
      const body = await readBody(req);
      let parsed: unknown;
      try {
        parsed = body ? JSON.parse(body) : undefined;
      } catch {
        sendJsonRpcError(res, 400, -32700, 'Parse error: invalid JSON.');
        return;
      }
      const mcp = this.buildMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, parsed);
    } catch (e) {
      if (e instanceof HttpError) sendJsonRpcError(res, e.status, -32600, e.message);
      else sendJsonRpcError(res, 500, -32603, 'Internal server error.');
    }
  }
}
