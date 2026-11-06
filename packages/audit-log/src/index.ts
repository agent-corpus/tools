import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { parseRecord, record, timestamp } from "./schema.js";
import type { AuditRecord, EventInput, Filters, QueryResult, StorageOptions } from "./types.js";

export type {
  Attribute,
  AuditRecord,
  EventInput,
  Filters,
  QueryResult,
  StorageOptions,
} from "./types.js";

const maxRecordBytes = 64 * 1024;
export class AuditBusyError extends Error {
  constructor() {
    super("Audit log is busy; retry after the current operation");
    this.name = "AuditBusyError";
  }
}
export class AuditLog {
  readonly directory: string;
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;
  constructor(directory: string, options: StorageOptions = {}) {
    this.directory = resolve(directory);
    this.maxFileBytes = options.maxFileBytes ?? 10 * 1024 * 1024;
    this.maxTotalBytes = options.maxTotalBytes ?? 100 * 1024 * 1024;
    if (
      ![this.maxFileBytes, this.maxTotalBytes].every((n) => Number.isSafeInteger(n) && n > 0) ||
      this.maxFileBytes > this.maxTotalBytes
    )
      throw new Error("Invalid audit storage limits");
  }
  private checkedDirectory(create: boolean): string | undefined {
    if (!existsSync(this.directory)) {
      if (!create) return undefined;
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    }
    const stat = lstatSync(this.directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))
    )
      throw new Error("Audit directory must be private and owned by the current user");
    return realpathSync(this.directory);
  }
  private locked<T>(directory: string, operation: () => T): T {
    const path = join(directory, "audit.lock");
    let fd: number;
    try {
      fd = openSync(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new AuditBusyError();
      throw error;
    }
    try {
      return operation();
    } finally {
      closeSync(fd);
      unlinkSync(path);
    }
  }
  private checkedFile(path: string, flags: number): number {
    try {
      if (!lstatSync(path).isFile())
        throw new Error("Audit files must be regular files without symbolic links");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const fd = openSync(path, flags | constants.O_NOFOLLOW, 0o600);
    try {
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))
      )
        throw new Error("Audit file must be private, regular, and owned by the current user");
      return fd;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }
  private segments(directory: string): string[] {
    return readdirSync(directory)
      .filter((name) => /^audit\.\d{8}\.jsonl$/.test(name))
      .sort();
  }
  append(input: EventInput): AuditRecord {
    const entry = record(input);
    const bytes = Buffer.from(`${JSON.stringify(entry)}\n`);
    if (bytes.length > maxRecordBytes || bytes.length > this.maxFileBytes)
      throw new Error("Audit event exceeds the record or segment limit");
    const directory = this.checkedDirectory(true);
    if (!directory) throw new Error("Audit directory unavailable");
    return this.locked(directory, () => {
      const segments = this.segments(directory);
      const active = join(directory, "audit.jsonl");
      let total = 0;
      for (const name of [...segments, ...(existsSync(active) ? ["audit.jsonl"] : [])]) {
        const fd = this.checkedFile(join(directory, name), constants.O_RDONLY);
        try {
          total += fstatSync(fd).size;
        } finally {
          closeSync(fd);
        }
      }
      if (total + bytes.length > this.maxTotalBytes)
        throw new Error(
          "Audit storage limit reached; preserve or relocate the logs before continuing",
        );
      if (existsSync(active)) {
        const fd = this.checkedFile(active, constants.O_RDONLY);
        let size: number;
        try {
          size = fstatSync(fd).size;
          if (size > 0) {
            const tail = Buffer.alloc(1);
            readSync(fd, tail, 0, 1, size - 1);
            if (tail[0] !== 10)
              throw new Error("Audit file has an incomplete record; preserve it for investigation");
          }
        } finally {
          closeSync(fd);
        }
        if (size + bytes.length > this.maxFileBytes) {
          const next = Number(segments.at(-1)?.slice(6, 14) ?? 0) + 1;
          if (next > 99999999) throw new Error("Audit segment limit reached");
          renameSync(active, join(directory, `audit.${String(next).padStart(8, "0")}.jsonl`));
        }
      }
      const fd = this.checkedFile(
        active,
        constants.O_CREAT | constants.O_APPEND | constants.O_RDWR,
      );
      try {
        let offset = 0;
        while (offset < bytes.length) {
          const written = writeSync(fd, bytes, offset, bytes.length - offset);
          if (written === 0) throw new Error("Audit write did not complete");
          offset += written;
        }
        fchmodSync(fd, 0o600);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return entry;
    });
  }
  private async *records(): AsyncGenerator<AuditRecord> {
    const directory = this.checkedDirectory(false);
    if (!directory) return;
    const files = this.locked(directory, () => {
      const result: { fd: number; size: number }[] = [];
      try {
        for (const name of [
          ...this.segments(directory),
          ...(existsSync(join(directory, "audit.jsonl")) ? ["audit.jsonl"] : []),
        ]) {
          const fd = this.checkedFile(join(directory, name), constants.O_RDONLY);
          result.push({ fd, size: fstatSync(fd).size });
        }
        return result;
      } catch (error) {
        for (const file of result) closeSync(file.fd);
        throw error;
      }
    });
    try {
      for (const file of files) {
        if (file.size === 0) continue;
        const decoder = new StringDecoder("utf8"),
          chunk = Buffer.alloc(64 * 1024);
        let buffer = "",
          position = 0;
        while (position < file.size) {
          const read = readSync(
            file.fd,
            chunk,
            0,
            Math.min(chunk.length, file.size - position),
            position,
          );
          if (read === 0) throw new Error("Audit file changed during the read");
          position += read;
          buffer += decoder.write(chunk.subarray(0, read));
          if (position === file.size) buffer += decoder.end();
          let end = buffer.indexOf("\n");
          while (end >= 0) {
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            if (Buffer.byteLength(line) > maxRecordBytes)
              throw new Error("Audit record exceeds the read limit");
            let entry: AuditRecord;
            try {
              entry = parseRecord(line);
            } catch {
              throw new Error("Invalid audit record; preserve the log for investigation");
            }
            yield entry;
            end = buffer.indexOf("\n");
          }
          if (Buffer.byteLength(buffer) > maxRecordBytes)
            throw new Error("Audit record exceeds the read limit");
        }
        if (buffer.length) throw new Error("Audit file has an incomplete record");
      }
    } finally {
      for (const file of files) closeSync(file.fd);
    }
  }
  private async *matching(filters: Filters): AsyncGenerator<AuditRecord> {
    if (
      filters.limit !== undefined &&
      (!Number.isSafeInteger(filters.limit) || filters.limit < 1 || filters.limit > 10000)
    )
      throw new Error("Use a limit between 1 and 10000");
    const since = filters.since === undefined ? undefined : timestamp(filters.since);
    const until = filters.until === undefined ? undefined : timestamp(filters.until);
    if (since && until && since > until) throw new Error("Invalid audit time range");
    let found = filters.after === undefined;
    for await (const entry of this.records()) {
      if (!found) {
        if (entry.eventId === filters.after) found = true;
        continue;
      }
      if (
        ["sessionId", "requestId", "eventName", "source"].some(
          (key) =>
            filters[key as keyof Filters] !== undefined &&
            filters[key as keyof Filters] !== entry[key as keyof AuditRecord],
        )
      )
        continue;
      if ((since && entry.timestamp < since) || (until && entry.timestamp > until)) continue;
      yield entry;
    }
    if (!found) throw new Error("Audit cursor was not found");
  }
  async query(filters: Filters = {}): Promise<QueryResult> {
    const records: AuditRecord[] = [];
    const limit = filters.limit ?? 1000;
    for await (const entry of this.matching(filters)) {
      if (records.length === limit) return { records, nextCursor: records.at(-1)?.eventId };
      records.push(entry);
    }
    return { records };
  }
  async *export(filters: Filters = {}): AsyncGenerator<string> {
    let count = 0;
    for await (const entry of this.matching(filters)) {
      yield `${JSON.stringify(entry)}\n`;
      if (filters.limit !== undefined && ++count >= filters.limit) return;
    }
  }
}
