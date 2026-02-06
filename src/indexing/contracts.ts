export interface IndexProgressEvent {
  stage: "fetch" | "prepare" | "embed" | "persist" | "delete" | "rebuild-fts" | "done";
  current: number;
  total: number;
  message: string;
}

export interface IndexRunOptions {
  signal?: AbortSignal;
  onProgress?: (event: IndexProgressEvent) => void;
}

export class IndexCancelledError extends Error {
  constructor(message = "Indexing cancelled") {
    super(message);
    this.name = "IndexCancelledError";
  }
}

export function isIndexCancelledError(error: unknown): error is IndexCancelledError {
  return error instanceof IndexCancelledError;
}

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new IndexCancelledError();
  }
}
