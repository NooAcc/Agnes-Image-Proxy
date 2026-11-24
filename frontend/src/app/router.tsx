import { Navigate, createBrowserRouter, type RouteObject } from "react-router-dom";
import { AppShell } from "@/app/shell";
import { AccountsPage } from "@/features/accounts/accounts-page";
import { RequireSession } from "@/features/auth/guards";
import { LoginPage } from "@/features/auth/login-page";
import { GalleryPage } from "@/features/gallery/page";
import { LogsPage } from "@/features/logs/logs-page";
import { OverviewPage } from "@/features/overview/page";
import { SettingsPage } from "@/features/settings/settings-page";

export const routes: RouteObject[] = [
  { path: "/login", element: <LoginPage /> },
  {
    path: "/",
    element: <RequireSession />,
    children: [
      {
        element: <AppShell />,
        children: [
          { index: true, element: <Navigate to="/overview" replace /> },
          { path: "overview", element: <OverviewPage /> },
          { path: "gallery", element: <GalleryPage /> },
          { path: "accounts", element: <AccountsPage /> },
          { path: "logs", element: <LogsPage /> },
          { path: "settings", element: <SettingsPage /> },
        ],
      },
    ],
  },
];

export const router = createBrowserRouter(routes, { basename: "/admin" });
