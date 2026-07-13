import type { EditorState } from "@codemirror/state";

export type EncodingId = "utf8" | "utf8bom" | "latin1";
export type EolId = "lf" | "crlf";

/** Live, in-memory model of an open tab. */
export interface Tab {
  id: string;
  path: string | null; // null => untitled
  title: string;
  dirty: boolean;
  encoding: EncodingId;
  eol: EolId;
  diskMtimeMs: number | null;
  missingOnDisk: boolean;
  /** CodeMirror state: holds doc, selection, and undo history. */
  state: EditorState;
  /** Scroll position (not part of EditorState — captured on switch/flush). */
  scrollTop: number;
  /** Non-blocking notice to show in this tab (conflict/deletion). */
  notice: TabNotice | null;
}

export interface TabNotice {
  kind: "conflict" | "deleted";
  message: string;
}

export interface AppState {
  tabs: Tab[];
  activeTabId: string | null;
  nextUntitled: number;
}

type Listener = () => void;

class Store {
  state: AppState = { tabs: [], activeTabId: null, nextUntitled: 1 };
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(): void {
    for (const fn of this.listeners) fn();
  }

  get activeTab(): Tab | null {
    const { tabs, activeTabId } = this.state;
    return tabs.find((t) => t.id === activeTabId) ?? null;
  }

  tabById(id: string): Tab | null {
    return this.state.tabs.find((t) => t.id === id) ?? null;
  }
}

export const store = new Store();

/** UUID for a new tab (crypto.randomUUID is available in all target WebViews). */
export function newId(): string {
  return crypto.randomUUID();
}
