import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Less motion: the system asks for it (macOS/Windows/iOS accessibility), or
 * Settings → Appearance → Accessibility → Reduce motion is on (look.ts puts
 * data-motion="reduce" on <html> and fires "brewlm:motion" when it changes).
 */
export function reducedMotion(): boolean {
  return document.documentElement.dataset.motion === "reduce" || (window.matchMedia?.(QUERY).matches ?? false);
}

export function useReducedMotion(): boolean {
  const [reduce, setReduce] = useState(reducedMotion);
  useEffect(() => {
    const on = () => setReduce(reducedMotion());
    const mq = window.matchMedia?.(QUERY);
    mq?.addEventListener("change", on);
    window.addEventListener("brewlm:motion", on);
    return () => {
      mq?.removeEventListener("change", on);
      window.removeEventListener("brewlm:motion", on);
    };
  }, []);
  return reduce;
}
