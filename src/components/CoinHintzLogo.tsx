interface Props {
  loading?: boolean;
  variant?: "default" | "nav";
}

const LogoIcon = ({ size = 36, animated = false }: { size?: number; animated?: boolean }) => (
  <svg
    className="st-logo-icon"
    width={size}
    height={size}
    viewBox="0 0 36 36"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <defs>
      <linearGradient id="ch-grad" x1="0" y1="0" x2="36" y2="36" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stopColor="#4f46e5" />
        <stop offset="100%" stopColor="#2563eb" />
      </linearGradient>
    </defs>
    <circle cx="18" cy="18" r="16" fill="url(#ch-grad)" />
    <path
      d="M 23.3 12.7 A 7.5 7.5 0 0 0 10.5 18"
      pathLength={1}
      className={animated ? "logo-c-arc logo-c-arc-1" : undefined}
      stroke="#4ade80" strokeWidth="4" strokeLinecap="round" fill="none"
    />
    <path
      d="M 10.5 18 A 7.5 7.5 0 0 0 23.3 23.3"
      pathLength={1}
      className={animated ? "logo-c-arc logo-c-arc-2" : undefined}
      stroke="white" strokeWidth="4" strokeLinecap="round" fill="none"
    />
    <circle cx="18" cy="18" r="16" stroke="#818cf8" strokeWidth="2" fill="none" />
  </svg>
);

export const CoinHintzLogo: React.FC<Props> = ({ loading = false, variant = "default" }) => {
  if (variant === "nav") {
    return (
      <span style={{ display: "flex", alignItems: "center", gap: "8px", textDecoration: "none" }}>
        <LogoIcon size={32} />
        <span style={{ fontSize: "18px", fontWeight: 700, color: "#4f46e5", letterSpacing: "-0.3px" }}>
          coinhint<span style={{ color: "#4ade80" }}>z</span>
        </span>
      </span>
    );
  }

  return (
    <span className={`st-logo${loading ? " st-logo--wave" : ""}`}>
      {loading ? (
        <span className="boot-logo-wrap">
          <span className="boot-glow" />
          <span className="boot-spinner-ring" />
          <LogoIcon size={52} animated />
        </span>
      ) : (
        <LogoIcon size={52} />
      )}
      <span className="st-logo-wordmark">
        <span className="st-logo-simply">coinhint</span>
        <span className="st-logo-ai">z</span>
      </span>
    </span>
  );
};
