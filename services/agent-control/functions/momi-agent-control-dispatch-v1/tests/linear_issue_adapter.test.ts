import assert from "node:assert/strict";
import test from "node:test";

import {
  createLinearAdapterProfile,
  LinearAdapterError,
  normalizeLinearIssue,
} from "../src/linear_issue_adapter.ts";

const profile = createLinearAdapterProfile({
  projectId: "project-1",
  teamId: "team-1",
  repository: "thedoughmonster/momi-symphony",
  baseBranch: "main",
});

function issueFixture(): Record<string, unknown> {
  return {
    id: "issue-1",
    identifier: "MOX-230",
    title: "Define readiness",
    description:
      "## 10. Acceptance criteria\n\n- Dispatchability is deterministic.\n\n## 11. Verification\n",
    priority: 1,
    branchName: "thedoughmonster/mox-230",
    url: "https://linear.app/mox/issue/MOX-230",
    createdAt: "2026-08-18T14:30:55.804Z",
    updatedAt: "2026-08-18T21:48:59.879Z",
    state: { id: "state-started", name: "In Progress", type: "started" },
    assignee: { id: "user-1" },
    project: { id: "project-1" },
    team: { id: "team-1" },
    labels: {
      nodes: [
        { id: "implementation", name: "Implementation" },
        { id: "ready", name: "ready-package" },
        { id: "duplicate-ready", name: " READY-PACKAGE " },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
    parent: {
      id: "parent-1",
      identifier: "MOX-229",
      state: { id: "state-backlog", name: "Backlog", type: "backlog" },
    },
    children: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    inverseRelations: {
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
}

test("normalizes every generic issue field and dispatches a ready native leaf", () => {
  const issue = normalizeLinearIssue(issueFixture(), profile);
  assert.deepEqual(issue, {
    id: "issue-1",
    native_ref: {
      provider: "linear",
      issue_id: "issue-1",
      project_id: "project-1",
      team_id: "team-1",
      repository: "thedoughmonster/momi-symphony",
      base_branch: "main",
      hierarchy_mode: "native_child",
      parent: {
        id: "parent-1",
        identifier: "MOX-229",
        state: "Backlog",
        state_id: "state-backlog",
        state_type: "backlog",
      },
      sub_issues: [],
      sub_issues_complete: true,
      parent_progress: null,
    },
    identifier: "MOX-230",
    title: "Define readiness",
    description:
      "## 10. Acceptance criteria\n\n- Dispatchability is deterministic.\n\n## 11. Verification\n",
    priority: 1,
    state: "In Progress",
    branch_name: "thedoughmonster/mox-230",
    url: "https://linear.app/mox/issue/MOX-230",
    assignee_id: "user-1",
    labels: ["implementation", "ready-package"],
    blocked_by: [],
    dispatchable: true,
    dispatchability_reasons: [],
    created_at: "2026-08-18T14:30:55.804Z",
    updated_at: "2026-08-18T21:48:59.879Z",
  });
});

test("all native parents remain non-dispatchable and progress comes from sub-issues", () => {
  const payload = issueFixture();
  payload.parent = null;
  payload.children = {
    nodes: [
      {
        id: "child-2",
        identifier: "MOX-232",
        state: { id: "state-todo", name: "Todo", type: "unstarted" },
      },
      {
        id: "child-1",
        identifier: "MOX-231",
        state: { id: "state-done", name: "Done", type: "completed" },
      },
      {
        id: "child-3",
        identifier: "MOX-233",
        state: { id: "state-canceled", name: "Canceled", type: "canceled" },
      },
    ],
    pageInfo: { hasNextPage: false, endCursor: null },
  };
  const issue = normalizeLinearIssue(payload, profile);
  assert.equal(issue.dispatchable, false);
  assert.deepEqual(issue.dispatchability_reasons, ["non_leaf"]);
  assert.equal(issue.native_ref.hierarchy_mode, "native_parent");
  assert.deepEqual(issue.native_ref.parent_progress, {
    total: 3,
    terminal: 2,
    completed: 1,
    complete: true,
  });
  assert.deepEqual(
    issue.native_ref.sub_issues.map((child) => child.identifier),
    ["MOX-231", "MOX-232", "MOX-233"],
  );
});

test("one explicit attestation replaces prose shape, type, and exclusion labels", () => {
  const payload = issueFixture();
  payload.description = "A semantically complete package without a prescribed heading.";
  payload.labels = {
    nodes: [
      { id: "ready", name: "ready-package" },
      { id: "legacy-blocker", name: "needs-discovery" },
      { id: "legacy-decision", name: "blocked-external-decision" },
    ],
    pageInfo: { hasNextPage: false, endCursor: null },
  };
  assert.equal(normalizeLinearIssue(payload, profile).dispatchable, true);

  payload.labels = {
    nodes: [{ id: "implementation", name: "Implementation" }],
    pageInfo: { hasNextPage: false, endCursor: null },
  };
  assert.deepEqual(normalizeLinearIssue(payload, profile).dispatchability_reasons,
    ["missing_readiness_attestation"]);
});

test("inverse blocks relation yields blockers while forward blocks relation is ignored", () => {
  const completed = issueFixture();
  completed.inverseRelations = {
    nodes: [{
      type: "blocks",
      issue: {
        id: "blocker-1",
        identifier: "MOX-233",
        state: { id: "other-team-shipped", name: "Shipped", type: "completed" },
      },
    }],
    pageInfo: { hasNextPage: false, endCursor: null },
  };
  completed.relations = {
    nodes: [{
      type: "blocks",
      issue: {
        id: "dependent-1",
        identifier: "MOX-231",
        state: { id: "todo", name: "Todo", type: "unstarted" },
      },
    }],
  };
  const ready = normalizeLinearIssue(completed, profile);
  assert.equal(ready.dispatchable, true);
  assert.deepEqual(ready.blocked_by, [{
    id: "blocker-1",
    identifier: "MOX-233",
    state: "Shipped",
  }]);
  assert.ok(
    !ready.blocked_by.some((blocker) => blocker.identifier === "MOX-231"),
  );

  for (const type of ["started", "canceled", "duplicate"] as const) {
    const blocked = structuredClone(completed);
    const relation = (blocked.inverseRelations as {
      nodes: Array<{
        issue: {
          state: { type: string };
        };
      }>;
    }).nodes[0];
    relation.issue.state.type = type;
    const result = normalizeLinearIssue(blocked, profile);
    assert.equal(result.dispatchable, false, type);
    assert.ok(
      result.dispatchability_reasons.includes("blocker_not_accepted"),
      type,
    );
  }
});

test("unknown or malformed native graph state fails closed", () => {
  const unknownBlocker = issueFixture();
  unknownBlocker.inverseRelations = {
    nodes: [{
      type: "blocks",
      issue: {
        id: "blocker-1",
        identifier: "MOX-999",
        state: { id: "state-new", name: "Mystery", type: "future" },
      },
    }],
    pageInfo: { hasNextPage: false, endCursor: null },
  };
  assert.deepEqual(
    normalizeLinearIssue(unknownBlocker, profile).dispatchability_reasons,
    ["blocker_relation_malformed", "blocker_state_unknown"],
  );

  const truncatedBlockers = issueFixture();
  truncatedBlockers.inverseRelations = {
    nodes: [],
    pageInfo: { hasNextPage: true, endCursor: "relation-50" },
  };
  assert.ok(
    normalizeLinearIssue(truncatedBlockers, profile).dispatchability_reasons
      .includes("blocker_relation_malformed"),
  );

  const truncatedLabels = issueFixture();
  truncatedLabels.labels = {
    nodes: (truncatedLabels.labels as { nodes: unknown[] }).nodes,
    pageInfo: { hasNextPage: true, endCursor: "label-250" },
  };
  assert.ok(
    normalizeLinearIssue(truncatedLabels, profile).dispatchability_reasons
      .includes("labels_malformed"),
  );

  const malformedParent = issueFixture();
  malformedParent.parent = { id: "parent-1" };
  assert.ok(
    normalizeLinearIssue(malformedParent, profile).dispatchability_reasons
      .includes("parent_malformed"),
  );

  const malformedChild = issueFixture();
  malformedChild.children = {
    nodes: [{ id: "child-1" }],
    pageInfo: { hasNextPage: true, endCursor: "child-1" },
  };
  const childResult = normalizeLinearIssue(malformedChild, profile);
  assert.equal(childResult.dispatchable, false);
  assert.ok(
    childResult.dispatchability_reasons.includes("sub_issue_malformed"),
  );
  assert.ok(
    childResult.dispatchability_reasons.includes("sub_issues_truncated"),
  );
  assert.ok(childResult.dispatchability_reasons.includes("non_leaf"));
});

test("legacy issues without hierarchy metadata use the explicit attested root path", () => {
  const payload = issueFixture();
  payload.parent = null;
  const issue = normalizeLinearIssue(payload, profile);
  assert.equal(issue.dispatchable, true);
  assert.equal(issue.native_ref.hierarchy_mode, "standalone_compatibility");
  (payload.labels as { nodes: Array<{ name: string }> }).nodes = [{
    name: "Implementation",
  }];
  const unattested = normalizeLinearIssue(payload, profile);
  assert.equal(unattested.dispatchable, false);
  assert.ok(
    unattested.dispatchability_reasons.includes(
      "missing_readiness_attestation",
    ),
  );
});

test("mapping, scope, labels, and core payload failures are deterministic", () => {
  assert.deepEqual(
    normalizeLinearIssue(issueFixture(), createLinearAdapterProfile())
      .dispatchability_reasons,
    ["mapping_unavailable"],
  );
  const invalidMapping = createLinearAdapterProfile({
    projectId: "bad scope",
    repository: "not-a-repository",
    baseBranch: "-invalid",
  });
  assert.deepEqual(
    normalizeLinearIssue(issueFixture(), invalidMapping)
      .dispatchability_reasons,
    ["mapping_invalid", "project_scope_mismatch"],
  );

  const mismatched = issueFixture();
  mismatched.project = { id: "another-project" };
  mismatched.team = { id: "another-team" };
  assert.deepEqual(
    normalizeLinearIssue(mismatched, profile).dispatchability_reasons,
    ["project_scope_mismatch", "team_scope_mismatch"],
  );

  const malformedLabels = issueFixture();
  malformedLabels.labels = { unexpected: [] };
  assert.deepEqual(
    normalizeLinearIssue(malformedLabels, profile).dispatchability_reasons,
    [
      "labels_malformed",
      "missing_readiness_attestation",
    ],
  );

  const malformedCore = issueFixture();
  malformedCore.title = "";
  assert.throws(
    () => normalizeLinearIssue(malformedCore, profile),
    (error: unknown) =>
      error instanceof LinearAdapterError &&
      error.category === "tracker_response" &&
      error.code === "linear_issue_title_missing",
  );
});

test("unusable optional provider fields normalize without changing eligibility", () => {
  const payload = issueFixture();
  payload.priority = 1.5;
  payload.branchName = 42;
  payload.url = "";
  payload.assignee = null;
  payload.createdAt = "not-a-date";
  payload.updatedAt = null;
  const issue = normalizeLinearIssue(payload, profile);
  assert.equal(issue.dispatchable, true);
  assert.equal(issue.priority, null);
  assert.equal(issue.branch_name, null);
  assert.equal(issue.url, null);
  assert.equal(issue.assignee_id, null);
  assert.equal(issue.created_at, null);
  assert.equal(issue.updated_at, null);
});
