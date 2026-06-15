declare const process: {
  env: Record<string, string | undefined>;
  execPath: string;
  platform: string;
  cwd(): string;
  exit(code?: number): never;
};

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare function fetch(
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }
): Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
}>;

declare module "node:fs/promises" {
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function rename(oldPath: string, newPath: string): Promise<void>;
  export function writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
}

declare module "node:path" {
  export function dirname(path: string): string;
  export function resolve(...paths: string[]): string;
}

declare module "node:http" {
  export interface IncomingMessage {
    method?: string;
    url?: string;
    headers: Record<string, string | string[] | undefined>;
    on(event: "data", listener: (chunk: string | Uint8Array) => void): void;
    on(event: "end", listener: () => void): void;
    on(event: "error", listener: (error: Error) => void): void;
  }

  export interface ServerResponse {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(data?: string): void;
  }

  export function createServer(
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  ): {
    listen(port: number, host: string, callback?: () => void): void;
  };
}

declare module "node:child_process" {
  export function execFile(
    file: string,
    args: string[],
    options: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      timeout?: number;
      windowsHide?: boolean;
    },
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ): void;
}

declare const Buffer: {
  from(input: string, encoding?: string): { toString(encoding?: string): string };
};

declare class URL {
  constructor(input: string, base?: string);
  searchParams: {
    get(name: string): string | null;
  };
}

declare class URLSearchParams {
  constructor(init?: Record<string, string>);
  toString(): string;
}
