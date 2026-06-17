interface Props {
  loading?: boolean;
}

export const CoinHintzLogo: React.FC<Props> = ({ loading = false }) => (
  <span className={`st-logo${loading ? " st-logo--wave" : ""}`}>
    <svg
      className="st-logo-icon"
      width="52"
      height="52"
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
      {/* First half of C — green */}
      <path d="M 23.3 12.7 A 7.5 7.5 0 0 0 10.5 18" stroke="#4ade80" strokeWidth="5" strokeLinecap="round" fill="none" />
      {/* Second half of C — white */}
      <path d="M 10.5 18 A 7.5 7.5 0 0 0 23.3 23.3" stroke="white" strokeWidth="5" strokeLinecap="round" fill="none" />
      {/* Outer edge ring */}
      <circle cx="18" cy="18" r="16" stroke="#818cf8" strokeWidth="2" fill="none" />
    </svg>

    <span className="st-logo-wordmark">
      <span className="st-logo-simply">coinhint</span>
      <span className="st-logo-ai">z</span>
    </span>
  </span>
);
