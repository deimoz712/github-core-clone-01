// mcp.ts — MCP over Streamable HTTP (Fase 3).
//
// JSON-RPC 2.0, one JSON body per POST (no SSE needed — the suite's client
// accepts a plain JSON answer). Two protocol eras:
//   modern 2026-07-28: `server/discover` returns identity, capabilities and
//           supportedVersions in one request; no handshake, no session.
//   legacy 2025-11-25 and earlier: `initialize` (echo the requested
//           revision) + `notifications/initialized`; no session either.
// Six tools, all on the same in-memory Store as REST, so MCP and REST agree
// on every object: create_repo, get_repo, create_issue, list_issues,
// create_pull_request, merge_pull_request.
// Errors: unknown tool -32602, missing required arguments -32602,
// malformed JSON body is answered by app.ts as HTTP 400 + -32700.
// tools/list is a static array, so two calls are byte-identical.

import { Store, repoJson, issueJson, pullJson } from './store.ts';
import { VIEWER } from './scenario.ts';

export interface McpAnswer {
  status: number;
  json?: unknown;
  /** 202-style answer: headers only, no body (notifications). */
  empty?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOL_REQUIRED: Record<string, string[]> = {};
for (const tool of TOOLS) {
  const schema = tool.inputSchema;
  TOOL_REQUIRED[tool.name] = Array.isArray(schema.required) ? (schema.required as string[]) : [];
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

function okResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === 'string' ? value : '';
}

function numberArg(args: Record<string, unknown>, name: string): number | null {
  const value = args[name];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolResult {
  switch (name) {
    case 'create_repo': {
      const repoName = stringArg(args, 'name');
      if (repoName === '') return errorResult('create_repo: name is required');
      const repo = store.createRepo(
        VIEWER.login,
        repoName,
        typeof args.private === 'boolean' ? args.private : false,
        stringArg(args, 'description'),
      );
      if (repo === null) return errorResult(`create_repo: repository ${VIEWER.login}/${repoName} already exists`);
      return okResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = store.getRepo(stringArg(args, 'owner'), stringArg(args, 'repo'));
      if (repo === undefined) return errorResult(`get_repo: repository ${stringArg(args, 'owner')}/${stringArg(args, 'repo')} not found`);
      return okResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = store.getRepo(stringArg(args, 'owner'), stringArg(args, 'repo'));
      if (repo === undefined) return errorResult(`create_issue: repository ${stringArg(args, 'owner')}/${stringArg(args, 'repo')} not found`);
      const title = stringArg(args, 'title');
      const body = stringArg(args, 'body');
      const number = repo.nextNumber++;
      const issue = {
        id: store.nextGlobalId++,
        number,
        title,
        body,
        state: 'open' as const,
        labels: [],
        userLogin: VIEWER.login,
        createdAt: repo.createdAt,
        updatedAt: repo.createdAt,
        comments: [],
      };
      repo.issues.set(number, issue);
      return okResult(issueJson(issue, repo));
    }
    case 'list_issues': {
      const repo = store.getRepo(stringArg(args, 'owner'), stringArg(args, 'repo'));
      if (repo === undefined) return errorResult(`list_issues: repository ${stringArg(args, 'owner')}/${stringArg(args, 'repo')} not found`);
      const state = stringArg(args, 'state') || 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => b.number - a.number);
      const json = issues.map((issue) => issueJson(issue, repo));
      return { content: [{ type: 'text', text: JSON.stringify(json) }], structuredContent: { issues: json } };
    }
    case 'create_pull_request': {
      const repo = store.getRepo(stringArg(args, 'owner'), stringArg(args, 'repo'));
      if (repo === undefined) return errorResult(`create_pull_request: repository ${stringArg(args, 'owner')}/${stringArg(args, 'repo')} not found`);
      const head = stringArg(args, 'head');
      const base = stringArg(args, 'base');
      const headSha = repo.branchTip(head);
      const baseSha = repo.branchTip(base);
      if (headSha === null || baseSha === null) return errorResult(`create_pull_request: invalid head or base branch (${head} -> ${base})`);
      const number = repo.nextNumber++;
      const pr = {
        id: store.nextGlobalId++,
        number,
        title: stringArg(args, 'title'),
        body: stringArg(args, 'body'),
        state: 'open' as const,
        headRef: head,
        headSha,
        baseRef: base,
        baseSha,
        merged: false,
        mergedAt: null as string | null,
        mergeCommitSha: null as string | null,
        userLogin: VIEWER.login,
        createdAt: repo.createdAt,
        updatedAt: repo.createdAt,
      };
      repo.pulls.set(number, pr);
      return okResult(pullJson(pr, repo));
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(stringArg(args, 'owner'), stringArg(args, 'repo'));
      if (repo === undefined) return errorResult(`merge_pull_request: repository ${stringArg(args, 'owner')}/${stringArg(args, 'repo')} not found`);
      const number = numberArg(args, 'pull_number');
      if (number === null) return errorResult('merge_pull_request: pull_number is required');
      const pr = repo.pulls.get(number);
      if (pr === undefined) return errorResult(`merge_pull_request: pull request #${number} not found`);
      const result = repo.mergePull(pr);
      if (result.status !== 200) return errorResult(`merge_pull_request: ${result.message}`);
      return okResult({ merged: true, sha: result.sha, message: result.message, number: pr.number, state: pr.state });
    }
    default:
      return errorResult(`unknown tool: ${name}`);
  }
}

function rpcError(id: unknown, code: number, message: string): McpAnswer {
  return { status: 200, json: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function rpcResult(id: unknown, result: unknown): McpAnswer {
  return { status: 200, json: { jsonrpc: '2.0', id: id ?? null, result } };
}

function handleRequest(body: Record<string, unknown>, store: Store): McpAnswer {
  const id = 'id' in body ? body.id : undefined;
  const method = body.method;
  if (typeof method !== 'string' || method === '') {
    return { status: 400, json: { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid Request: missing method' } } };
  }
  // A JSON-RPC notification (no id): no response body, HTTP 202.
  if (id === undefined) {
    return { status: 202, empty: true };
  }
  const params = isRecord(body.params) ? (body.params as Record<string, unknown>) : {};
  switch (method) {
    case 'server/discover': {
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      });
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'tools/list': {
      return rpcResult(id, { tools: TOOLS });
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      const known = TOOLS.some((tool) => tool.name === name);
      if (!known) {
        return rpcError(id, -32602, `Unknown tool: ${name}`);
      }
      const required = TOOL_REQUIRED[name] ?? [];
      const missing = required.filter((field) => args[field] === undefined || args[field] === null || args[field] === '');
      if (missing.length > 0) {
        return rpcError(id, -32602, `Missing required argument(s): ${missing.join(', ')}`);
      }
      return rpcResult(id, callTool(store, name, args));
    }
    case 'ping':
      return rpcResult(id, {});
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/**
 * Handle one POST /mcp body (already JSON-parsed by app.ts; a malformed
 * body is answered there as HTTP 400 + -32700). A JSON array is a batch:
 * each element is answered in order.
 */
export function handleMcp(body: unknown, store: Store): McpAnswer {
  if (Array.isArray(body)) {
    const answers = body.map((entry) => {
      if (!isRecord(entry)) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
      const answer = handleRequest(entry, store);
      return answer.json ?? null;
    });
    return { status: 200, json: answers };
  }
  if (!isRecord(body)) {
    return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: expected a JSON-RPC object' } } };
  }
  return handleRequest(body, store);
}
