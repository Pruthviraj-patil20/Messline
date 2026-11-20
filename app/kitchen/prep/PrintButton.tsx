"use client";

export default function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="rounded border border-neutral-400 px-3 py-1.5 font-medium hover:bg-neutral-100"
    >
      Print sheet
    </button>
  );
}
