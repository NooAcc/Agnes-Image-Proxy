import { QueryClient } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { AppProviders } from "@/app/providers";
import { routes } from "@/app/router";

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

export function renderApp(initialEntries: string[], options: { queryClient?: QueryClient } = {}) {
  const queryClient = options.queryClient ?? makeQueryClient();
  const router = createMemoryRouter(routes, { initialEntries });
  const view = render(
    <AppProviders client={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { ...view, router, queryClient };
}
