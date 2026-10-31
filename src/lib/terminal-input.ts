const CHUNK_BYTES = 8 * 1024;
const MAX_PENDING_BYTES = 256 * 1024;

/** Keep IPC writes ordered, including pastes split in the middle of UTF-8. */
export class TerminalInputQueue {
  private chunks: Uint8Array[] = [];
  private pendingBytes = 0;
  private sending = false;
  private stopped = false;

  constructor(
    private send: (data: number[]) => Promise<void>,
    private onError: (error: unknown) => void,
  ) {}

  write(data: Uint8Array) {
    if (this.stopped || !data.length) return;
    if (this.pendingBytes + data.length > MAX_PENDING_BYTES) {
      this.fail(new Error("Terminal input exceeded 256 KiB. Reconnect before continuing."));
      return;
    }
    this.pendingBytes += data.length;
    for (let offset = 0; offset < data.length; offset += CHUNK_BYTES) {
      this.chunks.push(data.slice(offset, offset + CHUNK_BYTES));
    }
    void this.flush();
  }

  stop() {
    this.stopped = true;
    this.chunks = [];
    this.pendingBytes = 0;
  }

  private fail(error: unknown) {
    if (this.stopped) return;
    this.stop();
    this.onError(error);
  }

  private async flush() {
    if (this.sending || this.stopped) return;
    this.sending = true;
    try {
      while (!this.stopped && this.chunks.length) {
        const chunk = this.chunks.shift()!;
        await this.send(Array.from(chunk));
        if (!this.stopped) this.pendingBytes -= chunk.length;
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.sending = false;
    }
  }
}
