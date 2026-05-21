const TRADING = "Trading";
const WISE = "Wise";
const AI = ".ai";

interface Props {
  loading?: boolean;
}

export const TradingWiseLogo: React.FC<Props> = ({ loading = false }) => (
  <span className={`st-logo${loading ? " st-logo--wave" : ""}`}>
    <svg
      className="st-logo-icon"
      width="42"
      height="42"
      viewBox="0 0 36 36"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <defs>
        <linearGradient
          id="tw-bg"
          x1="0"
          y1="0"
          x2="36"
          y2="36"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#4f46e5" />
          <stop offset="100%" stopColor="#0284c7" />
        </linearGradient>
      </defs>

      {/* Main W strokes */}
      <polyline
        points="5,9 11,27 18,13 25,27 31,9"
        stroke="url(#tw-bg)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />

      {/* Green accent: right rising arm */}
      <line
        x1="25"
        y1="27"
        x2="31"
        y2="9"
        stroke="#4ade80"
        strokeWidth="2.6"
        strokeLinecap="round"
      />

      {/* Neural nodes */}
      <circle cx="5"  cy="9"  r="2.2" fill="#4f46e5" />
      <circle cx="11" cy="27" r="2"   fill="#2563eb" opacity="0.7" />
      <circle cx="18" cy="13" r="3"   fill="#0284c7" />
      <circle cx="25" cy="27" r="2"   fill="#2563eb" opacity="0.7" />
      {/* Green prediction endpoint */}
      <circle cx="31" cy="9"  r="3"   fill="#4ade80" />
      <circle cx="31" cy="9"  r="1.3" fill="white"   opacity="0.9" />
    </svg>

    <span className="st-logo-wordmark">
      {TRADING.split("").map((ch, i) => (
        <span
          key={i}
          className="st-logo-char st-logo-simply"
          style={loading ? { animationDelay: `${i * 0.06}s` } : undefined}
        >
          {ch}
        </span>
      ))}
      {WISE.split("").map((ch, i) => (
        <span
          key={i}
          className="st-logo-char st-logo-trade"
          style={
            loading
              ? { animationDelay: `${(TRADING.length + i) * 0.06}s` }
              : undefined
          }
        >
          {ch}
        </span>
      ))}
      {AI.split("").map((ch, i) => (
        <span
          key={i}
          className="st-logo-char st-logo-ai"
          style={
            loading
              ? {
                  animationDelay: `${(TRADING.length + WISE.length + i) * 0.06}s`,
                }
              : undefined
          }
        >
          {ch}
        </span>
      ))}
    </span>
  </span>
);
