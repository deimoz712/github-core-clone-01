// store.ts — the in-memory forge: repositories, refs, issues, pull requests,
// labels and comments, plus the GitHub-shaped JSON each one renders as.
//
// Determinism: every created_at/updated_at/merged_at is one fixed timestamp,
// every id is a sequential counter. No Date.now, no Math.random, no UUID.

import { ObjectStore, FIXED_EPOCH_SEC, buildCommit, parseCommit, isOid } from './git-objects.ts';
import { VIEWER } from './scenario.ts';

export const FIXED_ISO = new Date(FIXED_EPOCH_SEC * 1000).toISOString();
export const FIXED_IDENTITY_NAME = 'Conformance';
export const FIXED_IDENTITY_EMAIL = 'conformance@make.fun';

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  comments: IssueComment[];
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

export class Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch = 'main';
  readonly objects = new ObjectStore();
  /** Full ref name -> commit oid. */
  readonly refs = new Map<string, string>();
  readonly issues = new Map<number, Issue>();
  readonly pulls = new Map<number, PullRequest>();
  readonly labels = new Map<string, Label>();
  /** Issues and pull requests share one number space, like GitHub. */
  nextNumber = 1;
  nextCommentId = 1;
  readonly createdAt = FIXED_ISO;
  updatedAt = FIXED_ISO;
  /** Pack cache: key -> pack bytes. Cleared on every ref change. */
  readonly packCache = new Map<string, Buffer>();

  constructor(id: number, owner: string, name: string, isPrivate: boolean, description: string) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.isPrivate = isPrivate;
    this.description = description;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  invalidatePackCache(): void {
    this.packCache.clear();
  }

  /** Resolve a branch name, a full ref or a raw sha to a commit oid. */
  resolveRef(nameOrSha: string): string | null {
    if (this.refs.has(nameOrSha)) return this.refs.get(nameOrSha) as string;
    const headed = `refs/heads/${nameOrSha}`;
    if (this.refs.has(headed)) return this.refs.get(headed) as string;
    if (isOid(nameOrSha) && this.objects.has(nameOrSha)) return nameOrSha.toLowerCase();
    return null;
  }

  /** The tip of a branch (short name or full ref), or null when unborn/absent. */
  branchTip(branch: string): string | null {
    return this.resolveRef(branch);
  }

  /** Set a ref (full name) and invalidate the pack cache. */
  setRef(ref: string, oid: string): void {
    this.refs.set(ref, oid);
    this.invalidatePackCache();
  }

  deleteRef(ref: string): boolean {
    const removed = this.refs.delete(ref);
    if (removed) this.invalidatePackCache();
    return removed;
  }

  /** Branch short names, default branch first, then the rest in creation order. */
  branchNames(): string[] {
    const names: string[] = [];
    for (const ref of this.refs.keys()) {
      if (ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length));
    }
    names.sort((a, b) => {
      if (a === this.defaultBranch) return -1;
      if (b === this.defaultBranch) return 1;
      return 0;
    });
    return names;
  }

  /** The commit at the tip of `branch` (default branch when omitted). */
  tipCommit(branch?: string): { oid: string; commit: ReturnType<typeof parseCommit> } | null {
    const tip = this.branchTip(branch ?? this.defaultBranch);
    if (tip === null) return null;
    try {
      return { oid: tip, commit: parseCommit(this.objects.get(tip)?.data as Buffer) };
    } catch {
      return null;
    }
  }

  /** Create a commit on `branch` from a tree, with `message`. Returns its oid. */
  commitOnBranch(branch: string, treeOid: string, message: string): string {
    const tip = this.branchTip(branch);
    const commit = buildCommit({ tree: treeOid, parents: tip === null ? [] : [tip], message });
    const oid = this.objects.put('commit', commit);
    this.setRef(`refs/heads/${branch}`, oid);
    return oid;
  }

  /**
   * Write a file at `path` on `branch` (creating the branch's first commit when
   * unborn). `expectedSha` is the blob sha the caller believes is current; a
   * mismatch is a 409. Returns the commit and blob shas plus 201 (created) or
   * 200 (updated).
   */
  putContent(branch: string, path: string, content: Buffer, message: string, expectedSha?: string): { commitSha: string; contentSha: string; status: 201 | 200 } {
    const tip = this.branchTip(branch);
    const baseTree = tip === null ? null : parseCommit(this.objects.get(tip)?.data as Buffer).tree;
    const currentBlob = baseTree === null ? null : this.objects.blobAtPath(baseTree, path);
    if (expectedSha !== undefined) {
      if (currentBlob === null || currentBlob.toLowerCase() !== expectedSha.toLowerCase()) {
        throw Object.assign(new Error('sha does not match the current blob'), { status: 409 });
      }
    }
    const isUpdate = currentBlob !== null;
    const blobOid = this.objects.put('blob', content);
    const treeOid = this.objects.setPath(baseTree, path, blobOid);
    const commitSha = this.commitOnBranch(branch, treeOid, message);
    return { commitSha, contentSha: blobOid, status: isUpdate ? 200 : 201 };
  }

  /** Delete the file at `path` on `branch`, committing the removal. */
  deleteContent(branch: string, path: string, message: string, expectedSha?: string): { commitSha: string } {
    const tip = this.branchTip(branch);
    if (tip === null) throw Object.assign(new Error('Not Found'), { status: 404 });
    const baseTree = parseCommit(this.objects.get(tip)?.data as Buffer).tree;
    const currentBlob = this.objects.blobAtPath(baseTree, path);
    if (currentBlob === null) throw Object.assign(new Error('Not Found'), { status: 404 });
    if (expectedSha !== undefined && currentBlob.toLowerCase() !== expectedSha.toLowerCase()) {
      throw Object.assign(new Error('sha does not match the current blob'), { status: 409 });
    }
    const treeOid = this.objects.setPath(baseTree, path, null);
    const commitSha = this.commitOnBranch(branch, treeOid, message);
    return { commitSha };
  }

  /** The blob (oid + bytes) at `path` on `branch`, or null. */
  fileAt(branch: string, path: string): { oid: string; data: Buffer } | null {
    const tip = this.branchTip(branch);
    if (tip === null) return null;
    const tree = parseCommit(this.objects.get(tip)?.data as Buffer).tree;
    const blobOid = this.objects.blobAtPath(tree, path);
    if (blobOid === null) return null;
    const object = this.objects.get(blobOid);
    if (!object) return null;
    return { oid: blobOid, data: object.data };
  }

  /** The directory entries at `path` on `branch`, or null when absent. */
  dirAt(branch: string, path: string): { entries: Array<{ mode: string; name: string; oid: string }>; dirOid: string } | null {
    const tip = this.branchTip(branch);
    if (tip === null) return null;
    const tree = parseCommit(this.objects.get(tip)?.data as Buffer).tree;
    return this.objects.dirEntries(tree, path);
  }

  /** The changed files of a pull request (merge-base tree vs head tree). */
  pullFiles(pr: PullRequest): Array<{ filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }> {
    const headTip = this.branchTip(pr.headRef);
    const baseTip = this.branchTip(pr.baseRef);
    if (headTip === null || baseTip === null) return [];
    const base = this.objects.mergeBase(headTip, baseTip);
    const baseTree = base === null ? null : parseCommit(this.objects.get(base)?.data as Buffer).tree;
    const headTree = parseCommit(this.objects.get(headTip)?.data as Buffer).tree;
    const diff = this.objects.diffTrees(baseTree, headTree);
    const files: Array<{ filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }> = [];
    for (const [path, headOid] of [...diff.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const baseOid = baseTree === null ? null : this.objects.blobAtPath(baseTree, path);
      const headText = headOid === null ? '' : (this.objects.get(headOid)?.data.toString('utf8') ?? '');
      const baseText = baseOid === null ? '' : (this.objects.get(baseOid)?.data.toString('utf8') ?? '');
      const { additions, deletions } = lineDiff(baseText, headText);
      files.push({
        filename: path,
        status: baseOid === null ? 'added' : headOid === null ? 'removed' : 'modified',
        additions,
        deletions,
        changes: additions + deletions,
      });
    }
    return files;
  }

  /**
   * Squash-merge a pull request onto its base branch. Returns the merge result:
   * 200 with the merge commit, 405 when the merge conflicts or the pull is not
   * open, 404 when a branch is gone.
   */
  mergePull(pr: PullRequest): { status: 200 | 404 | 405; merged?: boolean; sha?: string; message: string } {
    if (pr.state !== 'open') {
      return { status: 405, message: 'Pull request is not open' };
    }
    const headTip = this.branchTip(pr.headRef);
    const baseTip = this.branchTip(pr.baseRef);
    if (headTip === null || baseTip === null) {
      return { status: 404, message: 'Not Found' };
    }
    const base = this.objects.mergeBase(headTip, baseTip);
    if (base === null) {
      return { status: 405, message: 'No common history to merge' };
    }
    const baseTree = parseCommit(this.objects.get(base)?.data as Buffer).tree;
    const headTree = parseCommit(this.objects.get(headTip)?.data as Buffer).tree;
    const baseTipTree = parseCommit(this.objects.get(baseTip)?.data as Buffer).tree;
    const headDiff = this.objects.diffTrees(baseTree, headTree);
    const baseDiff = this.objects.diffTrees(baseTree, baseTipTree);
    for (const [path, headOid] of headDiff) {
      if (baseDiff.has(path) && baseDiff.get(path) !== headOid) {
        return { status: 405, message: 'Merge conflict' };
      }
    }
    let treeOid = baseTipTree;
    for (const [path, headOid] of headDiff) {
      treeOid = this.objects.setPath(treeOid, path, headOid);
    }
    const message = `${pr.title} (#${pr.number})`;
    const commit = buildCommit({ tree: treeOid, parents: [baseTip], message });
    const mergeSha = this.objects.put('commit', commit);
    this.setRef(`refs/heads/${pr.baseRef}`, mergeSha);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = FIXED_ISO;
    pr.mergeCommitSha = mergeSha;
    pr.updatedAt = FIXED_ISO;
    return { status: 200, merged: true, sha: mergeSha, message };
  }
}

