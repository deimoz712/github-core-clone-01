// graphql.ts — GraphQL v4 executor (Fase 3).
//
// A minimal executor for exactly the 18 documents in
// kit/program/env/src/checks-graphql.ts: no schema library, no network.
// It parses the small GraphQL subset those documents use (operations,
// variables, aliases, inline input objects/lists/enums, inline fragments
// `... on Type`, `__type` introspection) and resolves them against the
// same in-memory Store the REST surface uses, so every mutation is visible
// over REST and every read agrees with it.
//
// Global ids are opaque and stable: base64url of `Kind:payload`
// (Repository:owner/name, Issue:owner/name#number,
// PullRequest:owner/name#number, IssueComment:owner/name#number:commentId).
// Unknown fields are GraphQL errors (HTTP 200 + errors[] naming the field),
// never HTTP errors; an unknown repository reads data.repository = null
// with no errors. Batched operations (a JSON array body) answer an array
// of per-operation envelopes in order.

import { Store, Repo, FIXED_ISO, type Issue, type PullRequest } from './store.ts';
import { VIEWER } from './scenario.ts';
import { parseCommit } from './git-objects.ts';
import { HttpError } from './rest.ts';

export interface GraphqlAnswer {
  status: number;
  json: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Global ids
// ---------------------------------------------------------------------------

export function encodeGlobalId(kind: string, payload: string): string {
  return Buffer.from(`${kind}:${payload}`, 'utf8').toString('base64url');
}

export function decodeGlobalId(id: unknown): { kind: string; payload: string } | null {
  if (typeof id !== 'string' || id === '') return null;
  let decoded: string;
  try {
    decoded = Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  // Canonical-form check: reject non-canonical base64url spellings.
  if (Buffer.from(decoded, 'utf8').toString('base64url') !== id) return null;
  const colon = decoded.indexOf(':');
  if (colon <= 0) return null;
  return { kind: decoded.slice(0, colon), payload: decoded.slice(colon + 1) };
}

function repoGlobalId(repo: Repo): string {
  return encodeGlobalId('Repository', repo.fullName);
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return encodeGlobalId('Issue', `${repo.fullName}#${issue.number}`);
}

function pullGlobalId(repo: Repo, pr: PullRequest): string {
  return encodeGlobalId('PullRequest', `${repo.fullName}#${pr.number}`);
}

function commentGlobalId(repo: Repo, issueNumber: number, commentId: number): string {
  return encodeGlobalId('IssueComment', `${repo.fullName}#${issueNumber}:${commentId}`);
}

function repoFromGlobalId(store: Store, id: unknown): Repo | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Repository') return null;
  const slash = decoded.payload.indexOf('/');
  if (slash <= 0) return null;
  return store.getRepo(decoded.payload.slice(0, slash), decoded.payload.slice(slash + 1)) ?? null;
}

function issueFromGlobalId(store: Store, id: unknown): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Issue') return null;
  const hash = decoded.payload.lastIndexOf('#');
  if (hash <= 0) return null;
  const fullName = decoded.payload.slice(0, hash);
  const number = Number.parseInt(decoded.payload.slice(hash + 1), 10);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  const slash = fullName.indexOf('/');
  if (slash <= 0) return null;
  const repo = store.getRepo(fullName.slice(0, slash), fullName.slice(slash + 1));
  if (repo === undefined) return null;
  const issue = repo.issues.get(number);
  if (issue === undefined) return null;
  return { repo, issue };
}

function pullFromGlobalId(store: Store, id: unknown): { repo: Repo; pr: PullRequest } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'PullRequest') return null;
  const hash = decoded.payload.lastIndexOf('#');
  if (hash <= 0) return null;
  const fullName = decoded.payload.slice(0, hash);
  const number = Number.parseInt(decoded.payload.slice(hash + 1), 10);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  const slash = fullName.indexOf('/');
  if (slash <= 0) return null;
  const repo = store.getRepo(fullName.slice(0, slash), fullName.slice(slash + 1));
  if (repo === undefined) return null;
  const pr = repo.pulls.get(number);
  if (pr === undefined) return null;
  return { repo, pr };
}

