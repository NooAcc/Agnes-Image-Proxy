import { act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { useOverview } from "./queries";
import { adminHandlers, createAdminState } from "@/test/handlers";
import { startServer, type MockServer } from "@/test/server";

let server: MockServer | undefined;
afterEach(() => { server?.stop(); vi.useRealTimers(); });
function View(){const query=useOverview("2026-11-20","2026-11-24");return <p>{query.data ? "ready" : "loading"}</p>}
it("polls using configured interval, pauses hidden and refreshes on return", async () => {
 const state=createAdminState();state.settings.autoRefreshIntervalMs=2000;
 server=startServer(adminHandlers(state));
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 vi.useFakeTimers();
 const view=render(<QueryClientProvider client={client}><View/></QueryClientProvider>);
 await act(async()=>{await vi.advanceTimersByTimeAsync(20)});
 expect(screen.getByText("ready")).toBeInTheDocument();
 const count=()=>server!.calls.filter(c=>c.path==="/admin/api/overview").length;
 await act(async()=>{await vi.advanceTimersByTimeAsync(2100)});
 expect(count()).toBeGreaterThan(1);
 Object.defineProperty(document,"visibilityState",{configurable:true,value:"hidden"});
 await act(async()=>{document.dispatchEvent(new Event("visibilitychange"))});
 const hiddenCount=count();
 await act(async()=>{await vi.advanceTimersByTimeAsync(5000)});
 expect(count()).toBe(hiddenCount);
 Object.defineProperty(document,"visibilityState",{configurable:true,value:"visible"});
 await act(async()=>{document.dispatchEvent(new Event("visibilitychange"));await vi.advanceTimersByTimeAsync(1)});
 expect(count()).toBeGreaterThan(hiddenCount);
 view.unmount();client.clear();
});
