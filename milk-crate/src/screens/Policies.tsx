import type { Go } from "../App";
import { ARTIST_SHARE, DISSOLUTION_RECIPIENT, GOVERNING_STATE, LEGAL_ADDRESS, LEGAL_EMAIL, ORG_NAME, TERMS_UPDATED } from "../lib/terms";

export type PolicyDoc = "mission" | "terms" | "privacy" | "copyright";


/** Terms, privacy, and how copyright reports and takedowns work, in plain language. */
export function Policies({ go, doc }: { go: Go; doc: PolicyDoc }) {
  const tabs: { id: PolicyDoc; label: string }[] = [
    { id: "mission", label: "Our mission" },
    { id: "terms", label: "Terms" },
    { id: "privacy", label: "Privacy" },
    { id: "copyright", label: "Copyright and takedowns" },
  ];
  return (
    <div className="screen policies" style={{ maxWidth: 760 }}>
      <header style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span className="catalog eyebrow">Milk Crate · Updated {TERMS_UPDATED}</span>
        <h1 className="display-lg">{tabs.find((t) => t.id === doc)?.label}</h1>
      </header>
      <div role="tablist" aria-label="Policies" className="segmented">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" className="chip" aria-selected={doc === t.id} aria-pressed={doc === t.id} onClick={() => go({ name: "policies", doc: t.id })}>{t.label}</button>
        ))}
      </div>
      {doc === "mission" && <Mission />}
      {doc === "terms" && <Terms />}
      {doc === "privacy" && <Privacy />}
      {doc === "copyright" && <Copyright />}
    </div>
  );
}

/** What Milk Crate is for, and the promises it keeps (the binding ones are repeated in the Terms, section 1). */
export function Mission() {
  return (
    <article className="policy">
      <p className="lede">Milk Crate is a nonprofit music platform that puts artists first: what listeners pay goes to the artists they actually listen to, and music is found through local scenes and real collections, not paid placement.</p>
      <h2>What we're here to do</h2>
      <ul>
        <li><strong>Pay artists fairly.</strong> Your money goes to the artists you play, buy or become a Fan of, not into a shared pool split by the biggest names.</li>
        <li><strong>Lift up local and up-and-coming artists.</strong> Scenes are built around where you live, so the band from your town sits next to everyone else. No top-100 charts.</li>
        <li><strong>Sound good.</strong> High-quality streams, and albums you can download to play in the app at full quality.</li>
        <li><strong>Respect how people own music.</strong> Records, CDs and tapes count: catalog your shelf and rip your own CDs.</li>
        <li><strong>Leave artists in control.</strong> Artists keep every right to their work, take it down whenever they want, and sell it anywhere else.</li>
        <li><strong>Keep quality high.</strong> Artists are reviewed before they go public.</li>
        <li><strong>Grow to all of music,</strong> starting local and independent.</li>
      </ul>
      <h2>Our promises</h2>
      <ul>
        <li>We never run ads.</li>
        <li>We never sell or rent your information, or share it for advertising.</li>
        <li>We never take money to promote an artist, label or song. Discovery on Milk Crate favors local, independent and up-and-coming artists over the biggest names.</li>
        <li>When you pay, {ARTIST_SHARE} goes to the artists you listen to, and Milk Crate keeps only what it costs to run. We'll publish the numbers every year.</li>
        <li>You can always download albums to listen offline in the app at full quality.</li>
        <li>If Milk Crate ever closes, artists get at least 30 days to take copies of their work, and any money left goes to {DISSOLUTION_RECIPIENT}, never to anyone personally.</li>
      </ul>
    </article>
  );
}

