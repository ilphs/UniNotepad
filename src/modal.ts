/**
 * Shared modal-dialog scaffolding: an overlay + box using the app's
 * .modal-overlay/.modal CSS, plus ARIA wiring, a focus trap, Escape/backdrop
 * cancel, and focus restoration on close.
 *
 * Deliberately dependency-free (imports no other app module) so any UI module
 * can build a dialog on top of it without risking an import cycle.
 */

export interface ModalHandle {
  overlay: HTMLElement;
  box: HTMLElement;
  close: () => void;
}

export interface ModalOptions {
  /** Accessible name for the dialog (screen readers announce it on open). */
  ariaLabel: string;
  /** Invoked on Escape or a backdrop click; the owner decides how to resolve. */
  onCancel: () => void;
}

let openCount = 0;

/** True while any modal is mounted — lets global shortcuts stand down. */
export function isModalOpen(): boolean {
  return openCount > 0;
}

/** Focusable descendants of `root`, in DOM order — drives the focus trap. */
function focusable(root: HTMLElement): HTMLElement[] {
  const sel = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
  return Array.from(root.querySelectorAll<HTMLElement>(sel)).filter(
    (el) => !el.hasAttribute("disabled"),
  );
}

/**
 * Mount an empty modal and return its box for the caller to populate. Content
 * is expected to be added synchronously on the returned handle; initial focus
 * is deferred to the next frame so it lands on the just-added primary button.
 */
export function openModal(opts: ModalOptions): ModalHandle {
  const previouslyFocused = document.activeElement as HTMLElement | null;

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const box = document.createElement("div");
  box.className = "modal";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", opts.ariaLabel);
  box.tabIndex = -1;
  overlay.appendChild(box);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) opts.onCancel();
  });

  // Capture-phase so the trap sees Tab/Escape before anything inside the box.
  // Registered here and torn down in close(); mirrors statusbar.ts's picker.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      opts.onCancel();
      return;
    }
    if (e.key !== "Tab") return;
    const items = focusable(box);
    if (items.length === 0) {
      e.preventDefault();
      box.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey) {
      if (active === first || !box.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || !box.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  };
  document.addEventListener("keydown", onKeyDown, true);

  document.body.appendChild(overlay);
  openCount++;

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    openCount--;
    document.removeEventListener("keydown", onKeyDown, true);
    overlay.remove();
    // Restore focus to whatever held it before the dialog opened, if it's still
    // in the document; otherwise leave focus where the browser puts it.
    if (previouslyFocused && document.contains(previouslyFocused)) {
      previouslyFocused.focus();
    }
  };

  // Initial focus after the caller populates the box: the primary button first,
  // else the first button, else the box itself.
  requestAnimationFrame(() => {
    if (closed) return;
    const primary = box.querySelector<HTMLElement>("button.primary");
    const firstBtn = box.querySelector<HTMLElement>("button");
    (primary ?? firstBtn ?? box).focus();
  });

  return { overlay, box, close };
}

/** Text button with a click handler — shared by the modal-based dialogs. */
export function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}
