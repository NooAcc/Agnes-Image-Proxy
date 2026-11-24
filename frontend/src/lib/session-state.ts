import { createContext, useContext } from "react";

export const SessionStateContext = createContext({ expired: false, reset: () => {} });
export function useSessionState() { return useContext(SessionStateContext); }
