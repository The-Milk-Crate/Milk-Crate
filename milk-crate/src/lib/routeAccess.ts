/**
 * Which pages anyone can open, and which need an account, an artist account or a reviewer.
 * The app shows a page only to who it's for; the server checks again on every request
 * (row-level security), so this is about not showing a page, never the only lock.
 */
export type Access = "public" | "account" | "artist" | "admin";

export interface RouteLike { name: string; playlistId?: string }

export function routeAccess(r: RouteLike): Access {
  switch (r.name) {
    case "review":
      return "admin";
    case "editRelease":
    case "stats":
      return "artist";
    case "inbox":
      return "account";
    case "crate":
      return r.playlistId ? "account" : "public"; // the crate page itself explains what an account adds
    default:
      // home, artists, albums, scenes, your computer, your shelf, settings, policies,
      // account (where you sign in) and For Artists (where you apply).
      return "public";
  }
}

export interface Who { ready: boolean; signedIn: boolean; artist: boolean; admin: boolean }

/** null: show the page. Otherwise why not. */
export function blockedBecause(access: Access, who: Who): "loading" | "sign-in" | "artist" | "admin" | null {
  if (access === "public") return null;
  if (!who.ready) return "loading";
  if (!who.signedIn) return "sign-in";
  if (access === "artist" && !who.artist) return "artist";
  if (access === "admin" && !who.admin) return "admin";
  return null;
}
