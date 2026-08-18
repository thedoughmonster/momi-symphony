export const LINEAR_ADAPTER_PROFILE_VERSION = "mox-linear-v1" as const;

export type LinearStatusType =
  | "backlog"
  | "unstarted"
  | "started"
  | "completed"
  | "canceled"
  | "duplicate";

export type LinearDispatchabilityReason =
  | "mapping_unavailable"
  | "mapping_invalid"
  | "project_scope_mismatch"
  | "team_scope_mismatch"
  | "labels_malformed"
  | "missing_implementation_scope"
  | "missing_readiness_attestation"
  | "missing_acceptance_criteria"
  | "blocking_discovery_required"
  | "unresolved_material_decision"
  | "parent_malformed"
  | "sub_issue_malformed"
  | "sub_issues_truncated"
  | "non_leaf"
  | "blocker_relation_malformed"
  | "blocker_state_unknown"
  | "blocker_not_accepted";

export type LinearAdapterProfile = {
  version: typeof LINEAR_ADAPTER_PROFILE_VERSION;
  projectId: string | null;
  teamId: string | null;
  repository: string | null;
  baseBranch: string | null;
  implementationLabels: readonly string[];
  readinessLabels: readonly string[];
  discoveryBlockingLabels: readonly string[];
  decisionBlockingLabels: readonly string[];
  acceptedBlockerStateTypes: readonly LinearStatusType[];
  compatibility: "allow_attested_standalone_root";
};

export type LinearBlockerRef = {
  id: string | null;
  identifier: string | null;
  state: string | null;
};

export type LinearNativeIssueRef = LinearBlockerRef & {
  state_id: string | null;
  state_type: LinearStatusType | null;
};

export type LinearNativeRef = {
  provider: "linear";
  issue_id: string;
  project_id: string | null;
  team_id: string | null;
  repository: string | null;
  base_branch: string | null;
  hierarchy_mode: "native_child" | "native_parent" | "standalone_compatibility";
  parent: LinearNativeIssueRef | null;
  sub_issues: LinearNativeIssueRef[];
  sub_issues_complete: boolean;
  parent_progress: {
    total: number;
    terminal: number;
    completed: number;
    complete: boolean;
  } | null;
};

export type NormalizedLinearIssue = {
  id: string;
  native_ref: LinearNativeRef;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branch_name: string | null;
  url: string | null;
  assignee_id: string | null;
  labels: string[];
  blocked_by: LinearBlockerRef[];
  dispatchable: boolean;
  dispatchability_reasons: LinearDispatchabilityReason[];
  created_at: string | null;
  updated_at: string | null;
};

export type LinearReadinessInput = {
  description: string | null;
  labels: readonly string[];
  labelsMalformed: boolean;
  projectId: string | null;
  teamId: string | null;
  parent: LinearNativeIssueRef | null;
  parentMalformed: boolean;
  subIssues: readonly LinearNativeIssueRef[];
  subIssuesMalformed: boolean;
  subIssuesComplete: boolean;
  blockers: readonly LinearNativeIssueRef[];
  blockerRelationsMalformed: boolean;
};

export class LinearAdapterError extends Error {
  readonly category:
    | "invalid_tracker_config"
    | "tracker_response"
    | "tracker_pagination";
  readonly code: string;

  constructor(
    category:
      | "invalid_tracker_config"
      | "tracker_response"
      | "tracker_pagination",
    code: string,
  ) {
    super(code);
    this.name = "LinearAdapterError";
    this.category = category;
    this.code = code;
  }
}

export function createLinearAdapterProfile(mapping: {
  projectId?: string | null;
  teamId?: string | null;
  repository?: string | null;
  baseBranch?: string | null;
} = {}): LinearAdapterProfile {
  return {
    version: LINEAR_ADAPTER_PROFILE_VERSION,
    projectId: cleanOptional(mapping.projectId),
    teamId: cleanOptional(mapping.teamId),
    repository: cleanOptional(mapping.repository),
    baseBranch: cleanOptional(mapping.baseBranch),
    implementationLabels: ["implementation"],
    readinessLabels: ["ready-package"],
    discoveryBlockingLabels: ["needs-discovery"],
    decisionBlockingLabels: ["blocked-external-decision"],
    acceptedBlockerStateTypes: ["completed"],
    compatibility: "allow_attested_standalone_root",
  };
}

