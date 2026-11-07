export type Attribute =
  | null
  | boolean
  | number
  | string
  | Attribute[]
  | { [key: string]: Attribute };
export interface EventInput {
  eventName: string;
  source: string;
  sessionId: string;
  requestId?: string;
  timestamp?: string;
  severityText?: "INFO" | "WARN" | "ERROR";
  summary?: string;
  attributes?: Record<string, unknown>;
}
export interface AuditRecord {
  schemaVersion: 1;
  eventId: string;
  timestamp: string;
  observedTimestamp: string;
  eventName: string;
  source: string;
  sessionId: string;
  requestId?: string;
  severityText: "INFO" | "WARN" | "ERROR";
  summary?: string;
  attributes: Record<string, Attribute>;
}
export interface Filters {
  sessionId?: string;
  requestId?: string;
  eventName?: string;
  source?: string;
  since?: string;
  until?: string;
  after?: string;
  limit?: number;
}
export interface QueryResult {
  records: AuditRecord[];
  nextCursor?: string;
}
export interface StorageOptions {
  maxFileBytes?: number;
  maxTotalBytes?: number;
}
