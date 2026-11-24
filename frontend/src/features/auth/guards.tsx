import { Navigate, Outlet, useLocation } from "react-router-dom";
import { ErrorState, LoadingState } from "@/components/data-state";
import { isUnauthorized } from "@/lib/errors";
import { useSession } from "./use-session";
import { useSessionState } from "@/lib/session-state";

// RequireSession redirects an expired or missing session once, at the route
// boundary, so individual requests never race each other into /login.
export function RequireSession() {
  const session = useSession();
  const { expired } = useSessionState();
  const location = useLocation();

  if (expired) return <Navigate to="/login" replace state={{ from: location }} />;

  if (session.isPending) {
    return (
      <div className="p-6">
        <LoadingState label="正在验证会话" />
      </div>
    );
  }
  if (isUnauthorized(session.error)) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  if (session.error) {
    return (
      <div className="p-6">
        <ErrorState error={session.error} onRetry={() => void session.refetch()} />
      </div>
    );
  }
  if (!session.data?.authenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  return <Outlet />;
}
