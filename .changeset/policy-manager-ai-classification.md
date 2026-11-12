---
"@agent-corpus/policy-manager": minor
---

Ambiguous requests are decided by the session's AI classifier instead of a person (experiment). Under the permissive profile, an escalation that is not a deterministic security boundary is blocked once with an instruction to classify and retry. The classification approves a recoverable, non-sensitive action or denies it with a reason; a person is asked only if the classifier is unavailable or invalid. Adds audit events and `policy-manager review-classifications` for a risk review, and `replay` reports how many escalations move to the classifier.
