import { useState, useEffect, useRef } from "react";
import ReactDOM from "react-dom";
import "../styles/PWAInstallGuide.css";

type Platform = "ios" | "android" | "chrome-desktop" | "edge-desktop" | "safari-mac" | "other-desktop";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  const isTouch = window.matchMedia("(pointer: coarse)").matches;

  if (isTouch) {
    if (/iPad|iPhone|iPod/.test(ua)) return "ios";
    if (/Android/.test(ua)) return "android";
  }

  if (/Edg\//.test(ua)) return "edge-desktop";
  if (/Chrome\//.test(ua) && !/Edg\//.test(ua)) return "chrome-desktop";
  if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) return "safari-mac";
  return "other-desktop";
}

// Platforms where the browser can fire beforeinstallprompt
const SUPPORTS_NATIVE_PROMPT: Platform[] = ["android", "chrome-desktop", "edge-desktop"];

function usePWAInstall() {
  const promptRef = useRef<BeforeInstallPromptEvent | null>(null);
  const [canInstall, setCanInstall] = useState(false);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      promptRef.current = e as BeforeInstallPromptEvent;
      setCanInstall(true);
    };
    const onInstalled = () => { setInstalled(true); setCanInstall(false); };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const install = async () => {
    const prompt = promptRef.current;
    if (!prompt) return false;
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    promptRef.current = null;
    setCanInstall(false);
    if (outcome === "accepted") setInstalled(true);
    return outcome === "accepted";
  };

  return { canInstall, install, installed };
}

const CONFIG: Record<Platform, {
  label: string;
  hint: string;
  steps: { icon: string; text: string }[];
}> = {
  ios: {
    label: "iPhone / iPad",
    hint: "Tap below from Safari to install",
    steps: [
      { icon: "🌐", text: "Open coinhintz.io in Safari (must be Safari, not Chrome)" },
      { icon: "⬆️", text: "Tap the Share button at the bottom of your screen" },
      { icon: "➕", text: 'Scroll down and tap "Add to Home Screen"' },
      { icon: "✅", text: 'Tap "Add" — the icon appears on your home screen!' },
    ],
  },
  android: {
    label: "Android",
    hint: "Install via Chrome for the best experience",
    steps: [
      { icon: "🌐", text: "Open coinhintz.io in Chrome" },
      { icon: "⋮",  text: "Tap the three-dot menu in the top-right corner" },
      { icon: "➕", text: 'Tap "Add to Home screen" or "Install app"' },
      { icon: "✅", text: 'Tap "Install" — the icon appears on your home screen!' },
    ],
  },
  "chrome-desktop": {
    label: "Chrome on Desktop",
    hint: "Install as a desktop app in seconds",
    steps: [
      { icon: "🔗", text: "Make sure you're on coinhintz.io" },
      { icon: "⊕",  text: "Click the install icon (⊕) in the right side of the address bar" },
      { icon: "📦", text: 'Click "Install" in the popup that appears' },
      { icon: "✅", text: "CoinHintz opens as its own window — no browser UI, full screen!" },
    ],
  },
  "edge-desktop": {
    label: "Edge on Desktop",
    hint: "Install as a desktop app in seconds",
    steps: [
      { icon: "🔗", text: "Make sure you're on coinhintz.io" },
      { icon: "⊕",  text: "Click the install icon (⊕) in the right side of the address bar" },
      { icon: "📦", text: 'Click "Install" in the popup that appears' },
      { icon: "✅", text: "CoinHintz opens as its own window — no browser UI, full screen!" },
    ],
  },
  "safari-mac": {
    label: "Safari on Mac",
    hint: "Add to your Dock (macOS Sonoma or later)",
    steps: [
      { icon: "🌐", text: "Open coinhintz.io in Safari" },
      { icon: "📂", text: 'In the menu bar click File → "Add to Dock…"' },
      { icon: "📝", text: "Confirm the name and click Add" },
      { icon: "✅", text: "CoinHintz appears in your Dock as a standalone app!" },
    ],
  },
  "other-desktop": {
    label: "Desktop Browser",
    hint: "Chrome or Edge give the best install experience",
    steps: [
      { icon: "🌐", text: "Open coinhintz.io in Chrome or Edge for the best experience" },
      { icon: "⊕",  text: "Look for an install icon (⊕) in the address bar" },
      { icon: "📦", text: 'Click it and select "Install"' },
      { icon: "✅", text: "CoinHintz opens as a standalone desktop app!" },
    ],
  },
};