/** Line-level additions/deletions between two texts (multiset difference). */
export function lineDiff(baseText: string, headText: string): { additions: number; deletions: number } {
  const split = (text: string): string[] => {
    if (text === '') return [];
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  const baseLines = split(baseText);
  const headLines = split(headText);
  const baseCount = new Map<string, number>();
  for (const line of baseLines) baseCount.set(line, (baseCount.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of headLines) {
    const left = baseCount.get(line) ?? 0;
    if (left > 0) baseCount.set(line, left - 1);
    else additions += 1;
  }
  const headCount = new Map<string, number>();
  for (const line of headLines) headCount.set(line, (headCount.get(line) ?? 0) + 1);
  let deletions = 0;
  for (const line of baseLines) {
    const left = headCount.get(line) ?? 0;
    if (left > 0) headCount.set(line, left - 1);
    else deletions += 1;
  }
  return { additions, deletions };
}

export class Store {
  readonly repos = new Map<string, Repo>();
  nextRepoId = 5000;
  nextGlobalId = 1;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo | null {
    if (this.repos.has(this.key(owner, name))) return null;
    const repo = new Repo(this.nextRepoId++, owner, name, isPrivate, description);
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  /** Every repository owned by `owner`, in creation order. */
  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// JSON shapes (GitHub v3)
// ---------------------------------------------------------------------------

export function userJson(login: string): { login: string; id: number; name: string; email: string } {
  if (login === VIEWER.login) {
    return { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email };
  }
  return { login, id: 1000, name: login, email: `${login}@example.invalid` };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson(repo.owner),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://example.invalid/${repo.fullName}`,
    clone_url: `https://example.invalid/${repo.fullName}.git`,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color };
}

export function issueJson(issue: Issue, repo: Repo): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: userJson(issue.userLogin),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://example.invalid/${repo.fullName}/issues/${issue.number}`,
    comments_url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}/comments`,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
  };
}

export function commentJson(comment: IssueComment, repo: Repo, issueNumber: number): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: userJson(comment.userLogin),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `https://example.invalid/${repo.fullName}/issues/${issueNumber}#issuecomment-${comment.id}`,
  };
}

