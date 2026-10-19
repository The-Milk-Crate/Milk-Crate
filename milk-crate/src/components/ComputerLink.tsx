import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftRight, Check, LoaderCircle, Monitor, RefreshCw, X } from "lucide-react";
import { useAuth } from "../lib/auth";
import { useAddRipped, useRippedAlbums } from "../lib/ripped";
import { cancelSend, findComputers, onReceive, sendSongs, sizeLabel, songsThere, startReceiving, stopReceiving, type Peer, type SendProgress } from "../lib/link";
import { Button } from "./ui";

/**
 * Your Computer › Send to another computer: CDs and records you ripped here go straight to your other computer
 * on the same network (Wi-Fi or a cable), or this one receives them. Both computers are signed in to
 * the same account; the receiving one shows a code to type on the sending one.
 */
export function ComputerLink({ onClose }: { onClose: () => void }) {
  const { userId } = useAuth();
  const [mode, setMode] = useState<"send" | "receive">("send");
  return (
    <section className="panel link-panel" aria-labelledby="link-title">
      <div className="cd-ripper-head">
        <h2 id="link-title" className="display-md">Send to another computer</h2>
        <button type="button" className="mc-icon-btn" aria-label="Close" onClick={onClose}><X size={18} aria-hidden="true" /></button>
      </div>
      {!userId ? (
        <p className="muted">Sign in on both computers with the same Milk Crate account. CDs and records only go between your own computers.</p>
      ) : (
        <>
          <div role="tablist" aria-label="Send or receive" className="segmented">
            <button type="button" role="tab" className="chip" aria-selected={mode === "send"} aria-pressed={mode === "send"} onClick={() => setMode("send")}>Send from this computer</button>
            <button type="button" role="tab" className="chip" aria-selected={mode === "receive"} aria-pressed={mode === "receive"} onClick={() => setMode("receive")}>Receive on this computer</button>
          </div>
          {mode === "send" ? <Send account={userId} /> : <Receive account={userId} />}
          <p className="caption muted">
            Both computers need Milk Crate open and to be on the same network (the same Wi-Fi, or a cable between them). The CDs go straight across, encrypted with a key made from the code, and are never uploaded. The first time, your computer may ask whether Milk Crate can use the network: allow it.
          </p>
        </>
      )}
    </section>
  );
}

