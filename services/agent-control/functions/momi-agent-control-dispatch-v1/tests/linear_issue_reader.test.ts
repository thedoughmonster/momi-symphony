import assert from "node:assert/strict";
import test from "node:test";

import {
  createLinearAdapterProfile,
  LinearAdapterError,
} from "../src/linear_issue_adapter.ts";
import {
  fetchLinearCandidateIssues,
  refreshLinearIssues,
} from "../src/linear_issue_reader.ts";
import type { LinearQuery } from "../src/linear_issue_reader.ts";

const profile = createLinearAdapterProfile({
  projectId: "project-1",
  repository: "thedoughmonster/momi-symphony",
  baseBranch: "main",
});

function issue(id: string, identifier: string): Record<string, unknown> {
  return {
    id,
    identifier,
    title: `Issue ${identifier}`,
    description: "## Acceptance criteria\n\n- It is complete.",
    priority: 2,
    branchName: null,
    url: null,
    createdAt: "2026-08-18T00:00:00Z",
    updatedAt: "2026-08-18T01:00:00Z",
    state: { id: "todo", name: "Todo", type: "unstarted" },
    assignee: null,
    project: { id: "project-1" },
    team: { id: "team-1" },
    labels: {
      nodes: [{ id: "implementation", name: "Implementation" }, {
        id: "ready",
        name: "ready-package",
      }],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
    parent: {
      id: "parent",
      identifier: "MOX-229",
      state: { id: "backlog", name: "Backlog", type: "backlog" },
    },
    children: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    inverseRelations: {
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
}

test("empty candidate and refresh reads make no provider request", async () => {
  let calls = 0;
  const query = (async <T>() => {
    calls += 1;
    return {} as T;
  }) as LinearQuery;
  assert.deepEqual(await fetchLinearCandidateIssues([], profile, query), []);
  assert.deepEqual(await refreshLinearIssues([], profile, query), []);
  assert.equal(calls, 0);
});

test("candidate pagination returns full normalized snapshots and omits malformed core rows", async () => {
  const requests: Array<{ query: string; variables: Record<string, unknown> }> =
    [];
  const evidence: unknown[] = [];
  const malformed = issue("bad", "bad\nidentifier");
  malformed.title = "";
  const blocked = issue("issue-2", "MOX-232");
  blocked.inverseRelations = {
    nodes: [{
      type: "blocks",
      issue: {
        id: "blocker",
        identifier: "MOX-230",
        state: { id: "started", name: "In Progress", type: "started" },
      },
    }],
    pageInfo: { hasNextPage: false, endCursor: null },
  };
  const query =
    (async <T>(document: string, variables: Record<string, unknown>) => {
      requests.push({ query: document, variables });
      return (variables.after === null
        ? {
          issues: {
            nodes: [blocked, malformed],
            pageInfo: { hasNextPage: true, endCursor: "next" },
          },
        }
        : {
          issues: {
            nodes: [issue("issue-1", "MOX-231")],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        }) as T;
    }) as LinearQuery;
  const result = await fetchLinearCandidateIssues(
    [" Todo ", "Todo"],
    profile,
    query,
    (event) => evidence.push(event),
  );
  assert.deepEqual(result.map((entry) => entry.identifier), [
    "MOX-231",
    "MOX-232",
  ]);
  assert.equal(result[0].dispatchable, true);
  assert.equal(result[1].dispatchable, false);
  assert.deepEqual(result[1].blocked_by, [{
    id: "blocker",
    identifier: "MOX-230",
    state: "In Progress",
  }]);
  assert.deepEqual(evidence, [{
    operation: "candidate",
    reason: "linear_issue_title_missing",
    issue_id: "bad",
    issue_identifier: null,
  }]);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].variables, {
    projectId: "project-1",
    states: ["Todo"],
    after: null,
  });
  assert.deepEqual(requests[1].variables, {
    projectId: "project-1",
    states: ["Todo"],
    after: "next",
  });
  for (const field of ["parent", "children", "inverseRelations", "project"]) {
    assert.match(requests[0].query, new RegExp(field));
  }
  assert.match(
    requests[0].query,
    /inverseRelations\(first: 50\)[\s\S]*nodes \{ type issue \{/,
  );
  assert.doesNotMatch(requests[0].query, /(?:^|\n)\s*relations(?:\(|\s*\{)/);
});

test("candidate pagination fails on a missing or repeated cursor", async () => {
  const query = (async <T>() =>
    ({
      issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } },
    }) as T) as LinearQuery;
  await assert.rejects(
    fetchLinearCandidateIssues(["Todo"], profile, query),
    (error: unknown) =>
      error instanceof LinearAdapterError &&
      error.category === "tracker_pagination" &&
      error.code === "linear_candidate_cursor_invalid",
  );
});

test("ID refresh batches opaque IDs and returns only normalized records", async () => {
  const ids = Array.from({ length: 51 }, (_, index) => `issue-${index + 1}`);
  const sizes: number[] = [];
  const query =
    (async <T>(_document: string, variables: Record<string, unknown>) => {
      const chunk = variables.ids as string[];
      sizes.push(chunk.length);
      return {
        issues: {
          nodes: chunk.map((id) =>
            issue(
              id,
              `MOX-${String(Number(id.split("-")[1]) + 100).padStart(3, "0")}`,
            )
          ),
        },
      } as T;
    }) as LinearQuery;
  const result = await refreshLinearIssues(ids, profile, query);
  assert.deepEqual(sizes, [50, 1]);
  assert.equal(result.length, 51);
  assert.ok(result.every((entry) => entry.dispatchable));
  assert.ok(result.every((entry) => entry.native_ref.provider === "linear"));
});

test("ID refresh fails instead of hiding a malformed requested record", async () => {
  const malformed = issue("issue-1", "MOX-230");
  malformed.state = null;
  const query =
    (async <T>() => ({ issues: { nodes: [malformed] } }) as T) as LinearQuery;
  await assert.rejects(
    refreshLinearIssues(["issue-1"], profile, query),
    (error: unknown) =>
      error instanceof LinearAdapterError &&
      error.category === "tracker_response" &&
      error.code === "linear_issue_state_missing",
  );
});

test("candidate and refresh reads reject invalid project scope before network access", async () => {
  let calls = 0;
  const query = (async <T>() => {
    calls += 1;
    return {} as T;
  }) as LinearQuery;
  const unmapped = createLinearAdapterProfile({
    repository: "thedoughmonster/momi-symphony",
    baseBranch: "main",
  });
  await assert.rejects(
    fetchLinearCandidateIssues(["Todo"], unmapped, query),
    (error: unknown) =>
      error instanceof LinearAdapterError &&
      error.category === "invalid_tracker_config",
  );
  await assert.rejects(
    refreshLinearIssues(["issue-1"], unmapped, query),
    (error: unknown) =>
      error instanceof LinearAdapterError &&
      error.category === "invalid_tracker_config",
  );
  const malformed = createLinearAdapterProfile({
    projectId: "bad scope",
    repository: "thedoughmonster/momi-symphony",
    baseBranch: "main",
  });
  await assert.rejects(
    fetchLinearCandidateIssues(["Todo"], malformed, query),
    (error: unknown) =>
      error instanceof LinearAdapterError &&
      error.category === "invalid_tracker_config",
  );
  assert.equal(calls, 0);
});
