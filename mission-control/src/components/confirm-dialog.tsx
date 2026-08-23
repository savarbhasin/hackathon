"use client";

import { useEffect } from "react";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Delete",
  busy = false,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [busy, onCancel, open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
      role="presentation"
    >
      <section
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-description"
        className="w-full max-w-sm rounded-xl border border-line-strong bg-panel p-5 shadow-2xl"
      >
        <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-state-blocked">Confirm deletion</p>
        <h2 id="confirm-dialog-title" className="mt-2 text-lg font-semibold tracking-[-0.025em] text-ink">{title}</h2>
        <p id="confirm-dialog-description" className="mt-2 text-sm leading-6 text-ink-soft">{description}</p>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={busy} className="rounded-md border border-line-strong px-3 py-2 text-xs font-semibold text-ink-soft transition-colors hover:border-ink-faint hover:text-ink disabled:opacity-40">
            Cancel
          </button>
          <button type="button" onClick={onConfirm} disabled={busy} className="rounded-md bg-state-blocked px-3 py-2 text-xs font-semibold text-deck transition-colors hover:brightness-110 disabled:opacity-40">
            {busy ? "Deleting..." : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
