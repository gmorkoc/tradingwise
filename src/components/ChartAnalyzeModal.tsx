import { useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";
import { useTranslation } from "react-i18next";
import { supabase } from "../services/supabase";
import { useAIQuota } from "../hooks/useAIQuota";
import { AIQuotaWall } from "./AIQuotaWall";
import "../styles/ChartAnalyzeModal.css";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onOpenUpgrade: () => void;
  onOpenAuth: () => void;
  coin?: string;
}

interface PickedImage {
  id: string;
  blob: Blob;
  previewUrl: string;
}

// Framed as multiple timeframes of the SAME asset (1D/1W/1M …) rather than
// unrelated charts — matches the "Single asset per image" guidance shown
// in the tips card below, and keeps the vision prompt focused.
const MAX_IMAGES = 3;

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// GPT's reply is loosely Markdown (### headings, **bold**, "- " separated
// clauses) but not reliably newline-delimited — a real chart-analysis
// sample came back as one run-on line per section ("### Trend Analysis: -
// **Overall Trend:** Uptrend - The price has been rising steeply...")
// rather than actual bullet lines. Pulling a full Markdown library in for
// this one panel felt heavy, so this is a small tolerant parser: split on
// headings, then split each section's body on " - " into list items when
// there are multiple (falls back to a plain paragraph otherwise), so it
// degrades gracefully if the model's formatting habits drift.
function highlightNumbers(text: string, key: string): React.ReactNode[] {
  const parts = text.split(/(\$[\d,]+(?:\.\d+)?|\b\d+(?:\.\d+)?%)/g);
  return parts.map((part, i) =>
    /^\$[\d,]/.test(part) || /%$/.test(part)
      ? <span key={`${key}-n${i}`} className="caz-number">{part}</span>
      : part
  );
}

function parseInline(text: string, key: string): React.ReactNode[] {
  return text.split(/\*\*(.+?)\*\*/g).flatMap((part, i): React.ReactNode[] =>
    i % 2 === 1 ? [<strong key={`${key}-b${i}`}>{part}</strong>] : highlightNumbers(part, `${key}-${i}`)
  );
}

