import type { Go } from "../App";

export type PolicyDoc = "terms" | "privacy" | "copyright";

const UPDATED = "October 18, 2026";


/** Terms, privacy, and how copyright reports and takedowns work, in plain language. */
export function Policies({ go, doc }: { go: Go; doc: PolicyDoc }) {
  const tabs: { id: PolicyDoc; label: string }[] = [
    { id: "terms", label: "Terms" },
    { id: "privacy", label: "Privacy" },
    { id: "copyright", label: "Copyright and takedowns" },
  ];
  return (
    <div className="screen policies" style={{ maxWidth: 760 }}>
      <header style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span className="catalog eyebrow">Milk Crate · Updated {UPDATED}</span>
        <h1 className="display-lg">{tabs.find((t) => t.id === doc)?.label}</h1>
      </header>
      <div role="tablist" aria-label="Policies" className="segmented">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" className="chip" aria-selected={doc === t.id} aria-pressed={doc === t.id} onClick={() => go({ name: "policies", doc: t.id })}>{t.label}</button>
        ))}
      </div>
      {doc === "terms" && <Terms />}
      {doc === "privacy" && <Privacy />}
      {doc === "copyright" && <Copyright />}
    </div>
  );
}

export function Terms() {
  return (
    <article className="policy">
      <p>Milk Crate is a nonprofit music app for listening to independent artists and the scenes around you. By using it you agree to these terms.</p>
      <h2>Accounts</h2>
      <p>You need to be at least 13 to make an account. Listener and artist accounts are separate. Keep your password to yourself; you're responsible for what happens on your account. You can delete your account any time from Account.</p>
      <h2>Artists and your music</h2>
      <p>Only put music, art, photos and fonts on Milk Crate that you made or have the right to share. You keep all rights to your work. By publishing, you let Milk Crate store it, stream it to listeners, and show it in the app (including on your artist page, in Scenes and in search) until you remove it. Removing a release takes it off the server.</p>
      <p>New artists are reviewed before their music goes public. Reviewers can decline an application, take a release down, or hide an artist who breaks these terms.</p>
      <h2>Listening</h2>
      <p>Music on Milk Crate is for personal listening. Downloads play only inside the app and are for your own offline listening. Don't copy, resell or re-upload other artists' work.</p>
      <h2>CDs you rip and your own files</h2>
      <p>Only rip CDs you own, and only for your own listening. Ripped music and files you add from your computer stay on your computers and are never uploaded to Milk Crate. You can send a ripped CD only to another computer signed in to your own account; don't use Milk Crate to share ripped music with anyone else.</p>
      <h2>Be decent</h2>
      <p>No hate, harassment, threats, spam, impersonation, or anything sexual involving minors. No trying to break, overload or get around the app or its server. Report anything that crosses the line from the release or artist page.</p>
      <h2>No guarantees</h2>
      <p>Milk Crate is run by a small nonprofit team and offered as it is. We work to keep it running and your music safe, but can't promise it will always be available or free of mistakes. Keep your own copies of your music.</p>
      <h2>Changes</h2>
      <p>If these terms change, the app will show the new date at the top of this page. When a change matters, the app asks you to agree again before you keep using your account.</p>
    </article>
  );
}

