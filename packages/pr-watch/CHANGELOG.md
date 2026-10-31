# @agent-corpus/pr-watch

## 0.1.1

### Patch Changes

- Fix a CodeQL `js/polynomial-redos` finding by trimming trailing slashes from the API URL with a linear loop, and normalize the `bin` path in `package.json` so npm no longer auto-corrects it on publish.

## 0.1.0

Initial release: `watch`, `status` and `usage` commands; events for base movement/staleness,
conflicts, reviews and comments (standing "changes requested" feedback is reported on start), CI results, head updates and terminal PR states.
