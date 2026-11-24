import {
  Images,
  LayoutDashboard,
  Menu,
  ScrollText,
  Settings,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useTheme, type ThemeMode } from "@/app/theme";
import { cn } from "@/lib/utils";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

const NAV_ITEMS: NavItem[] = [
  { to: "/overview", label: "总览", icon: LayoutDashboard },
  { to: "/gallery", label: "图库", icon: Images },
  { to: "/accounts", label: "账号", icon: Users },
  { to: "/logs", label: "日志", icon: ScrollText },
  { to: "/settings", label: "设置", icon: Settings },
];

const PAGE_TITLES: Record<string, string> = {
  "/overview": "总览",
  "/gallery": "图库",
  "/accounts": "账号",
  "/logs": "日志",
  "/settings": "设置",
  "/login": "登录",
};

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav aria-label="主导航" className="flex flex-col gap-1 p-3">
      <div className="px-3 py-2 text-base font-semibold text-foreground">Agnes 控制台</div>
      {NAV_ITEMS.map((item) => {
        const Icon = item.icon;
        return (
          <NavLink
            key={item.to}
            to={item.to}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                "flex min-h-11 items-center gap-3 rounded-[var(--component-radius)] px-3 text-sm transition-colors duration-150",
                isActive
                  ? "bg-surface-muted font-medium text-foreground"
                  : "text-muted-foreground hover:bg-surface-muted hover:text-foreground",
              )
            }
          >
            <Icon aria-hidden="true" className="size-5 shrink-0" />
            {item.label}
          </NavLink>
        );
      })}
    </nav>
  );
}

function ThemeControl() {
  const { mode, setMode } = useTheme();
  return (
    <div className="flex items-center gap-2">
      <label htmlFor="theme-mode" className="text-sm text-muted-foreground">
        主题
      </label>
      <select
        id="theme-mode"
        aria-label="主题"
        value={mode}
        onChange={(event) => setMode(event.target.value as ThemeMode)}
        className="h-11 rounded-[var(--component-radius)] border border-control bg-surface px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <option value="system">跟随系统</option>
        <option value="light">浅色</option>
        <option value="dark">深色</option>
      </select>
    </div>
  );
}

function pageTitle(pathname: string): string {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return PAGE_TITLES[normalized] ?? "Agnes 控制台";
}

export function AppShell() {
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="min-h-dvh bg-background text-foreground lg:grid lg:grid-cols-[16rem_minmax(0,1fr)]">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-[var(--component-radius)] focus:bg-surface focus:px-4 focus:py-2 focus:text-foreground"
      >
        跳到主要内容
      </a>

      <aside className="hidden border-r border-border bg-surface lg:block">
        <SidebarNav />
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-border bg-surface px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="打开导航" className="lg:hidden">
                  <Menu aria-hidden="true" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" aria-label="导航" className="w-72 p-0">
                <SheetTitle className="sr-only">导航</SheetTitle>
                <SidebarNav onNavigate={() => setMobileOpen(false)} />
              </SheetContent>
            </Sheet>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Agnes 图片代理</p>
              <h1 className="truncate text-lg font-semibold">{pageTitle(location.pathname)}</h1>
            </div>
          </div>
          <ThemeControl />
        </header>

        <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 p-4 sm:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