export function Privacy() {
  return (
    <article className="policy">
      <p>Milk Crate doesn't run ads, doesn't sell or share your information, and doesn't track you around the internet. Here's exactly what it keeps.</p>
      <h2>In your account (on Milk Crate's server)</h2>
      <ul>
        <li>Your email and password. Your email is never shown to other people, artists included. The password is stored scrambled; nobody can read it, Milk Crate's team included.</li>
        <li>Your display name, which other people can see.</li>
        <li>Your city. Only you can see it. It decides your scene.</li>
        <li>Your listening history (the songs you've played and when), so it's with you on any computer. Only you can see it, and you can clear it any time in Your Crate → Recently Played.</li>
        <li>Your crate (albums and songs you add), favorite songs, the records, CDs and tapes on Your Shelf, playlists (and the pictures you choose for them), follows and album ratings. Your favorites are private. Album ratings count toward the album's average, which everyone sees, but never with your name on it.</li>
        <li>Streams: when you listen to a song for about 30 seconds, a stream is counted (playing the same song again within 4 hours doesn't add another, and artists' plays of their own songs don't count). Each song's total is public (it ranks an artist's popular songs and sizes their dot on the scene maps), never who streamed it. Artists also see where their listeners are, but only a town where three or more different listeners have played them.</li>
        <li>Artists: your profile, page design, releases, and your application to join.</li>
        <li>Reports you send, and the email you give for follow-up (only reviewers see it, and it's erased if you delete your account).</li>
        <li>Feedback you send: your message, the email you leave for a reply (optional), which screen you were on, and the app version. Only the Milk Crate team sees it; the reply email is erased if you delete your account.</li>
      </ul>
      <h2>On this computer only</h2>
      <ul>
        <li>Songs you download, your queue, your settings, and Your Computer: the audio files you add from this computer (ripped CDs included), their tags and covers. The music is never uploaded, and each account on the computer has its own list. Without an account, your listening history stays here too.</li>
        <li>Signed in, the playlists and favorites you make with these songs follow you to your other computers. For that, your account keeps a short description of each such song (artist, album, disc, track number and title), never the music. Only you can see it.</li>
      </ul>
      <h2>Shared links</h2>
      <p>Links you share open a page on GitHub Pages that shows the album, artist or scene and opens it in Milk Crate. The page only reads what's already public in the app (titles, covers, artist names) and keeps nothing about who opens it.</p>
      <h2>Error reports</h2>
      <p>When the app hits an error, it sends a short note about what broke (the error, which screen, the app version and your operating system) so it can be fixed. It doesn't include your music, files or messages, and any email address in it is blanked out before it's sent.</p>
      <h2>Keeping your account safe</h2>
      <ul>
        <li>Passwords need at least 8 characters, and passwords known from data breaches on other sites are turned down. To check, only the first 5 characters of a scrambled fingerprint of your password are sent to the free Have I Been Pwned service; your password never leaves your computer.</li>
        <li>Changing your email or password, or deleting your account, asks for your current password. A new email has to be confirmed from both the old and new addresses.</li>
        <li>After several wrong passwords, sign-in pauses before letting anyone try again.</li>
        <li>Creating an account never tells anyone whether an email already has one.</li>
        <li>Your sign-in on this computer is kept encrypted, with its key in Windows Credential Manager or the macOS Keychain.</li>
        <li>Signing out ends that computer's session on the server too. Not using the app for 30 days signs it out. Changing your password signs out every other computer.</li>
        <li>Lost a computer? Account → Sign out everywhere ends every session at once.</li>
      </ul>
      <h2>Your choices</h2>
      <p>Change your email, password, display name or city in Account. Delete your account there too: it removes your account and everything in it from the server for good, including your uploaded music if you're an artist.</p>
    </article>
  );
}

function Copyright() {
  return (
    <article className="policy">
      <p>Milk Crate only wants music from the people who made it. If something here is yours and you didn't put it here, we'll take it down.</p>
      <h2>Reporting music that's yours</h2>
      <ol>
        <li>Open the release (or the artist's page) and choose <strong>Report</strong>, then <strong>It's my music (copyright)</strong>.</li>
        <li>Tell us which songs are yours, where they're officially released, and that you own the rights or are allowed to act for whoever does.</li>
        <li>Leave an email so a reviewer can reach you.</li>
      </ol>
      <p>A reviewer checks every report. Music that isn't the uploader's comes down, files and all. Artists who upload other people's work more than once are removed.</p>
      <h2>If your music was taken down</h2>
      <p>If you believe it was a mistake (it's your music, or you have permission), reply to the reviewer's email with the details. If it checks out, you can publish it again.</p>
      <h2>Other reports</h2>
      <p>The same Report button covers music that isn't the artist's own, hateful or harmful content, spam and fake artists.</p>
    </article>
  );
}
