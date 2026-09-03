interface AvatarProps {
  url?: string | null;
  fallback: string;
  className: string;
}

// Every avatar spot (profile header, chat comments, account menu, mobile
// nav) already has its own sizing/background CSS on its own class name —
// this just decides image vs. that class's existing initials fallback,
// each call site keeps computing its own fallback text so this doesn't
// change how any of them currently abbreviate a name.
export function Avatar({ url, fallback, className }: AvatarProps) {
  if (url) return <img className={className} src={url} alt="" />;
  return (
    <div className={className}>
      <span>{fallback}</span>
    </div>
  );
}
