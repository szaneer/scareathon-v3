import { createContext, useEffect, useRef, useState, type ReactNode } from "react";
import { PAPER_GRAIN, pixel, sans, typewriter } from "./style/theme.ts";

// The top bar of a sheet, left of its ×, for a body's own buttons (the shop's search):
// render into it with a portal
export const SheetActions = createContext<HTMLElement | null>(null);

// Something taken up to look at closely: a paper off the board, a flyer off the table,
// the departure board or the kiosk's window up close, a catalogue slid across the counter.
// On phones it slides up from the bottom and fills most of the screen; on wider screens
// it's held up in the middle. Tap outside, ×, or Esc to put it back.

export type SheetContent = {
  id: string;
  title: string; // for screen readers
  body: ReactNode;
  // paper: cream, pinned. ledger: navy, wide, for the kiosk's catalogue.
  // board: the departure board's own black face, edge to edge.
  tone?: "paper" | "ledger" | "board";
  // Takes the whole screen (the wardrobe: the clothes and you in them, side by side); its
  // body does its own scrolling
  full?: boolean;
  tint?: string;
};

// above: over a game being played (the scoreboard, from the game's bar).
// The scoreboard hangs overhead, so it drops down from the top rather than coming up.
export default function Sheet({ sheet, onClose, above = false, closeLabel = "Put it back" }: { sheet: SheetContent | null; onClose: () => void; above?: boolean; closeLabel?: string }) {
  // The tap that picked something up is followed by its own click, which would land on
  // the backdrop that just appeared under the finger; ignore the backdrop briefly
  const openedAt = useRef(0);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [actions, setActions] = useState<HTMLDivElement | null>(null);
  const isOpen = Boolean(sheet);
  useEffect(() => {
    if (isOpen) openedAt.current = performance.now();
  }, [isOpen]);
  const closeFromBackdrop = () => performance.now() - openedAt.current > 400 && onClose();

  const sheetId = sheet?.id;
  useEffect(() => {
    if (!sheetId) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const controls = () => [...(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? [])].filter(node => node.getClientRects().length > 0);
    const frame = requestAnimationFrame(() => (controls()[0] || dialog)?.focus());
    const onKey = (event: KeyboardEvent) => {
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (dialogs[dialogs.length - 1] !== dialog) return;
      if (event.key === "Escape") {
        event.stopImmediatePropagation();
        onCloseRef.current();
      } else if (event.key === "Tab") {
        const list = controls();
        const first = list[0], last = list[list.length - 1];
        if (!first) { event.preventDefault(); dialog?.focus(); }
        else if (!dialog?.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
        else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKey, true);
      if (previous?.isConnected) previous.focus();
    };
    // Changing the contents does not reset focus; each paper has a stable id.
  }, [sheetId]);
  if (!sheet) return null;
  const tone = sheet.tone ?? "paper";
  const full = Boolean(sheet.full);

  const toneClass = {
    paper: "md:max-w-lg p-6 pt-9 md:p-7 md:pt-9",
    ledger: "md:max-w-4xl bg-[#0d131b] p-5 pt-12 text-stone-200 ring-2 ring-inset ring-[#f2ead2]/40 md:p-8 md:pt-12",
    board: "md:max-w-3xl bg-[#0a0c10] ring-2 ring-inset ring-[#ffb03a]/25",
  }[tone];
  const light = tone === "paper";

  return (
    <div
      className={`fixed inset-0 ${above ? "z-50" : "z-30"} flex items-end justify-center bg-black/60 backdrop-blur-[2px] md:items-center ${full ? "" : "md:p-6"}`}
      onClick={closeFromBackdrop}
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal
      aria-label={sheet.title}
    >
      <div
        className={`station-sheet ${tone === "board" ? "station-sheet-down" : ""} relative flex w-full flex-col ${
          full
            ? "h-[100dvh] overflow-hidden"
            : "max-h-[90dvh] overflow-y-auto overscroll-contain rounded-t-2xl shadow-[0_-8px_30px_rgba(0,0,0,0.5)] md:max-h-[88vh] md:rounded-[3px] md:shadow-[6px_10px_0_rgba(0,0,0,0.5)]"
        } ${full ? toneClass.replace(/md:max-w-\S+/, "") : toneClass} ${
          // Full screen, the departure board keeps its dark steel case, as on the wall
          full && tone === "board" ? "border-[12px] border-[#15181f] shadow-[inset_0_0_0_2px_#000] md:border-[22px]" : ""
        }`}
        style={{
          backgroundColor: light ? sheet.tint ?? "#f2ead2" : undefined,
          backgroundImage: light ? PAPER_GRAIN : undefined,
          ...(light ? typewriter : sans),
          paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))",
        }}
        onClick={(event) => event.stopPropagation()}
      >
        {/* A grab handle on phones; a pin on paper on wider screens */}
        <span className={`absolute left-1/2 top-2.5 h-1.5 w-12 -translate-x-1/2 rounded-full md:hidden ${full ? "hidden" : ""} ${light ? "bg-[#2a1d14]/25" : "bg-[#f2ead2]/30"}`} aria-hidden />
        {light && <span className="absolute left-1/2 top-2.5 hidden h-3 w-3 -translate-x-1/2 rounded-full bg-red-800 shadow md:block" aria-hidden />}
        <button
          type="button"
          onClick={onClose}
          aria-label={closeLabel}
          style={pixel}
          className={`absolute right-2 top-1 z-10 flex h-11 w-11 items-center justify-center text-3xl leading-none ${light ? "text-[#2a1d14]/85 hover:text-[#2a1d14]" : "text-[#f2ead2]/85 hover:text-[#f2ead2]"}`}
        >
          ×
        </button>
        {/* (empty, it lets taps through to what's under it) */}
        <div ref={setActions} className="pointer-events-none absolute left-5 right-14 top-1 z-10 flex h-11 items-center justify-end md:left-8 [&>*]:pointer-events-auto" />
        <SheetActions.Provider value={actions}>
          {full ? <div className="min-h-0 flex-1">{sheet.body}</div> : tone === "board" ? <div className="h-[70dvh] md:h-[60vh]">{sheet.body}</div> : sheet.body}
        </SheetActions.Provider>
      </div>
    </div>
  );
}
