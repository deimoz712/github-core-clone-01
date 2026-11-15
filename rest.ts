// rest.ts — the REST v3 surface: repositories, branches, commits, contents,
// issues, comments, labels and pull requests.
//
// Routing is by path segments after /api/v3. Every handler either returns a
// {status, json, headers} answer or throws HttpError (rendered as a JSON
// {message} body). Auth is the caller's job; every route here assumes the
// bearer token already named the viewer.

import { Store, Repo, FIXED_ISO, repoJson, issueJson, commentJson, pullJson, branchJson, commitJson, contentFileJson, contentDirJson } from './store.ts';
import { VIEWER } from './scenario.ts';
import { parseCommit } from './git-objects.ts';

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface RestAnswer {
  status: number;
  json?: unknown;
  headers?: Record<string, string>;
  /** 204-style answer: headers only, no body. */
  empty?: boolean;
}

export interface RestContext {
  store: Store;
  /** The request's origin, for absolute Link URLs. */
  origin: string;
}

type JsonObject = Record<string, unknown>;

function notFound(message = 'Not Found'): HttpError {
  return new HttpError(404, message);
}

function getRepoOr404(ctx: RestContext, owner: string, name: string): Repo {
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) throw notFound();
  return repo;
}

interface Page {
  perPage: number;
  page: number;
}

function pageOf(query: URLSearchParams): Page {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '30', 10);
  const pageRaw = Number.parseInt(query.get('page') ?? '1', 10);
  return {
    perPage: Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30,
    page: Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1,
  };
}

function paginate<T>(items: readonly T[], page: Page): { items: T[]; hasNext: boolean; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / page.perPage));
  const start = (page.page - 1) * page.perPage;
  return {
    items: items.slice(start, start + page.perPage),
    hasNext: page.page < totalPages,
    totalPages,
  };
}

function linkHeader(ctx: RestContext, path: string, query: URLSearchParams, page: Page, hasNext: boolean): Record<string, string> {
  if (!hasNext) return {};
  const next = new URLSearchParams(query);
  next.set('per_page', String(page.perPage));
  next.set('page', String(page.page + 1));
  return { link: `<${ctx.origin}${path}?${next.toString()}>; rel="next"` };
}

function bodyString(body: JsonObject | undefined, field: string, fallback = ''): string {
  const value = body?.[field];
  return typeof value === 'string' ? value : fallback;
}

function bodyBoolean(body: JsonObject | undefined, field: string, fallback: boolean): boolean {
  const value = body?.[field];
  return typeof value === 'boolean' ? value : fallback;
}

/** List the commits reachable from `ref` (branch, ref or sha), newest first. */
function listCommits(repo: Repo, ref?: string): Array<Record<string, unknown>> {
  const tip = ref === undefined ? repo.branchTip(repo.defaultBranch) : repo.resolveRef(ref);
  if (tip === null) return [];
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    out.push(commitJson(oid, repo));
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return out;
}

