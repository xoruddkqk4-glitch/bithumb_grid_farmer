declare const process: {
  env: Record<string, string | undefined>;
  cwd(): string;
  exit(code?: number): never;
};

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
};

declare function setTimeout(
  callback: (...args: unknown[]) => void,
  ms: number,
  ...args: unknown[]
): unknown;

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

declare const Buffer: {
  from(input: string, encoding?: string): { toString(encoding?: string): string };
};

declare class URLSearchParams {
  constructor(init?: Record<string, string>);
  toString(): string;
}

declare module "node:fs/promises" {
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function rename(oldPath: string, newPath: string): Promise<void>;
  export function writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  export function appendFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  export function stat(path: string): Promise<{ size: number }>;
}

declare module "node:path" {
  export function dirname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
}

declare module "node:crypto" {
  export function randomUUID(): string;
  export function createHash(algorithm: string): {
    update(data: string): { digest(encoding: string): string };
  };
  export function createHmac(algorithm: string, key: string): {
    update(data: string): { digest(encoding: string): string };
  };
}
