# Tracking plan version 1

This is the public input contract owned by `@agent-corpus/tracker-core`.
It is independent of any consuming organization's issue templates or operating procedures.
A local JSON file can contain the object directly. A Markdown file or GitHub issue can embed
exactly one fenced `tracking-plan` JSON block.
Consumers with other source formats own the mapping from those formats into this contract.
Validate with `project-watch validate --file FILE`. Unsupported versions and unknown fields fail validation.

```tracking-plan
{
  "version": 1,
  "id": "project-name",
  "name": "Project name",
  "description": "A concise outcome for the project.",
  "units": [
    {
      "id": "planner",
      "title": "Build the planner",
      "status": "planned",
      "dependsOn": [],
      "approval": "pending",
      "outcome": "A user can plan the approved workflow.",
      "verification": "Run the relevant tests and inspect the workflow.",
      "prs": [],
      "evidence": []
    }
  ],
  "decisions": [
    {
      "id": "scope",
      "title": "Confirm the first scope",
      "state": "open",
      "detail": "Record the owner's decision before implementation starts."
    }
  ]
}
```

## Fields

| Field                                  | Contract                                                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `version`                              | Required, exactly `1`.                                                                                          |
| `id`, unit IDs, decision IDs           | Required. 1–80 ASCII letters, digits, dots, underscores, or hyphens. First character must be a letter or digit. |
| `name`, unit `title`, decision `title` | Required, nonempty strings.                                                                                     |
| `description`                          | Optional string; defaults to empty.                                                                             |
| `units`                                | Required array. Unit IDs must be unique within the plan.                                                        |
| unit `status`                          | Required: `planned`, `active`, `blocked`, `done`, or `paused`.                                                  |
| `dependsOn`                            | Unit IDs within this plan. Defaults to `[]`. Missing IDs and cycles fail validation.                            |
| `approval`                             | `pending`, `approved`, or `not-required`. Defaults to `pending`.                                                |
| `approvalEvidence`                     | HTTP(S) URL. Required for `approved`; link the actual owner decision.                                           |
| `outcome`, `verification`              | Optional strings; default to empty. Describe completion and its verification.                                   |
| `prs`                                  | Array of canonical `https://github.com/OWNER/REPO/pull/NUMBER` URLs. Defaults to `[]`.                          |
| `evidence`                             | Array of HTTP(S) URLs. Defaults to `[]`.                                                                        |
| `decisions`                            | Optional array; defaults to `[]`. IDs must be unique within the array.                                          |
| decision `state`                       | Required: `open` or `resolved`.                                                                                 |
| decision `detail`                      | Optional string; defaults to empty.                                                                             |
| decision `source`                      | Optional HTTP(S) URL to the discussion or decision.                                                             |

Objects reject extra fields. Keep detailed task instructions and rationale outside the block.
The validator implementation is `@agent-corpus/tracker-core`; it owns executable validation.

## Meaning

A unit is ready when its status is `planned`, dependencies are `done`, and approval is not `pending`.
Readiness does not start work. Approval reflects a source assertion; the tool cannot authenticate the approver from a URL.
Use `not-required` only when the owner or established policy explicitly permits that scope.
Mark `done` only after verifying the stated outcome. Add evidence links for completed work.
Progress is the count of `done` units divided by all units, including paused and unapproved units.
An empty plan has no percentage. PR merges and task reports never change plan state automatically.

The board identifies a registered project by a stable hash of its source.
Use that ID from `project-watch status` in task reports. Do not use the plan's `id` for reports.
This allows two source plans with the same human-readable ID to remain independent.

## Migration and editing

Read the latest issue body and comments before editing. Preserve the source's explicit decisions and scope boundaries.
Convert known units to stable IDs. Default uncertain approvals to `pending`.
Keep unknown facts explicit in the narrative. Do not manufacture PR links, approvals, verification, or progress.
Keep one structured block and one concise human summary. Collapse long reference material with Markdown details sections.
Do not delete or hide comments merely because their gist was summarized unless the user requested that action.
Validate the full proposed body before writing it. Re-read the source if another session edited it in the meantime.
Existing prose-only issues remain readable source documents, but the board reports that their tracking plan is missing.
