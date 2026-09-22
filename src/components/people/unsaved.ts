"use client";

import { createContext, useContext, useEffect } from "react";

/**
 * Words typed in the person drawer and not yet saved (P5c): an edited email,
 * a note, a call note. Each field that holds some reports it here, and the
 * drawer asks before closing over them. Outside the drawer (the Inbox) nothing
 * listens and the report goes nowhere.
 */
export const UnsavedContext = createContext<(key: string, unsaved: boolean) => void>(() => {});

/** Tell the drawer whether this field holds words not yet saved; unmounting clears it. */
export function useUnsaved(key: string, unsaved: boolean): void {
  const report = useContext(UnsavedContext);
  useEffect(() => {
    report(key, unsaved);
    return () => report(key, false);
  }, [report, key, unsaved]);
}
