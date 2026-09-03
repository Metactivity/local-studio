// The slice of bun:sqlite the SQLite session repo uses. The program types
// against @types/node only (the Next transpile path shares this tsconfig);
// pulling bun-types in for one module would change every file's globals.
declare module "bun:sqlite" {
  export interface Statement<Row = unknown, Params extends unknown[] = unknown[]> {
    all(...params: Params): Row[];
    get(...params: Params): Row | null;
    run(...params: Params): void;
  }
  export class Database {
    constructor(filename: string, options?: { create?: boolean; readonly?: boolean });
    exec(sql: string): void;
    query<Row = unknown, Params extends unknown[] = unknown[]>(sql: string): Statement<Row, Params>;
    transaction<T extends (...args: never[]) => unknown>(fn: T): T;
    close(): void;
  }
}
