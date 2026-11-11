/** Stand up, confirm, tear down. */
export interface Infrastructure {
  standUp(): Promise<void>;
  /** Checks that what was stood up works. */
  confirm(): Promise<{ ok: boolean; problems: string[] }>;
  tearDown(): Promise<void>;
}
