import { createHash } from "node:crypto";
import { CreateScheduleCommand, UpdateScheduleCommand, type CreateScheduleCommandInput } from "@aws-sdk/client-scheduler";
import type { Database, Schedules } from "./core.ts";
import { errorName, type Sender } from "./aws.ts";

const NAME = /^[A-Za-z0-9_.:-]{1,100}$/;
const FN = /^api_[a-z0-9_]{1,59}$/;
const ARG = /^[a-z_][a-z0-9_]{0,62}$/;
// Type names from the catalog, such as uuid, text, timestamp with time zone, integer[].
const TYPE = /^[a-z_][a-z0-9_ ]*(\[\])?$/;

/** The universal target that calls the RDS Data API's ExecuteStatement. */
export const DATA_API_TARGET = "arn:aws:scheduler:::aws-sdk:rdsdata:executeStatement";

export interface EventBridgeSchedulesOptions {
  /** An EventBridge Scheduler client. */
  scheduler: Sender;
  /** Reads the function's argument types from the catalog when a run is set. */
  database: Database;
  /** The schedule group the stand-up made. */
  group: string;
  /** The role Scheduler takes to call the Data API and send to the dead-letter queue. */
  roleArn: string;
  /** The SQS queue that keeps runs that failed, with their error. */
  deadLetterArn: string;
  /** The Data API target. */
  resourceArn: string;
  secretArn: string;
  databaseName: string;
  now?: () => number;
}

/**
 * The Scheduler name for a run name. Scheduler allows 1 to 64 of [0-9A-Za-z-_.]. The same run
 * name always gives the same schedule name, so setting it again replaces the earlier one.
 */
export function scheduleName(name: string): string {
  const readable = name.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 40);
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 16);
  return `mc-${readable}-${hash}`;
}

/** `at(...)` for Scheduler, in UTC, rounded up to the minute; a time already past runs next minute. */
export function atExpression(at: Date, nowMs: number): string {
  const minute = 60_000;
  const due = Math.max(Math.ceil(at.getTime() / minute), Math.ceil((nowMs + minute) / minute)) * minute;
  return `at(${new Date(due).toISOString().slice(0, 19)})`;
}

// A universal target's Input uses the API's field names in PascalCase (`Name`, `StringValue`),
// not the lower camel case of the SDK's own objects. Real AWS refused `name` (sandbox run 3).
function parameter(name: string, value: string | number | boolean | null) {
  if (value === null) return { Name: name, Value: { IsNull: true } };
  if (typeof value === "boolean") return { Name: name, Value: { BooleanValue: value } };
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? { Name: name, Value: { LongValue: value } } : { Name: name, Value: { DoubleValue: value } };
  }
  return { Name: name, Value: { StringValue: value } };
}

/**
 * `Schedules` on EventBridge Scheduler. Each run is a one-time schedule (`at(...)`, UTC) whose
 * target is the RDS Data API: it runs `select public.<fn>(<arg> => :<arg>::<type>, ...)`, with
 * the values as Data API parameters, never in the SQL text. The schedule deletes itself after
 * it runs (`ActionAfterCompletion: DELETE`). Setting the same name again replaces it.
 *
 * A failed run is not tried again (as on session E): no retries, and the failed call goes to
 * the dead-letter queue with its error, where `confirm` reports it.
 * Session G schedules `api_release_go_live` with `p_release_id`; it moves only `scheduled` to
 * `live`, so a run after a takedown is harmless.
 */
export function eventBridgeSchedules(options: EventBridgeSchedulesOptions): Schedules {
  const now = options.now ?? Date.now;
  return {
    async runSqlFunctionAt(input): Promise<void> {
      if (!NAME.test(input.name)) throw new Error(`bad schedule name: ${input.name}`);
      if (!FN.test(input.fn)) throw new Error(`schedules run only public api_ functions, not ${input.fn}`);
      const args = input.args ?? {};
      const names = Object.keys(args);
      for (const key of names) if (!ARG.test(key)) throw new Error(`bad argument name: ${key}`);
      if (!(input.at instanceof Date) || Number.isNaN(input.at.getTime())) throw new Error("bad time");

      // Each named argument's type, from the one function of that name.
      // Input arguments only (a function that returns a table lists its columns as arguments too).
      const found = await options.database.query<{ types: Record<string, string> | null }>(
        `select (select jsonb_object_agg(a.name, format_type(a.type, null))
                   from unnest(coalesce(p.proallargtypes, p.proargtypes::oid[]), p.proargnames, p.proargmodes::text[])
                        as a(type, name, mode)
                  where a.name is not null and coalesce(a.mode, 'i') in ('i', 'b')) as types
           from pg_catalog.pg_proc p
           join pg_catalog.pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = $1::text and p.prokind = 'f'`,
        [input.fn],
      );
      if (found.length !== 1) throw new Error(`no single public function ${input.fn}`);
      const types = found[0].types ?? {};
      const list = names.map((name) => {
        const type = types[name];
        if (!type || !TYPE.test(type)) throw new Error(`${input.fn} has no argument ${name}`);
        return `${name} => :${name}::${type}`;
      });
      const sql = `select public.${input.fn}(${list.join(", ")})`;

      const schedule: CreateScheduleCommandInput = {
        Name: scheduleName(input.name),
        GroupName: options.group,
        Description: `Milk Crate run ${input.name}`.slice(0, 512),
        ScheduleExpression: atExpression(input.at, now()),
        ScheduleExpressionTimezone: "UTC",
        FlexibleTimeWindow: { Mode: "OFF" },
        ActionAfterCompletion: "DELETE",
        State: "ENABLED",
        Target: {
          Arn: DATA_API_TARGET,
          RoleArn: options.roleArn,
          Input: JSON.stringify({
            ResourceArn: options.resourceArn,
            SecretArn: options.secretArn,
            Database: options.databaseName,
            Sql: sql,
            Parameters: names.map((name) => parameter(name, args[name])),
          }),
          RetryPolicy: { MaximumRetryAttempts: 0 },
          DeadLetterConfig: { Arn: options.deadLetterArn },
        },
      };
      // Replace a run of the same name; make it if there is none (or it already ran).
      try {
        await options.scheduler.send(new UpdateScheduleCommand(schedule));
      } catch (error) {
        if (errorName(error) !== "ResourceNotFoundException") throw error;
        try {
          await options.scheduler.send(new CreateScheduleCommand(schedule));
        } catch (again) {
          // Made by another call between the two: replace it.
          if (errorName(again) !== "ConflictException") throw again;
          await options.scheduler.send(new UpdateScheduleCommand(schedule));
        }
      }
    },
  };
}
