import assert from "node:assert/strict"
import test from "node:test"

import {
  classifyDecisionCategory, decisionIdentity, decisionRecordMatchesLabel,
  EXCLUDED_DECISION_CATEGORIES, MATERIAL_DECISION_CATEGORIES,
  parseLinearDecisionComment, selectLinearDecision,
} from "../src/decision_record.ts"
import { createLinearAdapterProfile, deriveLinearDispatchability } from
  "../functions/momi-agent-control-dispatch-v1/src/linear_issue_adapter.ts"

function body(overrides: Record<string, unknown> = {}): string {
  return `momi-decision:v1
\`\`\`json
${JSON.stringify({
    decision_key: "mox-232-acceptance",
    category: "material_architecture_ownership",
    status: "unresolved",
    question: "Should the bounded development acceptance use the governed dev-alerts channel?",
    policy_gap: "Repository policy names the boundary but cannot choose an operator-owned Slack destination.",
    recommendation: "Use the existing disabled MoMi development alerts destination for one acceptance.",
    alternatives: ["Stop before delivery", "Create a separately authorized destination"],
    consequences: ["One sanitized development alert is posted", "Production remains untouched"],
    affected_issue_identifiers: ["MOX-232"],
    resolution_summary: null,
    ...overrides,
  }, null, 2)}
\`\`\``
}

test("classification truth table includes only material human decisions", () => {
  for (const category of MATERIAL_DECISION_CATEGORIES) {
    assert.deepEqual(classifyDecisionCategory(category), { alertable: true, category })
  }
  for (const category of EXCLUDED_DECISION_CATEGORIES) {
    assert.deepEqual(classifyDecisionCategory(category), {
      alertable: false, reason: "explicit_technical_exclusion",
    })
  }
  assert.deepEqual(classifyDecisionCategory("uncertain_technical_condition"), {
    alertable: false, reason: "category_unknown",
  })
})

test("strict record parsing produces a stable Linear-owned identity", () => {
  const parsed = parseLinearDecisionComment(body())
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  const selected = selectLinearDecision([{ id: "comment-1", body: body() }])
  assert.equal(selected.reason, "decision_record_valid")
  assert.equal(decisionIdentity("issue-1", selected.decision!),
    "linear:issue-1:comment-1:mox-232-acceptance")
  assert.deepEqual(parsed.record.affected_issue_identifiers, ["MOX-232"])
})

test("invalid, duplicate, excluded, sensitive, and mass-mention records fail closed", () => {
  assert.equal(parseLinearDecisionComment("ordinary comment").ok, false)
  assert.equal(parseLinearDecisionComment(body({ category: "tests_validation" })).ok, false)
  assert.equal(parseLinearDecisionComment(body({ category: "unknown" })).ok, false)
  assert.equal(parseLinearDecisionComment(body({ question: "Send <!channel> this unsafe question" })).ok, false)
  assert.equal(parseLinearDecisionComment(body({ recommendation: "Use token=xoxb-not-allowed" })).ok, false)
  assert.equal(selectLinearDecision([
    { id: "one", body: body() }, { id: "two", body: body({ decision_key: "other-key" }) },
  ]).reason, "decision_record_ambiguous")
})

test("resolution requires the same durable record and label removal", () => {
  const unresolved = selectLinearDecision([{ id: "comment-1", body: body() }]).decision!
  assert.deepEqual(decisionRecordMatchesLabel(unresolved, ["Implementation", "blocked-external-decision"]),
    { eligible: true, reason: "unresolved" })
  assert.equal(decisionRecordMatchesLabel(unresolved, ["Implementation"]).eligible, false)
  const resolved = selectLinearDecision([{ id: "comment-1", body: body({
    status: "resolved", resolution_summary: "Use the governed development alerts destination.",
  }) }]).decision!
  assert.equal(decisionRecordMatchesLabel(resolved, ["blocked-external-decision"]).eligible, false)
  assert.deepEqual(decisionRecordMatchesLabel(resolved, ["Implementation"]),
    { eligible: true, reason: "resolved" })
})

test("Linear resolution restores normalized eligibility when every other condition passes", () => {
  const profile = createLinearAdapterProfile({ projectId: "project-1",
    repository: "thedoughmonster/momi-symphony", baseBranch: "main" })
  const input = {
    description: "## Acceptance criteria\n\n- The fixture is accepted.",
    labels: ["implementation", "ready-package", "blocked-external-decision"],
    labelsMalformed: false, projectId: "project-1", teamId: "team-1",
    parent: null, parentMalformed: false, subIssues: [], subIssuesMalformed: false,
    subIssuesComplete: true, blockers: [], blockerRelationsMalformed: false,
  }
  assert.deepEqual(deriveLinearDispatchability(input, profile).reasons,
    ["unresolved_material_decision"])
  assert.deepEqual(deriveLinearDispatchability({ ...input,
    labels: ["implementation", "ready-package"] }, profile), {
    dispatchable: true, reasons: [],
  })
})
