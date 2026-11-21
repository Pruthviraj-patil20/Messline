"use client";

import { useId, useMemo, useState, useTransition, useRef } from "react";
import { BookingStatus } from "@prisma/client";
import {
  markServedAction,
  markNoShowAction,
  reconcileServiceAction,
} from "@/app/actions";

const STATUS_LABELS: Record<string, string> = {
  BOOKED: "Booked",
  CANCELLED: "Cancelled",
  SERVED: "Served",
  NO_SHOW: "No-show",
};

function getStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export type BookingRowData = {
  id: string;
  count: number;
  status: BookingStatus;
  userName: string;
  userEmail: string;
  dishName: string;
  token: string;
};

export type ServiceGroupData = {
  id: string;
  meal: string;
  serviceDateStr: string; // ISO string
  tabLabel: string;
  cutoffAtStr: string; // ISO string
  isToday: boolean;
  isCutoffPassed: boolean;
  canMarkAttendance: boolean; // serviceDate <= today
  bookings: BookingRowData[];
};

export function KitchenCounterVerification({
  services: initialServices,
  defaultServiceId,
}: {
  services: ServiceGroupData[];
  defaultServiceId: string;
}) {
  const [servicesData, setServicesData] = useState<ServiceGroupData[]>(initialServices);
  const [selectedServiceId, setSelectedServiceId] = useState<string>(
    () => defaultServiceId || (initialServices[0]?.id ?? "")
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  // Modal dialog state for End Service confirmation
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);

  const [isPending, startTransition] = useTransition();
  const [pendingAction, setPendingAction] = useState<{
    id: string;
    type: "SERVED" | "NO_SHOW";
  } | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchInputId = useId();

  const selectedService = useMemo(() => {
    return (
      servicesData.find((s) => s.id === selectedServiceId) ??
      servicesData[0] ??
      null
    );
  }, [servicesData, selectedServiceId]);

  // Headcount must be calculated from the full set of bookings in the selected service,
  // NOT filtered by the search query.
  const headcount = useMemo(() => {
    if (!selectedService) {
      return { expected: 0, served: 0, remaining: 0, noShow: 0 };
    }
    let served = 0;
    let remaining = 0;
    let noShow = 0;

    for (const b of selectedService.bookings) {
      if (b.status === BookingStatus.SERVED) {
        served++;
      } else if (b.status === BookingStatus.BOOKED) {
        remaining++;
      } else if (b.status === BookingStatus.NO_SHOW) {
        noShow++;
      }
    }

    // Expected Total: all non-cancelled bookings in the selected service
    const expected = served + remaining + noShow;

    return { expected, served, remaining, noShow };
  }, [selectedService]);

  // Real-time search filters student name, student email, and 6-char verification token.
  // Case-insensitive, trims whitespace, partial match.
  const filteredBookings = useMemo(() => {
    if (!selectedService) return [];
    const query = searchQuery.trim().toLowerCase();
    if (!query) return selectedService.bookings;

    return selectedService.bookings.filter((b) => {
      const matchName = b.userName.toLowerCase().includes(query);
      const matchEmail = b.userEmail.toLowerCase().includes(query);
      const matchToken = b.token.toLowerCase().includes(query);
      return matchName || matchEmail || matchToken;
    });
  }, [selectedService, searchQuery]);

  // Individual mark served action handler with safe state update
  const handleMarkServed = (bookingId: string) => {
    setActionError(null);
    setActionSuccess(null);
    setPendingAction({ id: bookingId, type: "SERVED" });

    startTransition(async () => {
      try {
        const result = await markServedAction(bookingId);
        if (!result.ok) {
          setActionError(result.error);
        } else {
          // Immediately update local row status to SERVED without full page reload
          setServicesData((prev) =>
            prev.map((s) => {
              if (s.id !== selectedService?.id) return s;
              return {
                ...s,
                bookings: s.bookings.map((b) =>
                  b.id === bookingId ? { ...b, status: BookingStatus.SERVED } : b
                ),
              };
            })
          );
          setActionSuccess("Booking marked as served.");
        }
      } catch {
        setActionError("An unexpected error occurred. Please try again.");
      } finally {
        setPendingAction(null);
        // Retain search input focus so kitchen staff can immediately scan/search next student
        searchInputRef.current?.focus();
      }
    });
  };

  // Individual mark no-show action handler
  const handleMarkNoShow = (bookingId: string) => {
    setActionError(null);
    setActionSuccess(null);
    setPendingAction({ id: bookingId, type: "NO_SHOW" });

    startTransition(async () => {
      try {
        const result = await markNoShowAction(bookingId);
        if (!result.ok) {
          setActionError(result.error);
        } else {
          // Immediately update local row status to NO_SHOW without full page reload
          setServicesData((prev) =>
            prev.map((s) => {
              if (s.id !== selectedService?.id) return s;
              return {
                ...s,
                bookings: s.bookings.map((b) =>
                  b.id === bookingId ? { ...b, status: BookingStatus.NO_SHOW } : b
                ),
              };
            })
          );
          setActionSuccess("Booking marked as no-show.");
        }
      } catch {
        setActionError("An unexpected error occurred. Please try again.");
      } finally {
        setPendingAction(null);
        searchInputRef.current?.focus();
      }
    });
  };

  // Bulk reconciliation handler: End Service / Mark Remaining as No-Show
  const handleBulkReconcile = () => {
    if (!selectedService) return;
    setIsConfirmOpen(false);
    setActionError(null);
    setActionSuccess(null);

    startTransition(async () => {
      try {
        const result = await reconcileServiceAction(selectedService.id);
        if (!result.ok) {
          setActionError(result.error);
        } else {
          // Immediately transition all BOOKED rows for the selected service to NO_SHOW in client state
          setServicesData((prev) =>
            prev.map((s) => {
              if (s.id !== selectedService.id) return s;
              return {
                ...s,
                bookings: s.bookings.map((b) =>
                  b.status === BookingStatus.BOOKED
                    ? { ...b, status: BookingStatus.NO_SHOW }
                    : b
                ),
              };
            })
          );
          setActionSuccess(
            `Service ended. Reconciled ${result.count} unserved booking${
              result.count === 1 ? "" : "s"
            } as NO_SHOW.`
          );
        }
      } catch {
        setActionError("An unexpected error occurred. Please try again.");
      } finally {
        searchInputRef.current?.focus();
      }
    });
  };

  if (servicesData.length === 0) {
    return <p className="mt-6 text-sm text-neutral-600">No services available.</p>;
  }

  return (
    <div className="mt-6 space-y-6">
      {/* Service-oriented tabs */}
      <div
        role="tablist"
        aria-label="Meal Services"
        className="flex flex-wrap gap-2 border-b border-neutral-200 pb-3"
      >
        {servicesData.map((service) => {
          const isSelected = service.id === selectedService?.id;
          return (
            <button
              key={service.id}
              role="tab"
              aria-selected={isSelected}
              aria-controls={`panel-${service.id}`}
              id={`tab-${service.id}`}
              onClick={() => {
                setSelectedServiceId(service.id);
                setActionError(null);
                setActionSuccess(null);
              }}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                isSelected
                  ? "bg-neutral-900 text-white"
                  : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200"
              }`}
            >
              {service.tabLabel}
            </button>
          );
        })}
      </div>

      {actionError && (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800"
        >
          {actionError}
        </div>
      )}

      {actionSuccess && (
        <div
          role="status"
          className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800"
        >
          {actionSuccess}
        </div>
      )}

      {selectedService && (
        <section
          id={`panel-${selectedService.id}`}
          role="tabpanel"
          aria-labelledby={`tab-${selectedService.id}`}
          className="space-y-6"
        >
          {/* Live Headcount Banner */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-lg border border-neutral-200 bg-white p-3 shadow-sm">
              <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
                Expected Total
              </span>
              <p
                data-testid="headcount-expected"
                className="mt-1 text-2xl font-semibold text-neutral-900"
              >
                {headcount.expected}
              </p>
            </div>
            <div className="rounded-lg border border-neutral-200 bg-white p-3 shadow-sm">
              <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
                Served
              </span>
              <p
                data-testid="headcount-served"
                className="mt-1 text-2xl font-semibold text-emerald-600"
              >
                {headcount.served}
              </p>
            </div>
            <div className="rounded-lg border border-neutral-200 bg-white p-3 shadow-sm">
              <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
                Remaining in Line
              </span>
              <p
                data-testid="headcount-remaining"
                className="mt-1 text-2xl font-semibold text-amber-600"
              >
                {headcount.remaining}
              </p>
            </div>
            <div className="rounded-lg border border-neutral-200 bg-white p-3 shadow-sm">
              <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
                No-Shows
              </span>
              <p
                data-testid="headcount-noshow"
                className="mt-1 text-2xl font-semibold text-neutral-600"
              >
                {headcount.noShow}
              </p>
            </div>
          </div>

          {/* End Service Header Bar (Reconciliation Button) */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3">
            <div>
              <span className="text-sm font-medium text-neutral-900">
                Service Reconciliation
              </span>
              <p className="text-xs text-neutral-500">
                {selectedService.isCutoffPassed
                  ? "Cutoff passed. You may close the service and mark all unserved bookings as NO_SHOW."
                  : "Cutoff is in the future. Service remains open for student collection."}
              </p>
            </div>
            <div>
              {selectedService.isCutoffPassed && (
                <button
                  type="button"
                  disabled={isPending || headcount.remaining === 0}
                  onClick={() => setIsConfirmOpen(true)}
                  className="rounded-md border border-neutral-900 bg-neutral-900 px-3.5 py-1.5 text-xs font-medium text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:border-neutral-300 disabled:bg-neutral-200 disabled:text-neutral-500"
                >
                  {isPending
                    ? "Reconciling..."
                    : "End Service / Mark Remaining as No-Show"}
                </button>
              )}
            </div>
          </div>

          {/* Real-time search */}
          <div>
            <label
              htmlFor={searchInputId}
              className="block text-xs font-medium uppercase tracking-wider text-neutral-600"
            >
              Search Booking
            </label>
            <div className="mt-1.5 flex gap-2">
              <input
                ref={searchInputRef}
                id={searchInputId}
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by student name, email, or 6-char pass..."
                className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm placeholder:text-neutral-400 focus:border-neutral-900 focus:outline-none focus:ring-1 focus:ring-neutral-900"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  className="rounded-md border border-neutral-300 px-3 py-2 text-xs text-neutral-600 hover:bg-neutral-100"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* Bookings List */}
          <div className="mt-4">
            {selectedService.bookings.length === 0 ? (
              <p className="py-6 text-center text-sm text-neutral-500">
                No bookings for this service.
              </p>
            ) : filteredBookings.length === 0 ? (
              <p className="py-6 text-center text-sm text-neutral-500">
                No bookings found matching &ldquo;{searchQuery.trim()}&rdquo;.
              </p>
            ) : (
              <ul className="divide-y divide-neutral-200 border-y border-neutral-200 text-sm">
                {filteredBookings.map((row) => {
                  const isBooked = row.status === BookingStatus.BOOKED;
                  const isServed = row.status === BookingStatus.SERVED;
                  const isNoShow = row.status === BookingStatus.NO_SHOW;
                  const isServingThis =
                    isPending &&
                    pendingAction?.id === row.id &&
                    pendingAction?.type === "SERVED";
                  const isNoShowThis =
                    isPending &&
                    pendingAction?.id === row.id &&
                    pendingAction?.type === "NO_SHOW";

                  return (
                    <li
                      key={row.id}
                      className="flex flex-wrap items-center justify-between gap-3 py-3"
                    >
                      <div className="space-y-0.5">
                        <div className="font-medium text-neutral-900">
                          {row.userName}{" "}
                          <span className="text-xs font-normal text-neutral-500">
                            ({row.userEmail})
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
                          <span>
                            {row.dishName} &times; {row.count} plate{row.count > 1 ? "s" : ""}
                          </span>
                          <span>&bull;</span>
                          <span className="font-mono font-medium text-neutral-800">
                            Pass: #{row.token}
                          </span>
                          <span>&bull;</span>
                          <span
                            className={`inline-flex items-center rounded px-1.5 py-0.5 font-medium ${
                              isServed
                                ? "bg-emerald-50 text-emerald-700"
                                : isBooked
                                ? "bg-amber-50 text-amber-700"
                                : isNoShow
                                ? "bg-neutral-100 text-neutral-700"
                                : "bg-neutral-50 text-neutral-500"
                            }`}
                          >
                            {getStatusLabel(row.status)}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        {isBooked ? (
                          selectedService.canMarkAttendance ? (
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                disabled={isPending}
                                onClick={() => handleMarkServed(row.id)}
                                className="rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:ring-offset-1 disabled:opacity-50"
                              >
                                {isServingThis ? "Serving..." : "Served"}
                              </button>
                              <button
                                type="button"
                                disabled={isPending}
                                onClick={() => handleMarkNoShow(row.id)}
                                className="rounded border border-red-200 px-3 py-1.5 text-xs font-medium text-red-700 transition hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-400 focus:ring-offset-1 disabled:opacity-50"
                              >
                                {isNoShowThis ? "Saving..." : "No-show"}
                              </button>
                            </div>
                          ) : (
                            <span className="text-xs italic text-neutral-400">
                              Future service
                            </span>
                          )
                        ) : (
                          <span className="text-xs font-medium text-neutral-400">
                            {isServed
                              ? "✓ Served"
                              : isNoShow
                              ? "Marked No-Show"
                              : getStatusLabel(row.status)}
                          </span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>
      )}

      {/* Accessible Confirmation Dialog */}
      {isConfirmOpen && selectedService && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-dialog-title"
          aria-describedby="confirm-dialog-desc"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="w-full max-w-md rounded-lg border border-neutral-200 bg-white p-6 shadow-xl">
            <h2
              id="confirm-dialog-title"
              className="text-lg font-semibold text-neutral-900"
            >
              End {selectedService.tabLabel} Service?
            </h2>
            <p
              id="confirm-dialog-desc"
              className="mt-2 text-sm text-neutral-600"
            >
              This will mark the remaining{" "}
              <span className="font-semibold text-neutral-900">
                {headcount.remaining}
              </span>{" "}
              unserved booking{headcount.remaining === 1 ? "" : "s"} as NO_SHOW.
              This action cannot be undone.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                disabled={isPending}
                onClick={() => setIsConfirmOpen(false)}
                className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100 focus:outline-none focus:ring-2 focus:ring-neutral-400"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isPending}
                onClick={handleBulkReconcile}
                className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-neutral-900 disabled:opacity-50"
              >
                {isPending ? "Ending Service..." : "Confirm and End Service"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
