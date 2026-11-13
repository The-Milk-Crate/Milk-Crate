// A stand-in for an AWS SDK v3 client at its edge: `send(command)`. Each test says what a
// command returns (or throws), and checks the commands that were sent.
import type { Sender } from "../src/aws.ts";

type Reply = (input: any) => unknown | Promise<unknown>;

export class FakeAws implements Sender {
  readonly sent: { name: string; input: any }[] = [];
  private replies = new Map<string, Reply>();

  on(command: { name: string }, reply: Reply): this {
    this.replies.set(command.name, reply);
    return this;
  }

  async send(command: any): Promise<any> {
    const name: string = command.constructor.name;
    this.sent.push({ name, input: command.input });
    const reply = this.replies.get(name);
    if (!reply) throw new Error(`the fake has no reply for ${name}`);
    return reply(command.input);
  }

  inputs(command: { name: string }): any[] {
    return this.sent.filter((s) => s.name === command.name).map((s) => s.input);
  }

  names(): string[] {
    return this.sent.map((s) => s.name);
  }
}

/** An AWS SDK-shaped error. */
export function awsError(name: string, message = name, status?: number): Error {
  const e = new Error(message) as Error & { $metadata: { httpStatusCode?: number } };
  e.name = name;
  e.$metadata = { httpStatusCode: status };
  return e;
}