export function deriveLinearDispatchability(
  issue: LinearReadinessInput,
  profile: LinearAdapterProfile,
): { dispatchable: boolean; reasons: LinearDispatchabilityReason[] } {
  const reasons: LinearDispatchabilityReason[] = [];
  const add = (reason: LinearDispatchabilityReason) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  if (!profile.projectId || !profile.repository || !profile.baseBranch) {
    add("mapping_unavailable");
  } else if (
    !validScopeId(profile.projectId) || !validRepository(profile.repository) ||
    !validBaseBranch(profile.baseBranch)
  ) {
    add("mapping_invalid");
  }
  if (profile.projectId && issue.projectId !== profile.projectId) {
    add("project_scope_mismatch");
  }
  if (profile.teamId && issue.teamId !== profile.teamId) {
    add("team_scope_mismatch");
  }
  if (issue.labelsMalformed) add("labels_malformed");
  if (!hasAnyLabel(issue.labels, profile.implementationLabels)) {
    add("missing_implementation_scope");
  }
  if (!hasEveryLabel(issue.labels, profile.readinessLabels)) {
    add("missing_readiness_attestation");
  }
  if (!hasAcceptanceCriteria(issue.description)) {
    add("missing_acceptance_criteria");
  }
  if (hasAnyLabel(issue.labels, profile.discoveryBlockingLabels)) {
    add("blocking_discovery_required");
  }
  if (hasAnyLabel(issue.labels, profile.decisionBlockingLabels)) {
    add("unresolved_material_decision");
  }
  if (issue.parentMalformed) add("parent_malformed");
  if (issue.subIssuesMalformed) add("sub_issue_malformed");
  if (!issue.subIssuesComplete) add("sub_issues_truncated");
  if (issue.subIssues.length > 0) add("non_leaf");
  if (issue.blockerRelationsMalformed) add("blocker_relation_malformed");
  for (const blocker of issue.blockers) {
    if (!blocker.state_type || !isKnownStateType(blocker.state_type)) {
      add("blocker_state_unknown");
    } else if (
      !profile.acceptedBlockerStateTypes.includes(blocker.state_type)
    ) {
      add("blocker_not_accepted");
    }
  }
  return { dispatchable: reasons.length === 0, reasons };
}

