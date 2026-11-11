/** Run this SQL function at this time. */
export interface Schedules {
  /** Runs `fn` once at `at`. Setting the same `name` again replaces the earlier one. */
  runSqlFunctionAt(input: {
    name: string;
    fn: string;
    args?: Record<string, string | number | boolean | null>;
    at: Date;
  }): Promise<void>;
}
