import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { TradeLogRecord } from "../../../../packages/shared/src/types";

export class JsonlTradeLogger {
  constructor(private readonly logPath: string) {}

  async append(record: Omit<TradeLogRecord, "id"> & { id?: string }): Promise<TradeLogRecord> {
    const fullRecord: TradeLogRecord = {
      id: record.id ?? randomUUID(),
      ...record,
    };
    await mkdir(dirname(this.logPath), { recursive: true });
    await appendFile(this.logPath, `${JSON.stringify(fullRecord)}\n`, "utf8");
    return fullRecord;
  }
}
