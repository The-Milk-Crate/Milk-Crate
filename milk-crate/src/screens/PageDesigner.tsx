import { useEffect, useState } from "react";
import { ImagePlus, Type, Upload as UploadIcon } from "lucide-react";
import type { Go } from "../App";
import type { Artist, ArtistPage } from "../lib/types";
import { useCatalog } from "../lib/catalog";
import { fileNameOf, pickFile } from "../lib/localFiles";
import { NAME_FONTS, cssUrl, useNameFamily } from "../lib/artistPage";
import { ArtistBanner } from "../components/ArtistBanner";
import { Button } from "../components/ui";

const NAME_COLORS = ["#13110f", "#f3ede3", "#ffffff", "#ff5b3a", "#ffd43b", "#9be15d", "#5fd4d0", "#7aa2ff", "#c2b1f8", "#ff8fc7"];
const SIZES: { id: NonNullable<ArtistPage["size"]>; label: string }[] = [
  { id: "m", label: "Medium" },
  { id: "l", label: "Large" },
  { id: "xl", label: "Huge" },
];

/** Drops unset keys so "unchanged" compares cleanly with what's saved. */
const tidy = (p: ArtistPage) => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && v !== false && v !== "")) as ArtistPage;

/**
 * For artists: design your page. Photos, banner, and your name in your own
 * lettering (a font, color and style, or an uploaded logo). The preview is
 * exactly what listeners will see once you save.
 */
export function PageDesigner({ go }: { go: Go }) {
  const c = useCatalog();
  const me = c.myProfile!;
  const saved = JSON.stringify(me.page);
  const [draft, setDraft] = useState<ArtistPage>(me.page);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // When the saved design changes (after saving), start from it.
  useEffect(() => setDraft(JSON.parse(saved)), [saved]);

  const set = (patch: Partial<ArtistPage>) => setDraft((d) => tidy({ ...d, ...patch }));
  const changed = JSON.stringify(tidy(draft)) !== JSON.stringify(tidy(me.page));
  const preview: Artist = { ...me, page: draft };
  const textMode = draft.nameMode !== "logo";

  const pickPhoto = async (key: "banner" | "bannerTall" | "logo") => {
    const url = await pickFile(key === "logo" ? "logo" : "image");
    if (url) set(key === "logo" ? { logo: url, nameMode: "logo" } : { [key]: url });
  };
  const pickFont = async () => {
    const url = await pickFile("font");
    if (url) set({ font: "custom", fontUrl: url, fontName: fileNameOf(url) });
  };

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await c.savePage(tidy(draft), setStatus);
    } catch (e) {
      setStatus("");
      setError(`Couldn't save your page: ${(e as Error).message}`);
    }
    setSaving(false);
  };

  return (
    <section className="panel designer" aria-labelledby="designer-title">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <h2 className="display-md" id="designer-title">Design your page</h2>
          <p className="caption muted">The previews show your banner on a wide window and a tall one. Nothing changes for listeners until you save.</p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => go({ name: "artist", artistId: me.id })}>View your page</Button>
      </div>

      <div className="designer-previews">
        <figure className="preview-frame wide">
          <div className="preview-box"><ArtistBanner artist={preview} fill headingLevel={2} /></div>
          <figcaption className="caption muted">Wide window</figcaption>
        </figure>
        <figure className="preview-frame tall">
          <div className="preview-box"><ArtistBanner artist={preview} fill headingLevel={2} /></div>
          <figcaption className="caption muted">Tall window or phone</figcaption>
        </figure>
      </div>

      <div className="designer-grid">
        <fieldset className="designer-group">
          <legend className="designer-legend">Banner</legend>
          <ImageSlot label="Wide banner" hint="Landscape, for wide windows. 16 : 9 works well (for example 1920 × 1080)." shape="wide" value={draft.banner}
            onPick={() => pickPhoto("banner")} onRemove={() => set({ banner: undefined })} />
          <ImageSlot label="Vertical banner" hint="Optional. Portrait, for tall windows and phones: 9 : 16 (for example 1080 × 1920). The page fades between your two banners as the window changes shape. Leave it empty to use the wide one everywhere." shape="tall" value={draft.bannerTall}
            onPick={() => pickPhoto("bannerTall")} onRemove={() => set({ bannerTall: undefined })} />
          {(draft.banner || draft.bannerTall) && (
            <button type="button" className="chip" aria-pressed={!draft.noShade} onClick={() => set({ noShade: !draft.noShade })} style={{ alignSelf: "flex-start" }}>
              Shade behind name
            </button>
          )}
        </fieldset>

        <fieldset className="designer-group">
          <legend className="designer-legend">Your name</legend>
          <div role="group" aria-label="How your name appears" className="segmented">
            <button type="button" className="chip" aria-pressed={textMode} onClick={() => set({ nameMode: undefined })}>
              <Type size={16} aria-hidden="true" /> Lettered name
            </button>
            <button type="button" className="chip" aria-pressed={!textMode} onClick={() => set({ nameMode: "logo" })}>
              <ImagePlus size={16} aria-hidden="true" /> Logo or drawn lettering
            </button>
          </div>

          {!textMode ? (
            <ImageSlot label="Logo or lettering" shape="logo" value={draft.logo}
              hint="A PNG or SVG with a transparent background works best. Draw your name, scan or photograph it, and upload it here."
              onPick={() => pickPhoto("logo")} onRemove={() => set({ logo: undefined })} />
          ) : (
            <>
              <div className="field">
                <span className="catalog eyebrow" id="font-label">Font</span>
                <div className="font-grid" role="group" aria-labelledby="font-label">
                  {NAME_FONTS.map((f, i) => (
                    <button key={f.id} type="button" className="font-tile" aria-pressed={(draft.font ?? "milkcrate") === f.id || (!draft.font && i === 0)}
                      onClick={() => set({ font: f.id === "milkcrate" ? undefined : f.id })}>
                      <span className="font-tile-sample" style={{ fontFamily: f.family, fontWeight: f.id === "clean" ? 600 : 400 }}>{me.name}</span>
                      <span className="caption muted">{f.label}</span>
                    </button>
                  ))}
                  <CustomFontTile page={draft} name={me.name} onPick={pickFont} onUse={() => set({ font: "custom" })} />
                </div>
                <span className="caption muted">Uploading a font? Use one you're licensed to use on the web (TTF, OTF, WOFF or WOFF2).</span>
              </div>

              <div className="field">
                <span className="catalog eyebrow" id="color-label">Color</span>
                <div role="group" aria-labelledby="color-label" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
                  <button type="button" className="chip" aria-pressed={!draft.nameColor} onClick={() => set({ nameColor: undefined })}>Auto</button>
                  {NAME_COLORS.map((col) => (
                    <button key={col} type="button" className="swatch" aria-label={`Name color ${col}`} aria-pressed={draft.nameColor === col}
                      onClick={() => set({ nameColor: col })} style={{ background: col }} />
                  ))}
                  <label className="swatch swatch-custom" title="Pick any color">
                    <input type="color" value={draft.nameColor ?? "#13110f"} onChange={(e) => set({ nameColor: e.target.value })} aria-label="Custom name color" />
                  </label>
                </div>
              </div>

              <div className="field">
                <span className="catalog eyebrow" id="style-label">Style</span>
                <div role="group" aria-labelledby="style-label" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <button type="button" className="chip" aria-pressed={!!draft.bold} onClick={() => set({ bold: !draft.bold })} style={{ fontWeight: 800 }}>Bold</button>
                  <button type="button" className="chip" aria-pressed={!!draft.italic} onClick={() => set({ italic: !draft.italic })} style={{ fontStyle: "italic" }}>Italic</button>
                  <button type="button" className="chip" aria-pressed={!!draft.caps} onClick={() => set({ caps: !draft.caps })}>ALL CAPS</button>
                  <span aria-hidden="true" style={{ width: 8 }} />
                  {SIZES.map((s) => (
                    <button key={s.id} type="button" className="chip" aria-pressed={(draft.size ?? "l") === s.id} onClick={() => set({ size: s.id === "l" ? undefined : s.id })}>{s.label}</button>
                  ))}
                </div>
              </div>

              <p className="caption muted" style={{ marginTop: -8 }}>Your name always sits on one centered line. Long names shrink to fit; the size sets how big it can get.</p>

              <label className="field">
                <span className="catalog eyebrow">Letter spacing</span>
                <input type="range" min={-5} max={30} step={1} value={Math.round((draft.spacing ?? 0) * 100)}
                  onChange={(e) => set({ spacing: Number(e.target.value) / 100 || undefined })} className="range" />
              </label>
            </>
          )}
        </fieldset>
      </div>

      {error && <p role="alert" className="form-error">{error}</p>}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
        <Button variant="primary" onClick={save} disabled={!changed || saving}>{saving ? status || "Saving…" : "Save page"}</Button>
        {changed && !saving && <Button variant="ghost" onClick={() => setDraft(me.page)}>Undo changes</Button>}
        {!changed && !saving && <span className="caption muted">All changes saved.</span>}
      </div>
    </section>
  );
}

