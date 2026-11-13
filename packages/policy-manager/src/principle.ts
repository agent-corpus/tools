/** The rule every harness's classifier is given, and the one the engine enforces. */
export const HUMAN_REVIEW_PRINCIPLE =
  "A human prompt is reserved for high-value, high-impact actions: unrecoverable data loss, credential/secret retrieval, protected config/paths, and profile humanPatterns. Recoverable or disposable effects, including destructive-but-safe ones, are automatic.";
