import type { EditorState } from "@codemirror/state";

export type EncodingId = "utf8" | "utf8bom" | "latin1" | "euckr";
export type EolId = "lf" | "crlf";
/** Every file type id. The type is derived from this list, so it doubles as the
 *  session-restore whitelist without the two being able to drift apart. */
export const FILE_TYPE_IDS = [
  "normal",
  "markdown",
  "mermaid",
  "json",
  "sql",
  "java",
  "python",
  "shell",
  "html",
  "css",
  "javascript",
  "typescript",
  "xml",
  "yaml",
  "cpp",
  "rust",
  "go",
] as const;

export type FileTypeId = (typeof FILE_TYPE_IDS)[number];

/** Live, in-memory model of an open tab. */
export interface Tab {
  id: string;
  path: string | null; // null => untitled
  title: string;
  dirty: boolean;
  encoding: EncodingId;
  eol: EolId;
  /** Explicit pick from the status-bar picker; null => detect from the path. */
  fileType: FileTypeId | null;
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