// ---------------------------------------------------------------------------
// Tokenizer + parser for the small GraphQL subset the 18 documents use.
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && text.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if (ch === '"') {
      let out = '';
      i += 1;
      while (i < text.length && text[i] !== '"') {
        const c = text[i] as string;
        if (c === '\\' && i + 1 < text.length) {
          const esc = text[i + 1] as string;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'u' && i + 5 < text.length) {
            out += String.fromCharCode(Number.parseInt(text.slice(i + 2, i + 6), 16));
            i += 4;
          } else out += esc;
          i += 2;
          continue;
        }
        out += c;
        i += 1;
      }
      i += 1; // closing quote
      tokens.push({ kind: 'string', value: out });
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(text[i + 1] ?? ''))) {
      let j = i;
      if (text[j] === '-') j += 1;
      while (j < text.length && /[0-9]/.test(text[j] as string)) j += 1;
      let isFloat = false;
      if (text[j] === '.' && /[0-9]/.test(text[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < text.length && /[0-9]/.test(text[j] as string)) j += 1;
      }
      if (text[j] === 'e' || text[j] === 'E') {
        isFloat = true;
        j += 1;
        if (text[j] === '+' || text[j] === '-') j += 1;
        while (j < text.length && /[0-9]/.test(text[j] as string)) j += 1;
      }
      const raw = text.slice(i, j);
      void isFloat;
      tokens.push({ kind: 'number', value: Number(raw) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < text.length && /[_0-9A-Za-z]/.test(text[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: text.slice(i, j) });
      i = j;
      continue;
    }
    if ('{}()[]:$!=@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'literal'; value: unknown };

interface FieldSelection {
  kind: 'field';
  alias: string;
  name: string;
  args: Record<string, ValueNode>;
  selections: Selection[];
}

interface FragmentSelection {
  kind: 'fragment';
  typeCondition: string | null;
  selections: Selection[];
}

type Selection = FieldSelection | FragmentSelection;

interface Operation {
  type: 'query' | 'mutation';
  selections: Selection[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected "${value}" in GraphQL document, got ${token.kind} ${'value' in token ? token.value : ''}`);
    }
  }

  private peekPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name in GraphQL document, got ${token.kind}`);
    return token.value;
  }

  parseDocument(): Operation {
    let type: 'query' | 'mutation' = 'query';
    const first = this.peek();
    if (first !== undefined && first.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      type = this.next().value as 'query' | 'mutation';
      const maybeName = this.peek();
      if (maybeName !== undefined && maybeName.kind === 'name') this.next(); // operation name
      if (this.peekPunct('(')) this.skipVariableDefinitions();
    }
    const selections = this.parseSelectionSet();
    return { type, selections };
  }

  /** Skip `($x: Type!, ...)` — types are not needed to execute these documents. */
  private skipVariableDefinitions(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      else if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.peekPunct('}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    const token = this.peek();
    if (token !== undefined && token.kind === 'spread') {
      this.next();
      let typeCondition: string | null = null;
      const on = this.peek();
      if (on !== undefined && on.kind === 'name' && on.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias = first;
    let name = first;
    if (this.peekPunct(':')) {
      this.next();
      name = this.expectName();
    }
    const args: Record<string, ValueNode> = {};
    if (this.peekPunct('(')) {
      this.next();
      while (!this.peekPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
      this.expectPunct(')');
    }
    let selections: Selection[] = [];
    if (this.peekPunct('{')) selections = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selections };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: unknown[] = [];
      while (!this.peekPunct(']')) {
        const item = this.parseValue();
        if (item.kind === 'variable') throw new Error('variables inside a list literal are not supported');
        items.push(item.value);
      }
      this.expectPunct(']');
      return { kind: 'literal', value: items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const object: Record<string, unknown> = {};
      while (!this.peekPunct('}')) {
        const key = this.expectName();
        this.expectPunct(':');
        const value = this.parseValue();
        if (value.kind === 'variable') throw new Error('variables inside an object literal are not supported');
        object[key] = value.value;
      }
      this.expectPunct('}');
      return { kind: 'literal', value: object };
    }
    if (token.kind === 'string' || token.kind === 'number') {
      return { kind: 'literal', value: token.value };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'literal', value: true };
      if (token.value === 'false') return { kind: 'literal', value: false };
      if (token.value === 'null') return { kind: 'literal', value: null };
      return { kind: 'literal', value: token.value }; // enum value
    }
    throw new Error(`unexpected token ${token.kind} as a GraphQL value`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  if (node.kind === 'variable') return variables[node.name];
  return node.value;
}

function resolveArgs(args: Record<string, ValueNode>, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, node] of Object.entries(args)) out[key] = resolveValue(node, variables);
  return out;
}

// ---------------------------------------------------------------------------
// Introspection tables
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  IssueConnection: ['nodes', 'pageInfo'],
  PullRequest: ['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'title', 'body'],
  PullRequestConnection: ['nodes'],
  PullRequestChangedFile: ['path'],
  PullRequestChangedFileConnection: ['nodes'],
  PageInfo: ['hasNextPage', 'endCursor'],
  Ref: ['name'],
  __Type: ['name', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  IssueCommentEdge: ['node'],
  IssueComment: ['id', 'body'],
};

const SEARCH_TYPE_ENUM_VALUES = [
  'ISSUE', 'PR', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'WIKI', 'MARKETPLACE', 'TOPIC', 'ORGANIZATION', 'PROJECT', 'REGISTRY',
];

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface Ctx {
  store: Store;
  errors: Array<{ message: string; path?: Array<string | number> }>;
}

interface Source {
  __typename: string;
  repo?: Repo;
  issue?: Issue;
  pr?: PullRequest;
  items?: unknown[];
  pageInfo?: { hasNextPage: boolean; endCursor: string | null };
  login?: string;
  typeName?: string;
  commentId?: number;
  commentBody?: string;
  issueNumber?: number;
  payload?: Source | null;
}

function wrapRepo(repo: Repo): Source {
  return { __typename: 'Repository', repo };
}

function wrapIssue(repo: Repo, issue: Issue): Source {
  return { __typename: 'Issue', repo, issue };
}

function wrapPull(repo: Repo, pr: PullRequest): Source {
  return { __typename: 'PullRequest', repo, pr };
}

function resolveObject(typename: string, source: Source, selections: Selection[], ctx: Ctx, path: Array<string | number>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition === null || selection.typeCondition === typename) {
        Object.assign(out, resolveObject(typename, source, selection.selections, ctx, path));
      }
      continue;
    }
    const known = TYPE_FIELDS[typename] ?? [];
    if (!known.includes(selection.name)) {
      ctx.errors.push({
        message: `Cannot query field "${selection.name}" on type "${typename}".`,
        path: [...path, selection.alias],
      });
      out[selection.alias] = null;
      continue;
    }
    out[selection.alias] = resolveField(typename, source, selection, ctx, [...path, selection.alias]);
  }
  return out;
}

function resolveField(typename: string, source: Source, selection: FieldSelection, ctx: Ctx, path: Array<string | number>): unknown {
  const args = resolveArgs(selection.args, ctxVariables(ctx));
  switch (typename) {
    case 'User':
      return source.login ?? null;
    case 'Repository':
      return resolveRepositoryField(source.repo as Repo, selection, args, ctx, path);
    case 'Issue':
      return resolveIssueField(source.repo as Repo, source.issue as Issue, selection);
    case 'IssueConnection':
    case 'PullRequestConnection': {
      if (selection.name === 'nodes') {
        const items = source.items ?? [];
        const elementType = typename === 'IssueConnection' ? 'Issue' : 'PullRequest';
        return items.map((item) => {
          const wrapped = elementType === 'Issue'
            ? wrapIssue(source.repo as Repo, item as Issue)
            : wrapPull(source.repo as Repo, item as PullRequest);
          return resolveObject(elementType, wrapped, selection.selections, ctx, path);
        });
      }
      if (selection.name === 'pageInfo') {
        return resolveObject('PageInfo', { __typename: 'PageInfo', pageInfo: source.pageInfo }, selection.selections, ctx, path);
      }
      return null;
    }
    case 'PullRequest':
      return resolvePullRequestField(source.repo as Repo, source.pr as PullRequest, selection, args, ctx, path);
    case 'PullRequestChangedFileConnection': {
      if (selection.name === 'nodes') {
        const items = (source.items ?? []) as Array<{ path: string }>;
        return items.map((item) => resolveObject('PullRequestChangedFile', { __typename: 'PullRequestChangedFile', path: item.path } as unknown as Source, selection.selections, ctx, path));
      }
      return null;
    }
    case 'PullRequestChangedFile':
      return (source as unknown as { path: string }).path ?? null;
    case 'PageInfo':
      return source.pageInfo?.[selection.name as 'hasNextPage' | 'endCursor'] ?? null;
    case 'Ref':
      return (source as unknown as { name: string }).name ?? null;
    case '__Type':
      return resolveTypeField(source.typeName as string, selection, ctx, path);
    case '__Field':
    case '__EnumValue':
      return (source as unknown as { name: string }).name ?? null;
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
      return source.payload === undefined || source.payload === null
        ? null
        : resolveObject('Issue', source.payload, selection.selections, ctx, path);
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
      return source.payload === undefined || source.payload === null
        ? null
        : resolveObject('PullRequest', source.payload, selection.selections, ctx, path);
    case 'AddCommentPayload':
      if (selection.name === 'commentEdge') {
        return resolveObject('IssueCommentEdge', { __typename: 'IssueCommentEdge', repo: source.repo, issueNumber: source.issueNumber, commentId: source.commentId, commentBody: source.commentBody }, selection.selections, ctx, path);
      }
      return null;
    case 'IssueCommentEdge':
      if (selection.name === 'node') {
        return resolveObject('IssueComment', { __typename: 'IssueComment', repo: source.repo, issueNumber: source.issueNumber, commentId: source.commentId, commentBody: source.commentBody }, selection.selections, ctx, path);
      }
      return null;
    case 'IssueComment':
      if (selection.name === 'id') return commentGlobalId(source.repo as Repo, source.issueNumber as number, source.commentId as number);
      if (selection.name === 'body') return source.commentBody ?? null;
      return null;
    default:
      return null;
  }
}

// Variables live on the execution context through a module-level slot set per
// operation; resolution is synchronous, so this is safe.
let currentVariables: Record<string, unknown> = {};

function ctxVariables(_ctx: Ctx): Record<string, unknown> {
  return currentVariables;
}

function resolveTypeField(typeName: string, selection: FieldSelection, ctx: Ctx, path: Array<string | number>): unknown {
  if (selection.name === 'name') return typeName;
  if (selection.name === 'fields') {
    const fields = TYPE_FIELDS[typeName];
    if (fields === undefined) return null;
    return fields.map((name) => resolveObject('__Field', { __typename: '__Field', name } as unknown as Source, selection.selections, ctx, path));
  }
  if (selection.name === 'enumValues') {
    if (typeName !== 'SearchType') return null;
    return SEARCH_TYPE_ENUM_VALUES.map((name) => resolveObject('__EnumValue', { __typename: '__EnumValue', name } as unknown as Source, selection.selections, ctx, path));
  }
  return null;
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pr: PullRequest): string {
  if (pr.merged) return 'MERGED';
  return pr.state === 'open' ? 'OPEN' : 'CLOSED';
}

/** MERGEABLE / CONFLICTING / UNKNOWN, computed without mutating anything. */
function mergeableOf(repo: Repo, pr: PullRequest): string {
  const headTip = repo.branchTip(pr.headRef);
  const baseTip = repo.branchTip(pr.baseRef);
  if (headTip === null || baseTip === null) return 'UNKNOWN';
  const base = repo.objects.mergeBase(headTip, baseTip);
  if (base === null) return 'UNKNOWN';
  try {
    const baseTree = parseCommit(repo.objects.get(base)?.data as Buffer).tree;
    const headTree = parseCommit(repo.objects.get(headTip)?.data as Buffer).tree;
    const baseTipTree = parseCommit(repo.objects.get(baseTip)?.data as Buffer).tree;
    const headDiff = repo.objects.diffTrees(baseTree, headTree);
    const baseDiff = repo.objects.diffTrees(baseTree, baseTipTree);
    for (const [path, headOid] of headDiff) {
      if (baseDiff.has(path) && baseDiff.get(path) !== headOid) return 'CONFLICTING';
    }
    return 'MERGEABLE';
  } catch {
    return 'UNKNOWN';
  }
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (Buffer.from(decoded, 'utf8').toString('base64url') !== cursor) return null;
  const match = /^cursor:(\d+)$/.exec(decoded);
  if (match === null) return null;
  return Number(match[1]);
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): Source {
  let list = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states as string[]);
    list = list.filter((issue) => wanted.has(issueState(issue)));
  }
  const orderBy = isRecord(args.orderBy) ? (args.orderBy as Record<string, unknown>) : null;
  const direction = orderBy?.direction === 'ASC' ? 'ASC' : 'DESC';
  // created_at is one fixed timestamp for every issue, so ordering is by
  // number; ties break by number in the same direction.
  list.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  const after = decodeCursor(args.after);
  if (after !== null) {
    list = list.filter((issue) => (direction === 'ASC' ? issue.number > after : issue.number < after));
  }
  const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.floor(args.first)) : list.length;
  const page = list.slice(0, first);
  const hasNextPage = list.length > page.length;
  const endCursor = page.length === 0 ? null : encodeCursor(page[page.length - 1]?.number as number);
  return { __typename: 'IssueConnection', repo, items: page, pageInfo: { hasNextPage, endCursor } };
}

