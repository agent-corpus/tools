# @agent-corpus/audit-log

## 0.1.1

### Patch Changes

- [#34](https://github.com/agent-corpus/tools/pull/34) On Windows, a writer that meets a lock file another writer is still deleting now reports the log as busy (exit code 2, retry) instead of a storage failure (exit code 1). When the lock is already gone it tries once more; a permission failure that persists without a lock is still reported as a storage failure.