export function Terms() {
  return (
    <article className="policy">
      <p>These terms are an agreement between you and {ORG_NAME} ("Milk Crate", "we"), the nonprofit that runs the Milk Crate app. By making an account or using the app, you agree to them. They're written to be read; if something's unclear, write to us at {LEGAL_EMAIL}.</p>

      <h2>1. Our promises to you</h2>
      <p>Milk Crate is a nonprofit (see Our mission). As part of this agreement, we promise:</p>
      <ul>
        <li>We won't show ads in Milk Crate.</li>
        <li>We won't sell or rent your personal information, or share it for advertising.</li>
        <li>We won't accept payment to promote any artist, label or song, or to rank it higher in the app.</li>
        <li>When Milk Crate charges for anything, at least {ARTIST_SHARE} of what you pay will go to the artists you listen to or buy from, and we'll publish each year how the money was split.</li>
        <li>You'll be able to download albums for offline listening in the app at full quality, as long as you have an account in good standing and the release is on Milk Crate.</li>
        <li>If Milk Crate shuts down, we'll give artists at least 30 days' notice, and anything Milk Crate owns after paying its debts goes to {DISSOLUTION_RECIPIENT}, not to any person.</li>
      </ul>
      <p>If we ever change one of these promises, we'll tell you at least 30 days before the change takes effect and ask you to agree again; you can delete your account instead.</p>

      <h2>2. Who can use Milk Crate</h2>
      <ul>
        <li>You need to be at least 13 years old. If you're under 18, use Milk Crate only with a parent's or guardian's permission, and they agree to these terms for you.</li>
        <li>If Milk Crate adds anything you pay for, buying it will need you to be 18 or older, or a parent or guardian to buy it for you.</li>
        <li>You can't use Milk Crate if we've removed you before, or if the law where you live doesn't allow it.</li>
      </ul>

      <h2>3. Your account</h2>
      <ul>
        <li>Give a real email address and keep your password to yourself. You're responsible for what happens on your account, so tell us at {LEGAL_EMAIL} if you think someone else got into it.</li>
        <li>One person per account. Listener and artist accounts are separate, and an account can't switch between them.</li>
        <li>You can delete your account any time from Account. That removes it and what's in it from our server for good.</li>
      </ul>

      <h2>4. Listening</h2>
      <ul>
        <li>You can stream the music on Milk Crate, and download whole albums or songs to listen offline inside the app, for your own personal, non-commercial use. Artists can't switch downloads off for listeners.</li>
        <li>Downloads play only in Milk Crate and stop working if your account ends. Don't copy them out of the app, share them, sell them, or re-upload them anywhere.</li>
        <li>Don't record, rip or capture music from the app, and don't try to get around anything that protects it.</li>
      </ul>

      <h2>5. Artists and the music you upload</h2>
      <ul>
        <li><strong>You keep your rights.</strong> Everything you upload (music, artwork, photos, fonts, lyrics, credits) stays yours.</li>
        <li><strong>What you let us do.</strong> By publishing, you give Milk Crate permission, free of charge and not exclusive, to store your uploads, stream them to listeners anywhere, let listeners download them inside the app, and show them in the app and on Milk Crate's share pages (your artist page, Scenes, search, playlists), for as long as they're on Milk Crate. You can sell or share your music anywhere else you like.</li>
        <li><strong>When you take something down</strong>, it's removed from our server and stops streaming. Listeners' in-app downloads of it stop playing. Backups that hold it are overwritten in the normal course, within 30 days.</li>
        <li><strong>You promise</strong> you made what you upload, or have every permission needed to put it on Milk Crate, including the song itself (lyrics and composition), the recording, any samples, the artwork and photos, and the fonts. If anyone else has rights in it (band members, a label, a publisher, a distributor), you have their permission.</li>
        <li><strong>Review.</strong> New artists are reviewed before their music goes public. We can decline an application or take down a release without having to give a reason, though we'll try to tell you why.</li>
        <li>If something you uploaded breaks someone else's rights and they come after us for it, you agree to cover the costs that causes us, as far as the law allows.</li>
      </ul>

      <h2>6. CDs you rip and your own files</h2>
      <ul>
        <li>Milk Crate can rip CDs and play audio files from your computer. Only rip CDs you own, and only for your own listening. Whether making a personal copy is allowed depends on where you live; that's your responsibility.</li>
        <li>Ripped music and your own files stay on your computers. They're never uploaded to Milk Crate.</li>
        <li>You can send a ripped CD only to another computer signed in to your own account. Don't use Milk Crate to give ripped music to anyone else, and don't upload it as if it were yours.</li>
      </ul>

      <h2>7. Things you can't do</h2>
      <ul>
        <li>Post hate, harassment, threats, or anything that encourages violence or self-harm.</li>
        <li>Post anything sexual involving anyone under 18, ever. We remove it and report it to the authorities.</li>
        <li>Pretend to be another artist or person, or make fake artist pages.</li>
        <li>Spam, or fake plays, streams, ratings or followers (for example with bots or repeat accounts).</li>
        <li>Upload malware, or try to break into, overload, scrape or get around the app, its server or anyone's account.</li>
        <li>Use Milk Crate for anything illegal.</li>
      </ul>
      <p>Report anything that crosses the line with the Report button on any release or artist page.</p>

      <h2>8. Copyright</h2>
      <p>If you think something on Milk Crate infringes your copyright, report it from the release or artist page, or send a notice to {LEGAL_EMAIL} or {LEGAL_ADDRESS}. How reports and take-downs work, and how to respond if your music was taken down, is on the Copyright and takedowns page. We remove the accounts of people who infringe again and again.</p>

      <h2>9. If you break these terms</h2>
      <p>We can remove content, take down releases, hide an artist, or suspend or close an account that breaks these terms or puts listeners, artists or Milk Crate at risk. When we can, we'll tell you why and give you a chance to fix it first. If you think we got it wrong, write to us at {LEGAL_EMAIL}.</p>

      <h2>10. Changes to Milk Crate</h2>
      <p>Milk Crate is a small nonprofit project. We may add, change or stop features, and we may stop running Milk Crate, but always within the promises in section 1.</p>

      <h2>11. No guarantees</h2>
      <p>Milk Crate is offered as it is and as available. We work to keep it running and your music safe, but we can't promise it will always work, be free of mistakes, or never lose data. Keep your own copies of your music. As far as the law allows, we don't make any other promises about the app.</p>

      <h2>12. Limits on liability</h2>
      <p>As far as the law allows, Milk Crate and the people who run it aren't liable for indirect or unexpected losses (like lost profits, lost data or lost opportunities) from using Milk Crate, and our total responsibility for anything to do with these terms or the app is limited to $50. Some places don't allow these limits, so they may not all apply to you.</p>

      <h2>13. Disagreements</h2>
      <p>If you have a problem with Milk Crate, write to us at {LEGAL_EMAIL} first; most things can be sorted out that way. These terms are governed by the laws of {GOVERNING_STATE} and of the United States. Any dispute that isn't sorted out goes to the courts in {GOVERNING_STATE}, except that either of us can bring a claim in small claims court where it qualifies.</p>

      <h2>14. Changes to these terms</h2>
      <p>When these terms change, the date at the top of this page changes too. If a change matters, the app asks you to agree again before you keep using your account. If you don't agree, you can delete your account.</p>

      <h2>15. The rest</h2>
      <p>These terms, the Privacy policy and the Copyright and takedowns page are the whole agreement between you and Milk Crate. If part of them can't be enforced, the rest still applies. If we don't enforce something right away, we can still enforce it later. You can't transfer your account or these terms to someone else.</p>
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
      <h2>Children</h2>
      <p>Milk Crate isn't for children under 13, and we don't knowingly keep information about them. If you believe a child under 13 has made an account, write to {LEGAL_EMAIL} and we'll delete it.</p>
      <h2>Questions</h2>
      <p>Write to {LEGAL_EMAIL} about anything in this policy, or to ask what we keep about you.</p>
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
      <h2>Formal copyright notices (DMCA)</h2>
      <p>You can also send a formal notice under the US Digital Millennium Copyright Act to Milk Crate's copyright agent at {LEGAL_EMAIL} or {LEGAL_ADDRESS}. It needs to include:</p>
      <ol>
        <li>Your name, address, phone number and email.</li>
        <li>The work you say is being infringed.</li>
        <li>Where it is on Milk Crate (the artist and release, or a share link).</li>
        <li>A statement that you believe in good faith the use isn't allowed by you, your agent, or the law.</li>
        <li>A statement that the information in your notice is accurate and, under penalty of perjury, that you own the rights or are allowed to act for whoever does.</li>
        <li>Your physical or electronic signature (typing your full name works).</li>
      </ol>
      <p>Sending a notice you know is false can make you liable for the damage it causes.</p>
      <h2>If your music was taken down</h2>
      <p>If you believe it was a mistake (it's your music, or you have permission), reply to the reviewer's email with the details. If it checks out, you can publish it again.</p>
      <p>You can also send a formal counter-notice to the same address. Include your name, address, phone number and signature; which releases were taken down; a statement, under penalty of perjury, that you believe in good faith they were removed by mistake; and that you agree to the jurisdiction of the federal court for your address (or, outside the US, any court where Milk Crate can be found) and will accept legal papers from the person who reported it. Unless they tell us within 10 to 14 business days that they've gone to court, we can put the music back.</p>
      <h2>Other reports</h2>
      <p>The same Report button covers music that isn't the artist's own, hateful or harmful content, spam and fake artists.</p>
    </article>
  );
}