function CustomFontTile({ page, name, onPick, onUse }: { page: ArtistPage; name: string; onPick: () => void; onUse: () => void }) {
  const family = useNameFamily({ font: "custom", fontUrl: page.fontUrl });
  if (!page.fontUrl)
    return (
      <button type="button" className="font-tile font-tile-upload" onClick={onPick}>
        <UploadIcon size={20} aria-hidden="true" />
        <span className="caption muted">Upload a font</span>
      </button>
    );
  return (
    <div className="font-tile-wrap">
      <button type="button" className="font-tile" aria-pressed={page.font === "custom"} onClick={onUse}>
        <span className="font-tile-sample" style={{ fontFamily: family }}>{name}</span>
        <span className="caption muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{page.fontName || "Your font"}</span>
      </button>
      <button type="button" className="link-btn caption" onClick={onPick}>Replace</button>
    </div>
  );
}

function ImageSlot(props: { label: string; hint: string; shape: "wide" | "tall" | "logo"; value?: string; onPick: () => void; onRemove: () => void }) {
  const { label, hint, shape, value, onPick, onRemove } = props;
  return (
    <div className="field">
      <span className="catalog eyebrow">{label}</span>
      <button type="button" className={`slot slot-${shape}${value ? " filled" : ""}`} onClick={onPick}
        aria-label={value ? `Change ${label.toLowerCase()}` : `Add ${label.toLowerCase()}`}
        style={value && shape !== "logo" ? { backgroundImage: cssUrl(value) } : undefined}>
        {value && shape === "logo" && <img src={value} alt="" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />}
        {!value && <><ImagePlus size={20} aria-hidden="true" /><span>Add</span></>}
      </button>
      <span className="caption muted">{hint}</span>
      {value && (
        <span style={{ display: "flex", gap: 12 }}>
          <button type="button" className="link-btn caption" onClick={onPick}>Change</button>
          <button type="button" className="link-btn caption" onClick={onRemove}>Remove</button>
        </span>
      )}
    </div>
  );
}