function resolveRepositoryField(repo: Repo, selection: FieldSelection, args: Record<string, unknown>, ctx: Ctx, path: Array<string | number>): unknown {
  switch (selection.name) {
    case 'id':
      return repoGlobalId(repo);
    case 'databaseId':
      return repo.id;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return repo.fullName;
    case 'owner':
      return resolveObject('User', { __typename: 'User', login: repo.owner }, selection.selections, ctx, path);
    case 'defaultBranchRef':
      return resolveObject('Ref', { __typename: 'Ref', name: repo.defaultBranch } as unknown as Source, selection.selections, ctx, path);
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
      return true;
    case 'issue': {
      const number = args.number;
      if (typeof number !== 'number') return null;
      const issue = repo.issues.get(number);
      if (issue === undefined) return null;
      return resolveObject('Issue', wrapIssue(repo, issue), selection.selections, ctx, path);
    }
    case 'issues': {
      const connection = issuesConnection(repo, args);
      return resolveObject('IssueConnection', connection, selection.selections, ctx, path);
    }
    case 'pullRequests': {
      const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.floor(args.first)) : undefined;
      let pulls = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
      if (first !== undefined) pulls = pulls.slice(0, first);
      const connection: Source = { __typename: 'PullRequestConnection', repo, items: pulls };
      return resolveObject('PullRequestConnection', connection, selection.selections, ctx, path);
    }
    case 'pullRequest': {
      const number = args.number;
      if (typeof number !== 'number') return null;
      const pr = repo.pulls.get(number);
      if (pr === undefined) return null;
      return resolveObject('PullRequest', wrapPull(repo, pr), selection.selections, ctx, path);
    }
    default:
      return null;
  }
}

