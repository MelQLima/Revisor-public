import { describe, expect, it, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { OctokitGitHubClient } from '../src/integrations/github/octokit-github-client.js';
import { testLogger } from './helpers.js';

const repo = { owner: 'acme', name: 'wallet' };

function fakeOctokit(overrides: Partial<Record<string, unknown>> = {}) {
  const prData = {
    number: 7,
    title: 'PR title',
    body: 'desc',
    user: { login: 'dev' },
    base: { ref: 'main' },
    head: { ref: 'feature', sha: 'headsha' },
    draft: false,
    html_url: 'https://github.com/acme/wallet/pull/7',
  };
  const filesData = [
    { filename: 'a.ts', status: 'modified', additions: 3, deletions: 1, patch: '@@ +a' },
    { filename: 'b.ts', status: 'renamed', additions: 0, deletions: 0, previous_filename: 'old.ts' },
  ];
  const commitsData = [{ sha: 'c1', commit: { message: 'msg' }, author: { login: 'dev' } }];

  const fake = {
    paginate: async (method: (p: unknown) => Promise<{ data: unknown }>, params: unknown) =>
      (await method(params)).data,
    pulls: {
      get: vi.fn(async () => ({ data: prData })),
      listFiles: vi.fn(async () => ({ data: filesData })),
      listCommits: vi.fn(async () => ({ data: commitsData })),
      createReview: vi.fn(async () => ({ data: { id: 999, html_url: 'https://review' } })),
    },
    repos: {
      getContent: vi.fn(async () => ({
        data: { type: 'file', content: Buffer.from('hello world').toString('base64') },
      })),
    },
    ...overrides,
  };
  return fake as unknown as Octokit & typeof fake;
}

describe('OctokitGitHubClient', () => {
  it('maps a PR into the domain model', async () => {
    const octokit = fakeOctokit();
    const client = new OctokitGitHubClient({ token: 't', logger: testLogger(), octokit });
    const pr = await client.getPullRequest(repo, 7);
    expect(pr.number).toBe(7);
    expect(pr.author).toBe('dev');
    expect(pr.headSha).toBe('headsha');
    expect(pr.changedFiles).toHaveLength(2);
    expect(pr.changedFiles[1]).toMatchObject({ status: 'renamed', previousFilename: 'old.ts' });
    expect(pr.commits[0]?.message).toBe('msg');
  });

  it('decodes file content', async () => {
    const client = new OctokitGitHubClient({ token: 't', logger: testLogger(), octokit: fakeOctokit() });
    expect(await client.getFileContent(repo, 'a.ts', 'ref')).toBe('hello world');
  });

  it('does not post in dry-run mode', async () => {
    const octokit = fakeOctokit();
    const client = new OctokitGitHubClient({ token: 't', logger: testLogger(), octokit, dryRun: true });
    const res = await client.submitReview({
      repo,
      pullNumber: 7,
      commitSha: 'headsha',
      verdict: 'request_changes',
      body: 'body',
    });
    expect(res.posted).toBe(false);
    expect(octokit.pulls.createReview).not.toHaveBeenCalled();
  });

  it('posts a review and maps the verdict to a GitHub event', async () => {
    const octokit = fakeOctokit();
    const client = new OctokitGitHubClient({ token: 't', logger: testLogger(), octokit });
    const res = await client.submitReview({
      repo,
      pullNumber: 7,
      commitSha: 'headsha',
      verdict: 'request_changes',
      body: 'body',
      comments: [{ path: 'a.ts', line: 2, body: 'inline' }],
    });
    expect(res.posted).toBe(true);
    expect(res.reviewId).toBe(999);
    const firstCallArgs = octokit.pulls.createReview.mock.calls[0] as unknown[] | undefined;
    const call = firstCallArgs?.[0] as { event: string; comments?: unknown[] };
    expect(call.event).toBe('REQUEST_CHANGES');
    expect(call.comments).toHaveLength(1);
  });

  it('retries body-only when inline comments are rejected', async () => {
    const createReview = vi
      .fn()
      .mockRejectedValueOnce(new Error('line not part of diff'))
      .mockResolvedValueOnce({ data: { id: 1000 } });
    const octokit = fakeOctokit({ pulls: {
      get: vi.fn(),
      listFiles: vi.fn(),
      listCommits: vi.fn(),
      createReview,
    } });
    const client = new OctokitGitHubClient({ token: 't', logger: testLogger(), octokit });
    const res = await client.submitReview({
      repo,
      pullNumber: 7,
      commitSha: 'headsha',
      verdict: 'comment',
      body: 'body',
      comments: [{ path: 'a.ts', line: 999, body: 'inline' }],
    });
    expect(res.posted).toBe(true);
    expect(createReview).toHaveBeenCalledTimes(2);
    // second call has no comments
    const secondCallArgs = createReview.mock.calls[1] as unknown[] | undefined;
    expect((secondCallArgs?.[0] as { comments?: unknown }).comments).toBeUndefined();
  });

  it('falls back to COMMENT when GitHub rejects self-review', async () => {
    const createReview = vi
      .fn()
      .mockRejectedValueOnce(new Error('Unprocessable Entity: "Review Can not approve your own pull request"'))
      .mockResolvedValueOnce({ data: { id: 1001 } });
    const octokit = fakeOctokit({ pulls: {
      get: vi.fn(),
      listFiles: vi.fn(),
      listCommits: vi.fn(),
      createReview,
    } });
    const client = new OctokitGitHubClient({ token: 't', logger: testLogger(), octokit });
    const res = await client.submitReview({
      repo,
      pullNumber: 7,
      commitSha: 'headsha',
      verdict: 'approve',
      body: 'body',
    });
    expect(res.posted).toBe(true);
    expect(createReview).toHaveBeenCalledTimes(2);
    const firstCallArgs = createReview.mock.calls[0] as unknown[] | undefined;
    expect((firstCallArgs?.[0] as { event: string }).event).toBe('APPROVE');
    const secondCallArgs = createReview.mock.calls[1] as unknown[] | undefined;
    expect((secondCallArgs?.[0] as { event: string }).event).toBe('COMMENT');
  });

  it('does not swallow other errors after inline retry', async () => {
    const createReview = vi
      .fn()
      .mockRejectedValueOnce(new Error('line not part of diff'))
      .mockRejectedValueOnce(new Error('some other failure'));
    const octokit = fakeOctokit({ pulls: {
      get: vi.fn(),
      listFiles: vi.fn(),
      listCommits: vi.fn(),
      createReview,
    } });
    const client = new OctokitGitHubClient({ token: 't', logger: testLogger(), octokit });
    await expect(
      client.submitReview({
        repo,
        pullNumber: 7,
        commitSha: 'headsha',
        verdict: 'comment',
        body: 'body',
        comments: [{ path: 'a.ts', line: 999, body: 'inline' }],
      }),
    ).rejects.toThrow('some other failure');
  });
});