export function normalizeLinearIssue(
  payload: unknown,
  profile: LinearAdapterProfile,
): NormalizedLinearIssue {
  const issue = asRecord(payload);
  if (!issue) throw responseError("linear_issue_not_object");
  const id = requiredText(issue.id, "linear_issue_id_missing");
  const identifier = requiredText(
    issue.identifier,
    "linear_issue_identifier_missing",
  );
  const title = requiredText(issue.title, "linear_issue_title_missing");
  const stateObject = asRecord(issue.state);
  const state = requiredText(stateObject?.name, "linear_issue_state_missing");
  const description = optionalBody(issue.description);
  const labelsResult = decodeLabels(issue.labels);
  const parentResult = decodeOptionalIssueRef(issue.parent, id);
  const subIssuesResult = decodeSubIssues(issue.children, id);
  const blockersResult = decodeBlockers(issue.inverseRelations, id);
  const projectId = optionalText(asRecord(issue.project)?.id);
  const teamId = optionalText(asRecord(issue.team)?.id);
  const readiness = deriveLinearDispatchability({
    description,
    labels: labelsResult.labels,
    labelsMalformed: labelsResult.malformed,
    projectId,
    teamId,
    parent: parentResult.ref,
    parentMalformed: parentResult.malformed,
    subIssues: subIssuesResult.refs,
    subIssuesMalformed: subIssuesResult.malformed,
    subIssuesComplete: subIssuesResult.complete,
    blockers: blockersResult.refs,
    blockerRelationsMalformed: blockersResult.malformed,
  }, profile);
  const hierarchyMode = parentResult.ref
    ? "native_child"
    : subIssuesResult.refs.length > 0
    ? "native_parent"
    : "standalone_compatibility";
  const progress = subIssuesResult.refs.length === 0 ? null : {
    total: subIssuesResult.refs.length,
    terminal:
      subIssuesResult.refs.filter((child) =>
        child.state_type === "completed" || child.state_type === "canceled" ||
        child.state_type === "duplicate"
      ).length,
    completed:
      subIssuesResult.refs.filter((child) => child.state_type === "completed")
        .length,
    complete: subIssuesResult.complete,
  };
  return {
    id,
    native_ref: {
      provider: "linear",
      issue_id: id,
      project_id: projectId,
      team_id: teamId,
      repository: profile.repository,
      base_branch: profile.baseBranch,
      hierarchy_mode: hierarchyMode,
      parent: parentResult.ref,
      sub_issues: subIssuesResult.refs,
      sub_issues_complete: subIssuesResult.complete,
      parent_progress: progress,
    },
    identifier,
    title,
    description,
    priority: Number.isInteger(issue.priority)
      ? issue.priority as number
      : null,
    state,
    branch_name: optionalText(issue.branchName),
    url: optionalText(issue.url),
    assignee_id: optionalText(asRecord(issue.assignee)?.id),
    labels: labelsResult.labels,
    blocked_by: blockersResult.refs.map((
      { id: blockerId, identifier: blockerIdentifier, state: blockerState },
    ) => ({
      id: blockerId,
      identifier: blockerIdentifier,
      state: blockerState,
    })),
    dispatchable: readiness.dispatchable,
    dispatchability_reasons: readiness.reasons,
    created_at: normalizedInstant(issue.createdAt),
    updated_at: normalizedInstant(issue.updatedAt),
  };
}

function decodeLabels(
  value: unknown,
): { labels: string[]; malformed: boolean } {
  const connection = asRecord(value);
  if (!connection || !Array.isArray(connection.nodes)) {
    return { labels: [], malformed: true };
  }
  const pageInfo = asRecord(connection.pageInfo);
  let malformed = !pageInfo || typeof pageInfo.hasNextPage !== "boolean" ||
    pageInfo.hasNextPage === true;
  const labels = connection.nodes.flatMap((node) => {
    const name = optionalText(asRecord(node)?.name)?.toLowerCase();
    if (!name) {
      malformed = true;
      return [];
    }
    return [name];
  });
  return { labels: [...new Set(labels)].sort(), malformed };
}

function decodeOptionalIssueRef(
  value: unknown,
  issueId: string,
): { ref: LinearNativeIssueRef | null; malformed: boolean } {
  if (value === null) return { ref: null, malformed: false };
  const record = asRecord(value);
  if (!record) return { ref: null, malformed: true };
  const decoded = decodeIssueRef(record);
  return {
    ref: decoded.ref,
    malformed: decoded.malformed || decoded.ref.id === issueId,
  };
}

function decodeSubIssues(
  value: unknown,
  issueId: string,
): { refs: LinearNativeIssueRef[]; malformed: boolean; complete: boolean } {
  const connection = asRecord(value);
  if (!connection || !Array.isArray(connection.nodes)) {
    return { refs: [], malformed: true, complete: false };
  }
  const pageInfo = asRecord(connection.pageInfo);
  const complete = pageInfo?.hasNextPage === false;
  let malformed = !pageInfo || typeof pageInfo.hasNextPage !== "boolean";
  const refs = connection.nodes.flatMap((node) => {
    const decoded = decodeIssueRef(asRecord(node));
    malformed ||= decoded.malformed || decoded.ref.id === issueId;
    return decoded.ref.id || decoded.ref.identifier || decoded.ref.state
      ? [decoded.ref]
      : [];
  });
  return { refs: sortRefs(refs), malformed, complete };
}