function resolveIssueField(repo: Repo, issue: Issue, selection: FieldSelection): unknown {
  switch (selection.name) {
    case 'id':
      return issueGlobalId(repo, issue);
    case 'number':
      return issue.number;
    case 'title':
      return issue.title;
    case 'state':
      return issueState(issue);
    case 'body':
      return issue.body;
    default:
      return null;
  }
}

function resolvePullRequestField(repo: Repo, pr: PullRequest, selection: FieldSelection, args: Record<string, unknown>, ctx: Ctx, path: Array<string | number>): unknown {
  switch (selection.name) {
    case 'id':
      return pullGlobalId(repo, pr);
    case 'number':
      return pr.number;
    case 'title':
      return pr.title;
    case 'body':
      return pr.body;
    case 'state':
      return pullState(pr);
    case 'merged':
      return pr.merged;
    case 'headRefName':
      return pr.headRef;
    case 'baseRefName':
      return pr.baseRef;
    case 'mergeable':
      return mergeableOf(repo, pr);
    case 'files': {
      const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.floor(args.first)) : undefined;
      let files = repo.pullFiles(pr).map((file) => ({ path: file.filename }));
      if (first !== undefined) files = files.slice(0, first);
      const connection: Source = { __typename: 'PullRequestChangedFileConnection', repo, items: files };
      return resolveObject('PullRequestChangedFileConnection', connection, selection.selections, ctx, path);
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Mutations (same store writes as REST, so every surface agrees).
// ---------------------------------------------------------------------------

function createIssueInRepo(store: Store, repo: Repo, title: string, body: string): Issue {
  const number = repo.nextNumber++;
  const issue: Issue = {
    id: store.nextGlobalId++,
    number,
    title,
    body,
    state: 'open',
    labels: [],
    userLogin: VIEWER.login,
    createdAt: issueCreatedAt(),
    updatedAt: issueCreatedAt(),
    comments: [],
  };
  repo.issues.set(number, issue);
  return issue;
}

function issueCreatedAt(): string {
  return FIXED_ISO;
}

function createPullInRepo(repo: Repo, store: Store, title: string, head: string, base: string): PullRequest | null {
  const headSha = repo.branchTip(head);
  const baseSha = repo.branchTip(base);
  if (headSha === null || baseSha === null) return null;
  const number = repo.nextNumber++;
  const pr: PullRequest = {
    id: store.nextGlobalId++,
    number,
    title,
    body: '',
    state: 'open',
    headRef: head,
    headSha,
    baseRef: base,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    userLogin: VIEWER.login,
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
  };
  repo.pulls.set(number, pr);
  return pr;
}

function executeMutation(ctx: Ctx, selection: FieldSelection, path: Array<string | number>): unknown {
  const args = resolveArgs(selection.args, currentVariables);
  const input = isRecord(args.input) ? (args.input as Record<string, unknown>) : {};
  switch (selection.name) {
    case 'createIssue': {
      const repo = repoFromGlobalId(ctx.store, input.repositoryId);
      if (repo === null) {
        ctx.errors.push({ message: 'createIssue: repository not found', path });
        return null;
      }
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const issue = createIssueInRepo(ctx.store, repo, title, body);
      return resolveObject('CreateIssuePayload', { __typename: 'CreateIssuePayload', payload: wrapIssue(repo, issue) }, selection.selections, ctx, path);
    }
    case 'closeIssue': {
      const found = issueFromGlobalId(ctx.store, input.issueId);
      if (found === null) {
        ctx.errors.push({ message: 'closeIssue: issue not found', path });
        return null;
      }
      found.issue.state = 'closed';
      return resolveObject('CloseIssuePayload', { __typename: 'CloseIssuePayload', payload: wrapIssue(found.repo, found.issue) }, selection.selections, ctx, path);
    }
    case 'createPullRequest': {
      const repo = repoFromGlobalId(ctx.store, input.repositoryId);
      if (repo === null) {
        ctx.errors.push({ message: 'createPullRequest: repository not found', path });
        return null;
      }
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const title = typeof input.title === 'string' ? input.title : '';
      const pr = createPullInRepo(repo, ctx.store, title, head, base);
      if (pr === null) {
        ctx.errors.push({ message: 'createPullRequest: invalid head or base branch', path });
        return null;
      }
      return resolveObject('CreatePullRequestPayload', { __typename: 'CreatePullRequestPayload', payload: wrapPull(repo, pr) }, selection.selections, ctx, path);
    }
    case 'mergePullRequest': {
      const found = pullFromGlobalId(ctx.store, input.pullRequestId);
      if (found === null) {
        ctx.errors.push({ message: 'mergePullRequest: pull request not found', path });
        return null;
      }
      const result = found.repo.mergePull(found.pr);
      if (result.status !== 200) {
        ctx.errors.push({ message: `mergePullRequest: ${result.message}`, path });
        return null;
      }
      return resolveObject('MergePullRequestPayload', { __typename: 'MergePullRequestPayload', payload: wrapPull(found.repo, found.pr) }, selection.selections, ctx, path);
    }
    case 'addComment': {
      const found = issueFromGlobalId(ctx.store, input.subjectId);
      if (found === null) {
        ctx.errors.push({ message: 'addComment: subject not found', path });
        return null;
      }
      const body = typeof input.body === 'string' ? input.body : '';
      const commentId = found.repo.nextCommentId++;
      found.issue.comments.push({ id: commentId, body, userLogin: VIEWER.login, createdAt: FIXED_ISO, updatedAt: FIXED_ISO });
      const payload: Source = {
        __typename: 'AddCommentPayload',
        repo: found.repo,
        issueNumber: found.issue.number,
        commentId,
        commentBody: body,
      };
      return resolveObject('AddCommentPayload', payload, selection.selections, ctx, path);
    }
    default:
      return null;
  }
}

function executeRoot(ctx: Ctx, operation: Operation, variables: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const resolveRootSelections = (selections: Selection[], path: Array<string | number>): void => {
    for (const selection of selections) {
      if (selection.kind === 'fragment') {
        if (selection.typeCondition === null || selection.typeCondition === rootType) {
          resolveRootSelections(selection.selections, path);
        }
        continue;
      }
      const known = TYPE_FIELDS[rootType] ?? [];
      const fieldPath = [...path, selection.alias];
      if (!known.includes(selection.name)) {
        ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${rootType}".`, path: fieldPath });
        data[selection.alias] = null;
        continue;
      }
      data[selection.alias] = resolveRootField(ctx, operation, selection, variables, fieldPath);
    }
  };
  resolveRootSelections(operation.selections, []);
  return data;
}

function resolveRootField(ctx: Ctx, operation: Operation, selection: FieldSelection, variables: Record<string, unknown>, path: Array<string | number>): unknown {
  const args = resolveArgs(selection.args, variables);
  if (operation.type === 'mutation') {
    return executeMutation(ctx, selection, path);
  }
  switch (selection.name) {
    case 'viewer':
      return resolveObject('User', { __typename: 'User', login: VIEWER.login }, selection.selections, ctx, path);
    case 'repository': {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      const repo = ctx.store.getRepo(owner, name);
      if (repo === undefined) return null;
      return resolveObject('Repository', wrapRepo(repo), selection.selections, ctx, path);
    }
    case 'node': {
      const decoded = decodeGlobalId(args.id);
      if (decoded === null) return null;
      if (decoded.kind === 'Repository') {
        const repo = repoFromGlobalId(ctx.store, args.id);
        if (repo === null) return null;
        return resolveObject('Repository', wrapRepo(repo), selection.selections, ctx, path);
      }
      if (decoded.kind === 'Issue') {
        const found = issueFromGlobalId(ctx.store, args.id);
        if (found === null) return null;
        return resolveObject('Issue', wrapIssue(found.repo, found.issue), selection.selections, ctx, path);
      }
      if (decoded.kind === 'PullRequest') {
        const found = pullFromGlobalId(ctx.store, args.id);
        if (found === null) return null;
        return resolveObject('PullRequest', wrapPull(found.repo, found.pr), selection.selections, ctx, path);
      }
      return null;
    }
    case '__type': {
      const name = typeof args.name === 'string' ? args.name : '';
      if (!(name in TYPE_FIELDS) && name !== 'SearchType') return null;
      return resolveObject('__Type', { __typename: '__Type', typeName: name }, selection.selections, ctx, path);
    }
    default:
      return null;
  }
}

function executeOne(body: Record<string, unknown>, store: Store): Record<string, unknown> {
  const query = body.query;
  if (typeof query !== 'string' || query === '') {
    throw new HttpError(400, 'query must be a non-empty string');
  }
  const variables = isRecord(body.variables) ? (body.variables as Record<string, unknown>) : {};
  let operation: Operation;
  try {
    operation = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
  }
  currentVariables = variables;
  try {
    const ctx: Ctx = { store, errors: [] };
    const data = executeRoot(ctx, operation, variables);
    const out: Record<string, unknown> = { data };
    if (ctx.errors.length > 0) out.errors = ctx.errors;
    return out;
  } finally {
    currentVariables = {};
  }
}

/** Execute one operation or a batched array of operations. */
export function handleGraphql(body: Record<string, unknown> | Array<Record<string, unknown>> | undefined, store: Store): GraphqlAnswer {
  if (body === undefined) throw new HttpError(400, 'Request body must be a JSON object');
  if (Array.isArray(body)) {
    return { status: 200, json: body.map((entry) => executeOne(entry, store)) };
  }
  return { status: 200, json: executeOne(body, store) };
}
