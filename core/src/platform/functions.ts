import type { Handler } from "./types";

/** Handle this request. Each deployment wires handlers to its own runtime. */
export interface ServerFunctions {
  handle<Deps>(route: string, handler: Handler<Deps>, deps: Deps): void;
}