interface GuideProps {
  onClose: () => void;
  onNativeInstall?: () => void;
  canInstall?: boolean;
}

export function PWAInstallGuide({ onClose, onNativeInstall, canInstall }: GuideProps) {
  const platform = detectPlatform();
  const { label, hint, steps } = CONFIG[platform];
  const supportsNative = SUPPORTS_NATIVE_PROMPT.includes(platform);

  return ReactDOM.createPortal(
    <div className="pwa-backdrop" onClick={onClose}>
      <div className="pwa-sheet" onClick={e => e.stopPropagation()}>
        <div className="pwa-handle" />

        <div className="pwa-header">
          <img src="/icon.svg" alt="CoinHintz" className="pwa-app-icon" />
          <div className="pwa-header-text">
            <h2 className="pwa-title">Add to Home Screen</h2>
            <p className="pwa-sub">{label} · {hint}</p>
          </div>
          <button className="pwa-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {/* Native install button for Android / Chrome / Edge */}
        {supportsNative && canInstall && onNativeInstall && (
          <button className="pwa-install-btn" onClick={onNativeInstall}>
            Install CoinHintz
          </button>
        )}

        {/* Fallback manual steps */}
        {(!supportsNative || !canInstall) && (
          <div className="pwa-steps">
            {steps.map((step, i) => (
              <div className="pwa-step" key={i}>
                <div className="pwa-step-num">{i + 1}</div>
                <div className="pwa-step-icon">{step.icon}</div>
                <p className="pwa-step-text">{step.text}</p>
              </div>
            ))}
          </div>
        )}

        <div className="pwa-footer">
          <span className="pwa-badge">⚡ Full-screen · Fast · Always up-to-date</span>
        </div>
      </div>
    </div>,
    document.body
  );
}

const IOS_GUIDE_SHOWN_KEY = "pwa_ios_guide_shown";

export function PWAInstallButton({ onCloseMobileNav }: { onCloseMobileNav?: () => void }) {
  const [open, setOpen] = useState(false);
  const { canInstall, install, installed } = usePWAInstall();
  const platform = detectPlatform();
  const supportsNative = SUPPORTS_NATIVE_PROMPT.includes(platform);

  // Auto-show for iOS Safari on first visit if not already installed as PWA
  useEffect(() => {
    if (platform !== "ios") return;
    if ((navigator as Navigator & { standalone?: boolean }).standalone) return; // already installed
    if (localStorage.getItem(IOS_GUIDE_SHOWN_KEY)) return;
    const t = setTimeout(() => {
      localStorage.setItem(IOS_GUIDE_SHOWN_KEY, "1");
      setOpen(true);
    }, 2500);
    return () => clearTimeout(t);
  }, [platform]);

  if (installed) return null;

  const handleClick = () => {
    onCloseMobileNav?.();
    if (supportsNative && canInstall) {
      install();
    } else {
      setOpen(true);
    }
  };

  const handleNativeInstall = async () => {
    await install();
    setOpen(false);
  };

  return (
    <>
      <button className="icon-strip-btn" onClick={handleClick} title="Install App">
        <span className="nav-icon-wrap">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2v13M8 11l4 4 4-4" />
            <path d="M20 16v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2" />
          </svg>
        </span>
        <span className="icon-strip-label">Install App</span>
      </button>
      {open && (
        <PWAInstallGuide
          onClose={() => setOpen(false)}
          canInstall={canInstall}
          onNativeInstall={handleNativeInstall}
        />
      )}
    </>
  );
}