/** The REST v3 router. `segments` are the path parts after /api/v3. */
export function handleRest(
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: JsonObject | undefined,
  ctx: RestContext,
): RestAnswer {
  const store = ctx.store;

  // GET /api/v3/ — the API root.
  if (segments.length === 0) {
    if (method !== 'GET') throw new HttpError(405, 'Method Not Allowed');
    return {
      status: 200,
      json: { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }

  // GET /api/v3/meta
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') throw new HttpError(405, 'Method Not Allowed');
    return { status: 200, json: { installed_version: '1.0.0' } };
  }

  // GET /api/v3/user
  if (segments.length === 1 && segments[0] === 'user' && method === 'GET') {
    return {
      status: 200,
      json: {
        login: VIEWER.login,
        id: VIEWER.id,
        name: VIEWER.name,
        email: VIEWER.email,
        type: 'User',
        created_at: FIXED_ISO,
        updated_at: FIXED_ISO,
      },
    };
  }

  // POST /api/v3/user/repos — create; GET /api/v3/user/repos — list (paginated).
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') {
      const name = bodyString(body, 'name');
      if (name === '') throw new HttpError(422, 'name is required');
      const repo = store.createRepo(VIEWER.login, name, bodyBoolean(body, 'private', false), bodyString(body, 'description'));
      if (repo === null) throw new HttpError(422, 'Repository already exists');
      return { status: 201, json: repoJson(repo) };
    }
    if (method === 'GET') {
      const page = pageOf(query);
      const repos = store.listRepos(VIEWER.login);
      const { items, hasNext } = paginate(repos, page);
      return {
        status: 200,
        json: items.map(repoJson),
        headers: linkHeader(ctx, '/api/v3/user/repos', query, page, hasNext),
      };
    }
    throw new HttpError(405, 'Method Not Allowed');
  }

  // /api/v3/repos/{owner}/{name}[/...]
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1] as string;
    const name = segments[2] as string;
    const rest = segments.slice(3);

    // GET/PATCH/DELETE /api/v3/repos/{owner}/{name}
    if (rest.length === 0) {
      if (method === 'GET') {
        return { status: 200, json: repoJson(getRepoOr404(ctx, owner, name)) };
      }
      if (method === 'PATCH') {
        const repo = getRepoOr404(ctx, owner, name);
        if (typeof body?.description === 'string') repo.description = body.description;
        if (typeof body?.private === 'boolean') repo.isPrivate = body.private;
        return { status: 200, json: repoJson(repo) };
      }
      if (method === 'DELETE') {
        if (!store.deleteRepo(owner, name)) throw notFound();
        return { status: 204, empty: true };
      }
      throw new HttpError(405, 'Method Not Allowed');
    }

    const repo = getRepoOr404(ctx, owner, name);

    // GET /repos/{o}/{r}/branches
    if (rest.length === 1 && rest[0] === 'branches') {
      if (method !== 'GET') throw new HttpError(405, 'Method Not Allowed');
      const branches = repo.branchNames().map((branch) => {
        const sha = repo.branchTip(branch) as string;
        return branchJson(branch, sha);
      });
      return { status: 200, json: branches };
    }

    // GET /repos/{o}/{r}/commits[?sha=]
    if (rest.length === 1 && rest[0] === 'commits') {
      if (method !== 'GET') throw new HttpError(405, 'Method Not Allowed');
      const page = pageOf(query);
      const commits = listCommits(repo, query.get('sha') ?? undefined);
      const { items, hasNext } = paginate(commits, page);
      return { status: 200, json: items, headers: linkHeader(ctx, `/api/v3/repos/${owner}/${name}/commits`, query, page, hasNext) };
    }

    // POST /repos/{o}/{r}/git/refs — create a branch or tag.
    if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'GET') {
        const refs: Array<Record<string, unknown>> = [];
        for (const [ref, oid] of repo.refs) {
          const object = repo.objects.get(oid);
          refs.push({ ref, object: { sha: oid, type: object?.type ?? 'commit' } });
        }
        return { status: 200, json: refs };
      }
      if (method !== 'POST') throw new HttpError(405, 'Method Not Allowed');
      const ref = bodyString(body, 'ref');
      const sha = bodyString(body, 'sha').toLowerCase();
      if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) throw new HttpError(422, 'Invalid ref');
      if (!/^[0-9a-f]{40}$/.test(sha) || !repo.objects.has(sha)) throw new HttpError(422, 'Invalid sha');
      if (repo.refs.has(ref)) throw new HttpError(422, 'Reference already exists');
      repo.setRef(ref, sha);
      return { status: 201, json: { ref, object: { sha } } };
    }

    // /repos/{o}/{r}/contents/{path...}
    if (rest.length >= 1 && rest[0] === 'contents') {
      const filePath = rest.slice(1).join('/');
      if (method === 'GET') {
        const ref = query.get('ref') ?? repo.defaultBranch;
        const file = repo.fileAt(ref, filePath);
        if (file !== null) {
          return { status: 200, json: contentFileJson(filePath, file.oid, file.data) };
        }
        const dir = repo.dirAt(ref, filePath);
        if (dir !== null) {
          const entries = dir.entries.map((entry) => {
            const size = entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0);
            return contentDirJson(filePath, entry, size);
          });
          return { status: 200, json: entries };
        }
        throw notFound();
      }
      if (method === 'PUT') {
        const content = bodyString(body, 'content');
        const message = bodyString(body, 'message', `Update ${filePath}`);
        const branch = bodyString(body, 'branch', repo.defaultBranch);
        const sha = typeof body?.sha === 'string' ? body.sha : undefined;
        if (branch !== repo.defaultBranch && repo.branchTip(branch) === null) throw notFound();
        let data: Buffer;
        try {
          data = Buffer.from(content, 'base64');
        } catch {
          throw new HttpError(422, 'content is not valid base64');
        }
        try {
          const result = repo.putContent(branch, filePath, data, message, sha);
          return {
            status: result.status,
            json: { content: { sha: result.contentSha, encoding: 'base64' }, commit: { sha: result.commitSha } },
          };
        } catch (err) {
          if (err instanceof HttpError) throw err;
          if ((err as { status?: number }).status === 409) throw new HttpError(409, (err as Error).message);
          throw err;
        }
      }
      if (method === 'DELETE') {
        const message = bodyString(body, 'message', `Delete ${filePath}`);
        const branch = bodyString(body, 'branch', repo.defaultBranch);
        const sha = typeof body?.sha === 'string' ? body.sha : undefined;
        try {
          const result = repo.deleteContent(branch, filePath, message, sha);
          return { status: 200, json: { commit: { sha: result.commitSha } } };
        } catch (err) {
          if ((err as { status?: number }).status === 404) throw notFound();
          if ((err as { status?: number }).status === 409) throw new HttpError(409, (err as Error).message);
          throw err;
        }
      }
      throw new HttpError(405, 'Method Not Allowed');
    }

    // POST /repos/{o}/{r}/labels — create; GET — list.
    if (rest.length === 1 && rest[0] === 'labels') {
      if (method === 'GET') {
        return { status: 200, json: [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })) };
      }
      if (method !== 'POST') throw new HttpError(405, 'Method Not Allowed');
      const labelName = bodyString(body, 'name');
      if (labelName === '') throw new HttpError(422, 'name is required');
      if (repo.labels.has(labelName)) throw new HttpError(422, 'Label already exists');
      const label = { name: labelName, color: bodyString(body, 'color', 'ededed') };
      repo.labels.set(labelName, label);
      return { status: 201, json: { name: label.name, color: label.color } };
    }

    // /repos/{o}/{r}/issues[/{n}[/comments]]
    if (rest.length >= 1 && rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const title = bodyString(body, 'title');
          const issueBody = bodyString(body, 'body');
          const labelNames = Array.isArray(body?.labels) ? (body.labels as unknown[]) : [];
          const labels: Array<{ name: string; color: string }> = [];
          for (const labelName of labelNames) {
            if (typeof labelName !== 'string') throw new HttpError(422, 'Invalid label');
            const label = repo.labels.get(labelName);
            if (!label) throw new HttpError(422, `Label ${labelName} does not exist`);
            labels.push(label);
          }
          const number = repo.nextNumber++;
          const issue = {
            id: store.nextGlobalId++,
            number,
            title,
            body: issueBody,
            state: 'open' as const,
            labels,
            userLogin: VIEWER.login,
            createdAt: FIXED_ISO,
            updatedAt: FIXED_ISO,
            comments: [],
          };
          repo.issues.set(number, issue);
          return { status: 201, json: issueJson(issue, repo) };
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let issues = [...repo.issues.values()];
          if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
          else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
          if (sort === 'created') {
            issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
          }
          const page = pageOf(query);
          const { items, hasNext } = paginate(issues, page);
          return {
            status: 200,
            json: items.map((issue) => issueJson(issue, repo)),
            headers: linkHeader(ctx, `/api/v3/repos/${owner}/${name}/issues`, query, page, hasNext),
          };
        }
        throw new HttpError(405, 'Method Not Allowed');
      }
      const number = Number.parseInt(rest[1] as string, 10);
      if (!Number.isSafeInteger(number) || number < 1) throw notFound();
      const issue = repo.issues.get(number);
      if (rest.length === 2) {
        if (method === 'GET') {
          if (!issue) throw notFound();
          return { status: 200, json: issueJson(issue, repo) };
        }
        if (method === 'PATCH') {
          if (!issue) throw notFound();
          if (body?.state === 'open' || body?.state === 'closed') issue.state = body.state;
          if (typeof body?.title === 'string') issue.title = body.title;
          if (typeof body?.body === 'string') issue.body = body.body;
          return { status: 200, json: issueJson(issue, repo) };
        }
        throw new HttpError(405, 'Method Not Allowed');
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (!issue) throw notFound();
        if (method === 'POST') {
          const comment = {
            id: repo.nextCommentId++,
            body: bodyString(body, 'body'),
            userLogin: VIEWER.login,
            createdAt: FIXED_ISO,
            updatedAt: FIXED_ISO,
          };
          issue.comments.push(comment);
          return { status: 201, json: commentJson(comment, repo, number) };
        }
        if (method === 'GET') {
          return { status: 200, json: issue.comments.map((comment) => commentJson(comment, repo, number)) };
        }
        throw new HttpError(405, 'Method Not Allowed');
      }
      throw notFound();
    }

    // /repos/{o}/{r}/pulls[/{n}[/files|/merge]]
    if (rest.length >= 1 && rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const head = bodyString(body, 'head');
          const base = bodyString(body, 'base');
          const title = bodyString(body, 'title');
          const pullBody = bodyString(body, 'body');
          const headSha = repo.branchTip(head);
          const baseSha = repo.branchTip(base);
          if (headSha === null || baseSha === null) throw new HttpError(422, 'Invalid head or base branch');
          const number = repo.nextNumber++;
          const pr = {
            id: store.nextGlobalId++,
            number,
            title,
            body: pullBody,
            state: 'open' as const,
            headRef: head,
            headSha,
            baseRef: base,
            baseSha,
            merged: false,
            mergedAt: null as string | null,
            mergeCommitSha: null as string | null,
            userLogin: VIEWER.login,
            createdAt: FIXED_ISO,
            updatedAt: FIXED_ISO,
          };
          repo.pulls.set(number, pr);
          return { status: 201, json: pullJson(pr, repo) };
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let pulls = [...repo.pulls.values()];
          if (state === 'open') pulls = pulls.filter((pr) => pr.state === 'open');
          else if (state === 'closed') pulls = pulls.filter((pr) => pr.state === 'closed');
          pulls.sort((a, b) => b.number - a.number);
          const page = pageOf(query);
          const { items, hasNext } = paginate(pulls, page);
          return {
            status: 200,
            json: items.map((pr) => pullJson(pr, repo)),
            headers: linkHeader(ctx, `/api/v3/repos/${owner}/${name}/pulls`, query, page, hasNext),
          };
        }
        throw new HttpError(405, 'Method Not Allowed');
      }
      const number = Number.parseInt(rest[1] as string, 10);
      if (!Number.isSafeInteger(number) || number < 1) throw notFound();
      const pr = repo.pulls.get(number);
      if (rest.length === 2) {
        if (method !== 'GET') throw new HttpError(405, 'Method Not Allowed');
        if (!pr) throw notFound();
        return { status: 200, json: pullJson(pr, repo) };
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (method !== 'GET') throw new HttpError(405, 'Method Not Allowed');
        if (!pr) throw notFound();
        return { status: 200, json: repo.pullFiles(pr) };
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (method !== 'PUT') throw new HttpError(405, 'Method Not Allowed');
        if (!pr) throw notFound();
        const result = repo.mergePull(pr);
        if (result.status === 200) {
          return { status: 200, json: { merged: true, sha: result.sha, message: result.message } };
        }
        throw new HttpError(result.status, result.message);
      }
      throw notFound();
    }

    throw notFound();
  }

  throw notFound();
}
