import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

// No crash/error reporting exists anywhere in this app (confirmed via
// repo-wide search) and there was no top-level boundary at all before
// this — any render-time throw (e.g. in the post-sign-in profile-gated
// render tree) unmounted the entire React tree with nothing to catch it,
// leaving #root empty on top of the dark-navy base background. That's
// indistinguishable from "everything is black" with zero diagnostic
// info. This boundary turns that into a visible, recoverable screen.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary] caught render error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            position: "fixed",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 16,
            padding: 24,
            textAlign: "center",
            background: "#0f1a2a",
            color: "#e2e8f0",
            fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
            zIndex: 999999,
          }}
        >
          <div style={{ fontSize: 17, fontWeight: 700 }}>Something went wrong</div>
          <div style={{ fontSize: 13, color: "#94a3b8", maxWidth: 320 }}>
            {this.state.error.message || "The app hit an unexpected error."}
          </div>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              all: "unset",
              cursor: "pointer",
              padding: "10px 24px",
              borderRadius: 999,
              background: "#4f6df5",
              color: "#fff",
              fontWeight: 700,
              fontSize: 14,
            }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