export function pullJson(pr: PullRequest, repo: Repo): Record<string, unknown> {
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    head: { ref: pr.headRef, sha: pr.headSha, label: `${repo.owner}:${pr.headRef}` },
    base: { ref: pr.baseRef, sha: pr.baseSha, label: `${repo.owner}:${pr.baseRef}` },
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    user: userJson(pr.userLogin),
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    html_url: `https://example.invalid/${repo.fullName}/pull/${pr.number}`,
  };
}

export function branchJson(name: string, sha: string): Record<string, unknown> {
  return { name, commit: { sha }, protected: false };
}

function parseIdentity(who: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(who);
  if (!match) return { name: who, email: '', date: FIXED_ISO };
  const timestamp = Number(match[3]);
  return {
    name: match[1] as string,
    email: match[2] as string,
    date: Number.isFinite(timestamp) ? new Date(timestamp * 1000).toISOString() : FIXED_ISO,
  };
}

export function commitJson(oid: string, repo: Repo): Record<string, unknown> {
  const commit = parseCommit(repo.objects.get(oid)?.data as Buffer);
  const author = parseIdentity(commit.author);
  const committer = parseIdentity(commit.committer);
  return {
    sha: oid,
    commit: {
      message: commit.message,
      author,
      committer,
      tree: { sha: commit.tree },
    },
    author: userJson(VIEWER.login),
    committer: userJson(VIEWER.login),
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

export function contentFileJson(path: string, oid: string, data: Buffer): Record<string, unknown> {
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    content: data.toString('base64'),
    sha: oid,
    size: data.length,
    name,
    path,
  };
}

export function contentDirJson(path: string, entry: { mode: string; name: string; oid: string }, size = 0): Record<string, unknown> {
  const fullPath = path === '' ? entry.name : `${path}/${entry.name}`;
  const isDir = entry.mode === '40000';
  return {
    type: isDir ? 'dir' : 'file',
    name: entry.name,
    path: fullPath,
    sha: entry.oid,
    ...(isDir ? {} : { size }),
  };
}
