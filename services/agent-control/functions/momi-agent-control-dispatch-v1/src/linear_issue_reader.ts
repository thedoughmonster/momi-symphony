import { linearGraphql } from "./linear_graphql.ts";
import {
  LinearAdapterError,
  normalizeLinearIssue,
  validScopeId,
} from "./linear_issue_adapter.ts";
import type {
  LinearAdapterProfile,
  NormalizedLinearIssue,
} from "./linear_issue_adapter.ts";

export type LinearAdapterEvidence = {
  operation: "candidate";
  reason: string;
  issue_id: string | null;
  issue_identifier: string | null;
};

export type LinearQuery = <T>(
  query: string,
  variables: Record<string, unknown>,
) => Promise<T>;

type CandidateConnection = {
  nodes?: unknown;
  pageInfo?: { hasNextPage?: unknown; endCursor?: unknown };
};

const ISSUE_FIELDS = `
  id identifier title description priority branchName url createdAt updatedAt
  state { id name type }
  assignee { id }
  project { id }
  team { id }
  labels(first: 250) {
    nodes { id name }
    pageInfo { hasNextPage endCursor }
  }
  parent { id identifier state { id name type } }
  children(first: 50) {
    nodes { id identifier state { id name type } }
    pageInfo { hasNextPage endCursor }
  }
  inverseRelations(first: 50) {
    nodes { type issue { id identifier state { id name type } } }
    pageInfo { hasNextPage endCursor }
  }
`;

const CANDIDATE_QUERY = `query AgentControlCandidateIssues(
  $projectId: ID!, $states: [String!]!, $after: String
) {
  issues(
    filter: { project: { id: { eq: $projectId } }, state: { name: { in: $states } } }
    first: 50
    after: $after
  ) {
    nodes { ${ISSUE_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
}`;

const REFRESH_QUERY =
  `query AgentControlRefreshIssues($projectId: ID!, $ids: [ID!]!) {
  issues(
    filter: { project: { id: { eq: $projectId } }, id: { in: $ids } }
    first: 50
  ) {
    nodes { ${ISSUE_FIELDS} }
  }
}`;

export async function fetchLinearCandidateIssues(
  stateNames: readonly string[],
  profile: LinearAdapterProfile,
  query: LinearQuery = linearGraphql,
  evidence?: (event: LinearAdapterEvidence) => void,
): Promise<NormalizedLinearIssue[]> {
  if (stateNames.length === 0) return [];
  const projectId = requiredProjectId(profile);
  const states = [
    ...new Set(stateNames.map((state) => state.trim()).filter(Boolean)),
  ];
  if (states.length === 0) return [];
  const result: NormalizedLinearIssue[] = [];
  const cursors = new Set<string>();
  let after: string | null = null;
  do {
    const data = await query<{ issues?: CandidateConnection }>(
      CANDIDATE_QUERY,
      { projectId, states, after },
    );
    const connection = data.issues;
    if (
      !connection || !Array.isArray(connection.nodes) || !connection.pageInfo ||
      typeof connection.pageInfo.hasNextPage !== "boolean"
    ) {
      throw new LinearAdapterError(
        "tracker_response",
        "linear_candidate_payload_malformed",
      );
    }
    for (const payload of connection.nodes) {
      try {
        result.push(normalizeLinearIssue(payload, profile));
      } catch (error) {
        if (
          !(error instanceof LinearAdapterError) ||
          error.category !== "tracker_response"
        ) {
          throw error;
        }
        const raw = record(payload);
        evidence?.({
          operation: "candidate",
          reason: error.code,
          issue_id: safeIdentity(raw?.id),
          issue_identifier: safeIdentity(raw?.identifier),
        });
      }
    }
    if (!connection.pageInfo.hasNextPage) break;
    const next = text(connection.pageInfo.endCursor);
    if (!next || cursors.has(next)) {
      throw new LinearAdapterError(
        "tracker_pagination",
        "linear_candidate_cursor_invalid",
      );
    }
    cursors.add(next);
    after = next;
  } while (true);
  return uniqueIssues(result);
}

export async function refreshLinearIssues(
  issueIds: readonly string[],
  profile: LinearAdapterProfile,
  query: LinearQuery = linearGraphql,
): Promise<NormalizedLinearIssue[]> {
  const ids = [...new Set(issueIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return [];
  const projectId = requiredProjectId(profile);
  const requested = new Set(ids);
  const result: NormalizedLinearIssue[] = [];
  for (let offset = 0; offset < ids.length; offset += 50) {
    const chunk = ids.slice(offset, offset + 50);
    const data = await query<{ issues?: { nodes?: unknown } }>(REFRESH_QUERY, {
      projectId,
      ids: chunk,
    });
    if (!data.issues || !Array.isArray(data.issues.nodes)) {
      throw new LinearAdapterError(
        "tracker_response",
        "linear_refresh_payload_malformed",
      );
    }
    for (const payload of data.issues.nodes) {
      const normalized = normalizeLinearIssue(payload, profile);
      if (!requested.has(normalized.id)) {
        throw new LinearAdapterError(
          "tracker_response",
          "linear_refresh_unrequested_issue",
        );
      }
      result.push(normalized);
    }
  }
  return uniqueIssues(result);
}

function requiredProjectId(profile: LinearAdapterProfile): string {
  if (!profile.projectId || !validScopeId(profile.projectId)) {
    throw new LinearAdapterError(
      "invalid_tracker_config",
      "linear_project_scope_missing",
    );
  }
  return profile.projectId;
}

function uniqueIssues(
  issues: NormalizedLinearIssue[],
): NormalizedLinearIssue[] {
  const unique = new Map<string, NormalizedLinearIssue>();
  for (const issue of issues) {
    if (unique.has(issue.id)) {
      throw new LinearAdapterError(
        "tracker_response",
        "linear_duplicate_issue_identity",
      );
    }
    unique.set(issue.id, issue);
  }
  return [...unique.values()].sort((left, right) =>
    left.identifier.localeCompare(right.identifier)
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeIdentity(value: unknown): string | null {
  const identity = text(value);
  return identity && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(identity)
    ? identity
    : null;
}
