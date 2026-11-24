import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { ThemeProvider } from "@/app/theme";
import { setUnauthorizedHandler } from "@/lib/api";
import { blobCache } from "@/lib/blob-cache";
import { SessionStateContext } from "@/lib/session-state";

export function AppProviders({
  children,
  client,
}: {
  children: ReactNode;
  client?: QueryClient;
}) {
  const [expired, setExpired] = useState(false);
  const [queryClient] = useState(
    () =>
      client ??
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 1,
            staleTime: 5_000,
            refetchOnWindowFocus: false,
          },
          mutations: {
            retry: false,
          },
        },
      }),
  );

  // A 401 from any admin call clears every cached response so the next session
  // never shows data from the previous login.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setExpired(true);
      void queryClient.cancelQueries();
      queryClient.clear();
      blobCache.clear();
    });
    return () => setUnauthorizedHandler(null);
  }, [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <SessionStateContext.Provider value={{ expired, reset: () => setExpired(false) }}>
        <ThemeProvider>{children}</ThemeProvider>
      </SessionStateContext.Provider>
    </QueryClientProvider>
  );
}
