// A scenario Target on one mock deployment: everything the scenario can use, including the
// steps a real deployment cannot show (invite codes from the emails, firing the schedule,
// database reads).
import type { AccountType } from "../../../core/src/platform/index.ts";
import type { Account, MockDeployment } from "./mocks.ts";
import type { Actor } from "./observe.ts";
import type { Target } from "./scenario.ts";

const actor = (label: string, a: Account): Actor => ({ label, type: a.type, token: a.token, userId: a.userId, ...(a.email ? { email: a.email } : {}) });

export async function mockTarget(d: MockDeployment): Promise<Target> {
  const make = async (type: AccountType, label: string) => actor(label, await d.account(type));
  const actors = {
    artist: await make("artist", "artist"),
    otherArtist: await make("artist", "another artist"),
    listener: await make("end_user", "listener"),
    thirdParty: await make("third_party", "third party"),
    admin: await make("administrator", "administrator"),
    internal: await make("internal", "internal"),
    accounting: await make("internal_accounting", "internal accounting"),
  };
  const run = crypto.randomUUID().slice(0, 8);
  const lastEmail = (to: string) => d.emails.filter((e) => e.to === to).at(-1);
  return {
    side: d.side,
    api: d.api,
    uploadFetch: d.clientFetch,
    actors,
    async stateOf(releaseId) {
      const [row] = await d.db.query<{ state: string }>("select state from public.api_releases where id = $1::uuid", [releaseId]);
      return row?.state;
    },
    async processing() {
      await d.runJobs();
    },
    inviteeEmail: (n) => `invitee-${n}-${run}@example.com`,
    inviteCode(email) {
      const m = /Your invite code: (\S+)/.exec(lastEmail(email)?.text ?? "");
      return m?.[1];
    },
    emailSubjects: (email) => d.emails.filter((e) => e.to === email).map((e) => e.subject),
    fireSchedule: (name) => d.fireSchedule(name),
    scheduledAt: (name) => d.scheduledAt(name),
    storageKeys: (prefix) => d.keys(prefix),
    async auditRow(auditId) {
      const [row] = await d.db.query<{ reason: string; removed: unknown }>(
        "select reason, removed from public.api_audit_log where id = $1::uuid",
        [auditId],
      );
      // What was removed, with the ids taken out (they differ by side).
      return row && { reason: row.reason, removed: JSON.parse(JSON.stringify(row.removed).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")) };
    },
    async plays(playId) {
      const [row] = await d.db.query<{ events: number; qualified: number }>(
        `select (select count(*)::int from public.api_play_events where play_id = $1::uuid) as events,
                (select count(*)::int from public.api_qualified_streams where play_id = $1::uuid) as qualified`,
        [playId],
      );
      return row;
    },
    accounts: {
      async suspendedArtist() {
        const a = await d.account("artist", { suspended: true });
        return { ...actor("suspended artist", a), staleToken: await d.token(a.userId, "artist") };
      },
      async removedAdmin() {
        const a = await d.account("administrator");
        await d.db.query("delete from public.api_accounts where user_id = $1::uuid", [a.userId]);
        return { ...actor("removed administrator", a), actsAs: "end_user" };
      },
    },
  };
}
