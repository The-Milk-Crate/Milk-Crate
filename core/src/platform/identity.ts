import type { AccountType } from "./types";

export interface Caller {
  userId: string;
  accountType: AccountType;
}

/** Who is calling, and their account type. */
export interface Identity {
  /** Returns null when there is no valid token. */
  whoIs(request: Request): Promise<Caller | null>;
}