function renderAnalysis(text: string): React.ReactNode[] {
  // Headings must stop at the first colon, not run to end-of-line — real
  // output came back as one continuous line per section ("### Trend
  // Analysis: - **Overall Trend:** Uptrend - ..."), so a greedy
  // [^\n]+ swallowed the entire section body into the heading text.
  const tokens = text.split(/#{1,4}\s+([^\n:]+):\s*/);
  const nodes: React.ReactNode[] = [];
  tokens.forEach((chunk, i) => {
    if (i % 2 === 1) {
      nodes.push(<h4 key={`h${i}`} className="caz-result-heading">{chunk.trim()}</h4>);
      return;
    }
    // Strip a leading "-" up front, regardless of whether whitespace
    // follows it ("- Text" and "-Text" both happen in real output) — the
    // split below only catches mid-string "- " occurrences reliably;
    // relying on it alone for the very first bullet left a dangling
    // dash whenever the model omitted the space ("-Strong uptrend...").
    const body = chunk.replace(/^[:\s]+/, "").replace(/^-\s*/, "").trim();
    if (!body) return;
    const items = body.split(/\s*-\s+/).map(s => s.trim()).filter(Boolean);
    if (items.length >= 2) {
      nodes.push(
        <ul key={`l${i}`} className="caz-result-list">
          {items.map((item, li) => <li key={li}>{parseInline(item.replace(/\.$/, ""), `${i}-${li}`)}</li>)}
        </ul>
      );
    } else {
      nodes.push(<p key={`p${i}`}>{parseInline(items[0] ?? body, `${i}`)}</p>);
    }
  });
  return nodes;
}

export const ChartAnalyzeModal: React.FC<Props> = ({ isOpen, onClose, onOpenUpgrade, onOpenAuth, coin }) => {
  const { t } = useTranslation();
  const { isPaid, used, limit } = useAIQuota();
  const backdropRef = useRef<HTMLDivElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const libraryInputRef = useRef<HTMLInputElement>(null);

  const [images, setImages] = useState<PickedImage[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [tipsOpen, setTipsOpen] = useState(true);
  const [dragActive, setDragActive] = useState(false);

  // Fresh state every time the modal opens — a stale result/error from a
  // previous open shouldn't flash before the reset below has a chance to run.
  useEffect(() => {
    if (!isOpen) return;
    setImages([]);
    setAnalyzing(false);
    setAnalysis(null);
    setError("");
  }, [isOpen]);

  // Object URLs are only good for this tab's lifetime — release them
  // whenever the picked set changes or the modal goes away, not just on
  // unmount, since a long modal session can pick/remove many images.
  useEffect(() => {
    return () => { images.forEach(img => URL.revokeObjectURL(img.previewUrl)); };
  }, [images]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const addBlobs = (blobs: Blob[]) => {
    setImages(prev => {
      const room = MAX_IMAGES - prev.length;
      if (room <= 0) return prev;
      const next = blobs.slice(0, room).map(blob => ({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        blob,
        previewUrl: URL.createObjectURL(blob),
      }));
      return [...prev, ...next];
    });
  };

  const removeImage = (id: string) => {
    setImages(prev => {
      const target = prev.find(img => img.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter(img => img.id !== id);
    });
  };

  const handleTakePhoto = async () => {
    if (images.length >= MAX_IMAGES) return;
    if (!Capacitor.isNativePlatform()) { cameraInputRef.current?.click(); return; }
    try {
      const photo = await Camera.getPhoto({
        resultType: CameraResultType.Uri,
        source: CameraSource.Camera,
        quality: 80,
      });
      if (!photo.webPath) return;
      const blob = await fetch(photo.webPath).then(r => r.blob());
      addBlobs([blob]);
    } catch (err: any) {
      const msg = String(err?.message ?? err ?? "");
      if (msg === "User cancelled photos app" || msg === "No image picked") return;
      console.error("Camera capture failed:", err);
      setError(msg || t("chartAnalyze.errors.pickFailed", "Couldn't open the camera — please try again."));
    }
  };

  const handlePickLibrary = async () => {
    if (images.length >= MAX_IMAGES) return;
    if (!Capacitor.isNativePlatform()) { libraryInputRef.current?.click(); return; }
    try {
      const result = await Camera.pickImages({
        quality: 80,
        limit: MAX_IMAGES - images.length,
      });
      if (result.photos.length === 0) return;
      const blobs = await Promise.all(result.photos.map(p => fetch(p.webPath).then(r => r.blob())));
      addBlobs(blobs);
    } catch (err: any) {
      const msg = String(err?.message ?? err ?? "");
      if (msg === "User cancelled photos app" || msg === "No image picked") return;
      console.error("Library pick failed:", err);
      setError(msg || t("chartAnalyze.errors.pickFailed", "Couldn't open the photo library — please try again."));
    }
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length > 0) addBlobs(files);
  };

  // Web/desktop only — dragging a real File onto a native WKWebView never
  // fires these, so this is purely additive there (no drop target, no
  // behavior change, nothing to gate on Capacitor.isNativePlatform()).
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (images.length < MAX_IMAGES) setDragActive(true);
  };
  const handleDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDragActive(false);
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const files = Array.from(e.dataTransfer.files ?? []).filter(f => f.type.startsWith("image/"));
    if (files.length > 0) addBlobs(files);
  };

  const handleAnalyze = async () => {
    if (images.length === 0 || analyzing) return;
    setAnalyzing(true);
    setError("");
    try {
      const dataUrls = await Promise.all(images.map(img => blobToDataUrl(img.blob)));
      const { data, error: fnError } = await supabase.functions.invoke("analyze-chart", {
        body: { images: dataUrls, coin: coin ?? null },
      });
      if (fnError) throw new Error(fnError.message);
      if (!data?.analysis) throw new Error(t("chartAnalyze.errors.noResult", "Analysis failed — please try again."));
      setAnalysis(data.analysis);
    } catch (err: any) {
      setError(err?.message || t("chartAnalyze.errors.analyzeFailed", "Something went wrong analyzing your chart — please try again."));
    } finally {
      setAnalyzing(false);
    }
  };

  const handleReset = () => {
    images.forEach(img => URL.revokeObjectURL(img.previewUrl));
    setImages([]);
    setAnalysis(null);
    setError("");
  };

  const handleBackdrop = (e: React.MouseEvent) => {
    if (e.target === backdropRef.current) onClose();
  };

  return (
    <div className="caz-overlay" ref={backdropRef} onClick={handleBackdrop}>
      <div className={`caz-panel${!isPaid ? " caz-panel--gated" : ""}`} role="dialog" aria-modal="true">
        {isPaid ? (
          <div className="caz-header">
            <div>
              <h2 className="caz-title">{t("chartAnalyze.title", "Analyze a Chart")}</h2>
              <p className="caz-subtitle">{t("chartAnalyze.subtitle", "Snap or upload a chart and get a real technical read, powered by AI.")}</p>
            </div>
            <button className="caz-close" onClick={onClose} aria-label="Close">✕</button>
          </div>
        ) : (
          // Gated: no white header strip at all — the promo card below
          // fills the entire panel edge to edge, title/badges included,
          // and this floats directly on top of it instead.
          <button className="caz-close caz-close--floating" onClick={onClose} aria-label="Close">✕</button>
        )}

        <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }} onChange={handleFileInput} />
        <input ref={libraryInputRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={handleFileInput} />

        {!isPaid ? (
          // The header above is just a close button when gated (see
          // caz-header--gated) — this card is the sole title-bearing
          // content, not a duplicate of a plain-text header title.
          <AIQuotaWall
            used={used} limit={limit}
            onOpenUpgrade={onOpenUpgrade} onOpenAuth={onOpenAuth}
            planId="pro"
            featureTitle={t("chartAnalyze.title", "Analyze a Chart")}
            featureDesc={t("chartAnalyze.gateDesc", "Upload a chart screenshot and get a full AI technical breakdown — patterns, levels, and a real take.")}
          />
        ) : analysis ? (
          <div className="caz-result">
            <div className="caz-result-badge">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.9 5.8L20 9l-6.1 1.2L12 16l-1.9-5.8L4 9l6.1-1.2z" /></svg>
              {t("chartAnalyze.aiRead", "AI Read")}
            </div>
            {images.length > 0 && (
              <div className="caz-result-thumbs">
                {images.map(img => <img key={img.id} src={img.previewUrl} alt="" />)}
              </div>
            )}
            <div className="caz-result-text">
              {renderAnalysis(analysis)}
            </div>
            <div className="caz-result-actions">
              <button className="caz-btn caz-btn--ghost" onClick={handleReset}>{t("chartAnalyze.analyzeAnother", "Analyze another")}</button>
              <button className="caz-btn caz-btn--primary" onClick={onClose}>{t("chartAnalyze.done", "Done")}</button>
            </div>
          </div>
        ) : (
          <div className="caz-body">
            <div
              className={`caz-dropzone${dragActive ? " caz-dropzone--active" : ""}`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              <div className="caz-hero">
                <div className="caz-hero-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 5H8a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2V7a2 2 0 00-2-2z" />
                    <circle cx="12.5" cy="11.5" r="1.5" />
                    <path d="M6 15l3-3 2.5 2.5L16 10l4 4" />
                    <path d="M4 9v10a2 2 0 002 2h10" />
                  </svg>
                </div>
                <h3 className="caz-hero-title">{t("chartAnalyze.addYourChart", "Add Your Chart")}</h3>
                <p className="caz-hero-sub">{t("chartAnalyze.pickSubtitle", "Take a photo or pick from your gallery")}</p>
              </div>

              <div className="caz-pick-stack">
                <button type="button" className="caz-pick-btn" onClick={handleTakePhoto} disabled={images.length >= MAX_IMAGES}>
                  <svg className="caz-pick-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" />
                    <path d="M16 13a4 4 0 11-8 0 4 4 0 018 0z" />
                  </svg>
                  <span className="caz-pick-label">{t("chartAnalyze.takePhoto", "Take Photo")}</span>
                  <svg className="caz-pick-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
                </button>
                <button type="button" className="caz-pick-btn" onClick={handlePickLibrary} disabled={images.length >= MAX_IMAGES}>
                  <svg className="caz-pick-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <path d="M21 15l-5-5L5 21" />
                  </svg>
                  <span className="caz-pick-label">{t("chartAnalyze.chooseLibrary", "Photo Library")}</span>
                  <svg className="caz-pick-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
                </button>
              </div>

              {!Capacitor.isNativePlatform() && (
                <p className="caz-drop-hint">{t("chartAnalyze.dropHint", "or drag and drop image files here")}</p>
              )}
            </div>

            {images.length > 0 && (
              <div className="caz-thumbs">
                {images.map(img => (
                  <div key={img.id} className="caz-thumb">
                    <img src={img.previewUrl} alt="" />
                    <button type="button" className="caz-thumb-remove" onClick={() => removeImage(img.id)} aria-label="Remove image">✕</button>
                  </div>
                ))}
              </div>
            )}

            <div className="caz-tips">
              <button type="button" className="caz-tips-head" onClick={() => setTipsOpen(v => !v)}>
                <span className="caz-tips-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18h6M10 22h4M12 2a6 6 0 00-4 10.5c.6.5 1 1.3 1 2.1V16h6v-1.4c0-.8.4-1.6 1-2.1A6 6 0 0012 2z" /></svg>
                </span>
                <span className="caz-tips-head-text">
                  <span className="caz-tips-title">{t("chartAnalyze.tipsTitle", "Tips For Best Results")}</span>
                  <span className="caz-tips-desc">{t("chartAnalyze.tipsDesc", "For best results: upload 1–3 timeframes of the same asset")}</span>
                </span>
                <svg className={`caz-tips-chev${tipsOpen ? " caz-tips-chev--open" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 15l-6-6-6 6" /></svg>
              </button>
              {tipsOpen && (
                <div className="caz-tips-body">
                  <p className="caz-tips-group-label caz-tips-group-label--good">{t("chartAnalyze.goodCharts", "Good charts")}</p>
                  <ul className="caz-tips-list caz-tips-list--good">
                    <li>{t("chartAnalyze.good1", "Clear price line with visible time axis")}</li>
                    <li>{t("chartAnalyze.good2", "TradingView screenshots, broker apps, or desktop charts")}</li>
                    <li>{t("chartAnalyze.good3", "Single asset per image")}</li>
                  </ul>
                  <p className="caz-tips-group-label caz-tips-group-label--avoid">{t("chartAnalyze.avoid", "Avoid")}</p>
                  <ul className="caz-tips-list caz-tips-list--avoid">
                    <li>{t("chartAnalyze.avoid1", "Blurry or angled photos")}</li>
                    <li>{t("chartAnalyze.avoid2", "Multiple charts crammed in one image")}</li>
                    <li>{t("chartAnalyze.avoid3", "Charts with too much clutter (overlapping indicators)")}</li>
                  </ul>
                </div>
              )}
            </div>

            <p className="caz-footer-hint">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M8 7V5a2 2 0 012-2h4a2 2 0 012 2v2" /></svg>
              {t("chartAnalyze.footerHint", "Add up to {{max}} timeframes for deeper analysis (e.g. 1D, 1W, 1M)", { max: MAX_IMAGES })}
            </p>

            {error && <p className="caz-error">{error}</p>}

            <button
              type="button"
              className="caz-btn caz-btn--primary caz-analyze-btn"
              onClick={handleAnalyze}
              disabled={images.length === 0 || analyzing}
            >
              {analyzing
                ? t("chartAnalyze.analyzing", "Analyzing…")
                : images.length > 1
                  ? t("chartAnalyze.analyzeCount", "Analyze {{count}} charts", { count: images.length })
                  : t("chartAnalyze.analyzeOne", "Analyze chart")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