function Receive({ account }: { account: string }) {
  const addRipped = useAddRipped();
  const add = useRef(addRipped);
  add.current = addRipped;
  const [me, setMe] = useState<{ code: string; name: string } | null>(null);
  const [error, setError] = useState("");
  const [incoming, setIncoming] = useState<{ from: string; files: number; bytes: number } | null>(null);
  const [progress, setProgress] = useState(0);
  const [done, setDone] = useState("");
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    let live = true;
    let unlisten: (() => void) | undefined;
    void onReceive(async (e) => {
      if (!live) return;
      if (e.kind === "incoming") { setIncoming(e); setProgress(0); setDone(""); setError(""); }
      if (e.kind === "progress") setProgress(e.total ? e.done / e.total : 0);
      if (e.kind === "failed") { setError(e.error); setIncoming(null); }
      if (e.kind === "locked") setLocked(true);
      if (e.kind === "done") {
        // Each album folder joins Your Computer, Your Shelf and Your Crate like a CD ripped here.
        const songs = e.files.filter((f) => !/[\\/]cover\.(jpe?g|png)$/i.test(f));
        const byFolder = new Map<string, string[]>();
        for (const f of songs) {
          const dir = f.replace(/[\\/][^\\/]+$/, "");
          byFolder.set(dir, [...(byFolder.get(dir) ?? []), f]);
        }
        for (const group of byFolder.values()) await add.current(group).catch(() => undefined);
        if (!live) return;
        setIncoming(null);
        setDone(`Got ${songs.length} ${songs.length === 1 ? "song" : "songs"} from ${e.from} (${byFolder.size} ${byFolder.size === 1 ? "album" : "albums"}). They're in Your Computer and on Your Shelf.`);
      }
    }).then((u) => { if (live) unlisten = u; else u(); });
    startReceiving(account).then((r) => live && setMe(r)).catch((e) => live && setError(String(e)));
    return () => { live = false; unlisten?.(); void stopReceiving(); };
  }, [account]);

  if (locked) return <p className="form-error" role="alert">The code was typed wrong too many times, so this computer stopped listening. Close this and open it again for a new code.</p>;
  if (!me) return error ? <p className="form-error" role="alert">{error}</p> : <p className="muted cd-ripper-wait"><LoaderCircle className="spin" size={16} aria-hidden="true" /> Getting ready…</p>;
  return (
    <div className="link-receive">
      <div className="link-code-box">
        <span className="catalog eyebrow">This computer · {me.name}</span>
        <span className="link-code numeral" aria-label={`Code ${me.code.split("").join(" ")}`}>{me.code.slice(0, 3)} {me.code.slice(3)}</span>
        <span className="caption muted">On your other computer, open Your Computer › Send to another computer, pick <strong>{me.name}</strong> and type this code. Keep this open until it's done.</span>
      </div>
      {incoming && (
        <div className="cd-ripper-progress" role="status">
          <div className="mc-progress-rail"><div className="mc-progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} /></div>
          <span className="caption">Receiving {incoming.files} files ({sizeLabel(incoming.bytes)}) from {incoming.from} · {Math.round(progress * 100)}%</span>
        </div>
      )}
      {done && <p className="form-info" role="status"><Check size={14} aria-hidden="true" style={{ verticalAlign: "-2px" }} /> {done}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}

function Send({ account }: { account: string }) {
  const ripped = useRippedAlbums();
  const [peers, setPeers] = useState<Peer[] | null>(null);
  const [looking, setLooking] = useState(false);
  const [to, setTo] = useState<string>("");
  const [code, setCode] = useState("");
  const [picked, setPicked] = useState<Set<string>>(() => new Set(ripped.map((a) => a.key)));
  const [progress, setProgress] = useState<SendProgress | null>(null);
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const look = () => {
    setLooking(true);
    findComputers(account).then((p) => {
      setPeers(p);
      const mine = p.filter((x) => x.sameAccount);
      if (mine.length === 1) setTo(mine[0].addr);
    }).catch(() => setPeers([])).finally(() => setLooking(false));
  };
  useEffect(look, [account]); // eslint-disable-line react-hooks/exhaustive-deps

  const albums = ripped.filter((a) => picked.has(a.key));
  const songs = useMemo(() => albums.flatMap((a) => a.tracks.map((t) => t.id.replace(/^local:/, ""))), [albums]);
  const peer = peers?.find((p) => p.addr === to);

  // Once the computer and its code are in: which CDs are already on it (sent before). Those are
  // unticked and marked, and wouldn't be sent again anyway.
  const digits = code.replace(/\D/g, "");
  const [there, setThere] = useState<Set<string> | null>(null);
  const [checkErr, setCheckErr] = useState("");
  useEffect(() => {
    setThere(null);
    setCheckErr("");
    if (!peer || digits.length !== 6) return;
    let live = true;
    const all = ripped.flatMap((a) => a.tracks.map((t) => t.id.replace(/^local:/, "")));
    songsThere(peer.addr, digits, account, all).then((have) => {
      if (!live) return;
      const set = new Set(have);
      setThere(set);
      setPicked((p) => new Set([...p].filter((k) => !ripped.find((a) => a.key === k)?.tracks.every((t) => set.has(t.id.replace(/^local:/, ""))))));
    }).catch((e) => live && setCheckErr(String(e)));
    return () => { live = false; };
  }, [peer?.addr, digits, account]); // eslint-disable-line react-hooks/exhaustive-deps
  const onThere = (a: (typeof ripped)[number]) => !!there && a.tracks.every((t) => there.has(t.id.replace(/^local:/, "")));
  const toggle = (k: string) => setPicked((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  const send = async () => {
    if (!peer) return;
    setSending(true);
    setMsg(null);
    setProgress(null);
    try {
      const r = await sendSongs(peer.addr, digits, account, songs, setProgress);
      setMsg({ ok: true, text: r.sent
        ? `Sent ${albums.length} ${albums.length === 1 ? "album" : "albums"} (${r.sent} files) to ${peer.name}.${r.skipped ? ` ${r.skipped} files were already there, so they weren't sent again.` : ""}`
        : `${peer.name} already has ${albums.length === 1 ? `that ${albums[0].format === "Vinyl" ? "record" : "CD"}` : "all of those"}. Nothing needed sending.` });
      setThere((t) => new Set([...(t ?? []), ...songs]));
    } catch (e) {
      const t = String(e);
      setMsg({ ok: false, text: t === "Stopped" ? "Stopped. What already arrived stays on the other computer." : t });
    } finally {
      setSending(false);
    }
  };

  if (!ripped.length) return <p className="muted">No CDs or records ripped on this computer yet. Rip one and it can go to your other computers.</p>;
  return (
    <div className="link-send">
      <div className="link-step">
        <div className="link-step-head">
          <span className="catalog eyebrow">1 · To</span>
          <Button size="sm" onClick={look} disabled={looking}><RefreshCw size={14} aria-hidden="true" /> Look again</Button>
        </div>
        {looking && !peers?.length ? (
          <p className="muted cd-ripper-wait"><LoaderCircle className="spin" size={16} aria-hidden="true" /> Looking for your other computers…</p>
        ) : peers && peers.length ? (
          <div className="link-peers" role="radiogroup" aria-label="Computer">
            {peers.map((p) => (
              <button key={p.addr} type="button" role="radio" aria-checked={to === p.addr} className={`link-peer${to === p.addr ? " on" : ""}`} disabled={!p.sameAccount || sending} onClick={() => setTo(p.addr)}>
                <Monitor size={18} aria-hidden="true" />
                <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
                  <strong>{p.name}</strong>
                  <span className="caption muted">{p.sameAccount ? "Ready to receive" : "Signed in to a different account"}</span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p className="caption muted">No computers waiting. On your other computer, open Your Computer › Send to another computer › Receive on this computer, then look again.</p>
        )}
      </div>

      <div className="link-step">
        <span className="catalog eyebrow">2 · The code on that computer</span>
        <input className="link-code-input numeral" inputMode="numeric" maxLength={7} placeholder="000 000" value={code} disabled={sending}
          onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ""))} aria-label="Code from the other computer" />
        {checkErr && <span className="form-error caption" role="alert">{checkErr}</span>}
      </div>

      <div className="link-step">
        <span className="catalog eyebrow">3 · What to send · {albums.length} of {ripped.length}</span>
        <div className="link-albums">
          {ripped.map((a) => (
            <label key={a.key} className="link-album">
              <input type="checkbox" checked={picked.has(a.key)} onChange={() => toggle(a.key)} disabled={sending} />
              <span><span className="link-format">{a.format === "Vinyl" ? "Vinyl" : "CD"}</span> <strong>{a.title}</strong> <span className="caption muted">{a.artist} · {a.tracks.length} songs</span>
                {onThere(a) && <span className="link-there caption"> · Already on {peer?.name}</span>}</span>
            </label>
          ))}
        </div>
      </div>

      {sending && (
        <div className="cd-ripper-progress" role="status">
          <div className="mc-progress-rail"><div className="mc-progress-fill" style={{ width: `${progress?.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }} /></div>
          <span className="caption">{progress ? `${sizeLabel(progress.done)} of ${sizeLabel(progress.total)}` : "Connecting…"}</span>
        </div>
      )}
      {msg && <p className={msg.ok ? "form-info" : "form-error"} role="status">{msg.text}</p>}
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        {sending ? (
          <Button onClick={() => void cancelSend()}>Stop</Button>
        ) : (
          <Button variant="primary" onClick={() => void send()} disabled={!peer || digits.length !== 6 || !albums.length}>
            <ArrowLeftRight size={16} aria-hidden="true" /> Send {sendLabel(albums)}
          </Button>
        )}
      </div>
    </div>
  );
}

/** "1 CD", "2 records", "3 albums" (CDs and records together). */
function sendLabel(albums: { format: "CD" | "Vinyl" }[]): string {
  const n = albums.length;
  const vinyl = albums.filter((a) => a.format === "Vinyl").length;
  if (vinyl === 0) return `${n} ${n === 1 ? "CD" : "CDs"}`;
  if (vinyl === n) return `${n} ${n === 1 ? "record" : "records"}`;
  return `${n} albums`;
}
