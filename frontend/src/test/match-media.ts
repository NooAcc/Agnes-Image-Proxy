type Listener = (event: MediaQueryListEvent) => void;

let systemDark = false;
const listeners = new Set<Listener>();

export function setSystemPrefersDark(value: boolean) {
  systemDark = value;
  const event = { matches: value, media: "(prefers-color-scheme: dark)" } as MediaQueryListEvent;
  for (const listener of listeners) {
    listener(event);
  }
}

export function installMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string): MediaQueryList => {
      const mql = {
        matches: query.includes("prefers-color-scheme: dark") ? systemDark : false,
        media: query,
        onchange: null,
        addEventListener: (type: string, cb: EventListenerOrEventListenerObject) => {
          if (type === "change") listeners.add(cb as Listener);
        },
        removeEventListener: (type: string, cb: EventListenerOrEventListenerObject) => {
          if (type === "change") listeners.delete(cb as Listener);
        },
        addListener: (cb: Listener) => listeners.add(cb),
        removeListener: (cb: Listener) => listeners.delete(cb),
        dispatchEvent: () => false,
      };
      return mql as unknown as MediaQueryList;
    },
  });
}
