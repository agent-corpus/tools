# @agent-corpus/audit-log

## 0.1.1

### Patch Changes

- On Windows, a writer that meets a lock file another writer is still deleting now reports the log as busy (exit code 2, retry) instead of a storage failure (exit code 1).