function decodeBlockers(
  value: unknown,
  issueId: string,
): { refs: LinearNativeIssueRef[]; malformed: boolean } {
  const connection = asRecord(value);
  if (!connection || !Array.isArray(connection.nodes)) {
    return { refs: [], malformed: true };
  }
  const pageInfo = asRecord(connection.pageInfo);
  let malformed = !pageInfo || typeof pageInfo.hasNextPage !== "boolean" ||
    pageInfo.hasNextPage === true;
  const refs = connection.nodes.flatMap((node) => {
    const relation = asRecord(node);
    const type = optionalText(relation?.type)?.toLowerCase();
    if (!type) {
      malformed = true;
      return [];
    }
    if (type !== "blocks") return [];
    // Linear represents B --blocks--> A on A.inverseRelations as {type: blocks,
    // issue: B}. A.relations contains A --blocks--> C and is intentionally not
    // an input here, so blocked_by can never be inverted into issues A blocks.
    const decoded = decodeIssueRef(asRecord(relation?.issue));
    malformed ||= decoded.malformed || decoded.ref.id === issueId;
    return [decoded.ref];
  });
  const unique = new Map<string, LinearNativeIssueRef>();
  for (const ref of refs) {
    unique.set(ref.id ?? ref.identifier ?? JSON.stringify(ref), ref);
  }
  return { refs: sortRefs([...unique.values()]), malformed };
}

function decodeIssueRef(value: Record<string, unknown> | null): {
  ref: LinearNativeIssueRef;
  malformed: boolean;
} {
  const state = asRecord(value?.state);
  const stateTypeValue = optionalText(state?.type)?.toLowerCase();
  const stateType = isKnownStateType(stateTypeValue) ? stateTypeValue : null;
  const ref = {
    id: optionalText(value?.id),
    identifier: optionalText(value?.identifier),
    state: optionalText(state?.name),
    state_id: optionalText(state?.id),
    state_type: stateType,
  };
  return {
    ref,
    malformed: !ref.id || !ref.identifier || !ref.state || !ref.state_id ||
      !stateType,
  };
}

function hasAcceptanceCriteria(description: string | null): boolean {
  if (!description) return false;
  const lines = description.replace(/\r\n?/g, "\n").split("\n");
  const heading = lines.findIndex((line) =>
    /^##\s+(?:\d+\.\s+)?acceptance criteria\s*$/i.test(line.trim())
  );
  if (heading < 0) return false;
  for (const line of lines.slice(heading + 1)) {
    if (/^##\s+/.test(line.trim())) break;
    if (/^\s*(?:[-*+] |\d+\. )\S/.test(line)) return true;
  }
  return false;
}

function hasAnyLabel(
  labels: readonly string[],
  expected: readonly string[],
): boolean {
  const present = new Set(labels.map((label) => label.trim().toLowerCase()));
  return expected.some((label) => present.has(label.trim().toLowerCase()));
}

function hasEveryLabel(
  labels: readonly string[],
  expected: readonly string[],
): boolean {
  const present = new Set(labels.map((label) => label.trim().toLowerCase()));
  return expected.every((label) => present.has(label.trim().toLowerCase()));
}

function validRepository(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value);
}

function validBaseBranch(value: string): boolean {
  return !value.startsWith("-") && !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.endsWith(".lock") && !value.includes("..") &&
    !value.includes("//") &&
    !value.includes("@{") && /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(value);
}

export function validScopeId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function normalizedInstant(value: unknown): string | null {
  const text = optionalText(value);
  if (!text) return null;
  const milliseconds = Date.parse(text);
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : null;
}

function isKnownStateType(value: unknown): value is LinearStatusType {
  return [
    "backlog",
    "unstarted",
    "started",
    "completed",
    "canceled",
    "duplicate",
  ]
    .includes(String(value));
}

function sortRefs(refs: LinearNativeIssueRef[]): LinearNativeIssueRef[] {
  return refs.sort((left, right) =>
    String(left.identifier ?? left.id).localeCompare(
      String(right.identifier ?? right.id),
    )
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredText(value: unknown, code: string): string {
  const text = optionalText(value);
  if (!text) throw responseError(code);
  return text;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalBody(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function cleanOptional(value: string | null | undefined): string | null {
  return optionalText(value);
}

function responseError(code: string): LinearAdapterError {
  return new LinearAdapterError("tracker_response", code);
}
