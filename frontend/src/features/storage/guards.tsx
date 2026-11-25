import { Navigate, Outlet } from "react-router-dom";
import { ErrorState, LoadingState } from "@/components/data-state";
import { useStorage } from "./use-storage";

// RequireInitialized runs before the console shell mounts, so an uninitialized
// installation never renders admin pages or fires their data requests.
export function RequireInitialized() {
  const storage = useStorage();
  if (storage.isPending) {
    return (
      <div className="p-6">
        <LoadingState label="正在加载原图存储状态" />
      </div>
    );
  }
  if (storage.error) {
    return (
      <div className="p-6">
        <ErrorState error={storage.error} onRetry={() => void storage.refetch()} />
      </div>
    );
  }
  if (!storage.data) {
    return (
      <div className="p-6">
        <LoadingState label="正在加载原图存储状态" />
      </div>
    );
  }
  if (!storage.data.initialized) {
    return <Navigate to="/setup" replace />;
  }
  return <Outlet />;
}

export function RequireUninitialized() {
  const storage = useStorage();
  if (storage.isPending) {
    return (
      <div className="p-6">
        <LoadingState label="正在加载原图存储状态" />
      </div>
    );
  }
  if (storage.error) {
    return (
      <div className="p-6">
        <ErrorState error={storage.error} onRetry={() => void storage.refetch()} />
      </div>
    );
  }
  if (!storage.data) {
    return (
      <div className="p-6">
        <LoadingState label="正在加载原图存储状态" />
      </div>
    );
  }
  if (storage.data.initialized) {
    return <Navigate to="/overview" replace />;
  }
  return <Outlet />;
}
