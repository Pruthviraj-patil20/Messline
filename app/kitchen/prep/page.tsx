import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { BookingStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  calculatePrepReport,
  getPrepAccess,
  getUnbookedStockLabel,
  isPastServiceDate,
  isTodayOrPastServiceDate,
  resolvePrepService,
} from "@/lib/prep";
import { getCurrentUser } from "@/lib/auth";
import PrintButton from "./PrintButton";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Prep Sheet | Messline",
};

function mealLabel(meal: string) {
  return meal.charAt(0) + meal.slice(1).toLowerCase();
}

function serviceDateLabel(date: Date) {
  return date.toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function cutoffLabel(date: Date) {
  return date.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function currencyLabel(amount: number) {
  return `₹${amount.toLocaleString("en-IN")}`;
}

const serviceInclude = {
  offerings: {
    include: {
      menuItem: {
        select: { name: true, included: true, priceRupees: true },
      },
      bookings: {
        where: {
          status: {
            in: [
              BookingStatus.BOOKED,
              BookingStatus.SERVED,
              BookingStatus.NO_SHOW,
              BookingStatus.CANCELLED,
            ],
          },
        },
        select: { count: true, status: true },
      },
    },
    orderBy: { menuItem: { name: "asc" as const } },
  },
};

export default async function KitchenPrepPage({
  searchParams,
}: {
  searchParams: { serviceId?: string };
}) {
  const access = getPrepAccess(await getCurrentUser());
  if (!access.allowed) redirect(access.redirectTo);

  const services = await prisma.service.findMany({
    include: serviceInclude,
    orderBy: [{ serviceDate: "asc" }, { meal: "asc" }],
  });
  const now = new Date();
  const selection = resolvePrepService(
    services,
    searchParams.serviceId,
    now,
  );
  const selectedService = selection.service;
  const report = selectedService
    ? calculatePrepReport(selectedService, now)
    : null;
  const isHistorical = selectedService
    ? isPastServiceDate(selectedService.serviceDate, now)
    : false;
  const isReconciliationEligible = selectedService
    ? isTodayOrPastServiceDate(selectedService.serviceDate, now)
    : false;
  const totalCapacity =
    report?.offerings.reduce((total, offering) => total + offering.quantityTotal, 0) ??
    0;
  const totalRestocked =
    report?.offerings.reduce(
      (total, offering) => total + offering.restockedCount,
      0,
    ) ?? 0;
  const totalUnbooked = report?.offerings.reduce(
    (total, offering) => total + offering.unbookedCount,
    0,
  ) ?? 0;
  const totalRevenue = report?.offerings.reduce(
    (total, offering) => total + (offering.expectedRevenue ?? 0),
    0,
  ) ?? 0;
  const hasUnpricedExtra =
    report?.offerings.some(
      (offering) => !offering.included && offering.expectedRevenue === null,
    ) ?? false;

  return (
    <main className="prep-page mx-auto max-w-6xl px-6 py-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium uppercase tracking-wide text-neutral-500">
            Kitchen operations
          </p>
          <h1 className="mt-1 text-3xl font-semibold">Daily Prep Sheet</h1>
          {selectedService ? (
            <p className="mt-2 text-base text-neutral-700">
              {mealLabel(selectedService.meal)} ·{" "}
              {serviceDateLabel(selectedService.serviceDate)}
            </p>
          ) : null}
        </div>
        <nav className="prep-controls print-hidden flex items-center gap-4 text-sm">
          <Link href="/kitchen" className="underline">
            Kitchen
          </Link>
          <Link href="/kitchen/bookings" className="underline">
            Bookings
          </Link>
          <Link href="/" className="underline">
            Home
          </Link>
          <PrintButton />
        </nav>
      </header>

      <section className="prep-controls print-hidden mt-6 flex flex-wrap items-end justify-between gap-4 rounded-lg border border-neutral-200 p-4">
        <form action="/kitchen/prep" method="get" className="flex flex-wrap items-end gap-3">
          <label className="block text-sm font-medium">
            Select service
            <select
              name="serviceId"
              defaultValue={selectedService?.id ?? ""}
              className="mt-1 block min-w-64 rounded border border-neutral-300 bg-white px-3 py-2 text-base"
              disabled={services.length === 0}
            >
              {services.length === 0 ? (
                <option value="">No services available</option>
              ) : null}
              {services.map((service) => (
                <option key={service.id} value={service.id}>
                  {serviceDateLabel(service.serviceDate)} ·{" "}
                  {mealLabel(service.meal)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={services.length === 0}
            className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            View sheet
          </button>
        </form>
        {selectedService ? (
          <p className="text-sm text-neutral-700">
            Cutoff: <strong>{cutoffLabel(selectedService.cutoffAt)} IST</strong>
          </p>
        ) : null}
      </section>

      {selection.invalidSelection ? (
        <p role="alert" className="mt-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          That service selection is invalid or unavailable. Showing the default
          service instead.
        </p>
      ) : null}

      {!report || !selectedService ? (
        <section className="mt-8 rounded-lg border border-dashed border-neutral-300 p-8 text-center">
          <h2 className="text-xl font-semibold">No services available</h2>
          <p className="mt-2 text-neutral-600">
            Create a service from the Kitchen page to build a prep sheet.
          </p>
        </section>
      ) : (
        <>
          <section
            aria-label="Cutoff status"
            className={`mt-6 rounded-lg border p-4 ${
              report.isCutoffPassed
                ? "border-green-300 bg-green-50 text-green-950"
                : "border-amber-300 bg-amber-50 text-amber-950"
            }`}
          >
            <div className="flex flex-wrap items-center gap-3">
              <span
                className={`rounded-full border px-3 py-1 text-sm font-bold ${
                  report.isCutoffPassed
                    ? "border-green-400 bg-white text-green-800"
                    : "border-amber-400 bg-white text-amber-900"
                }`}
              >
                {report.isCutoffPassed ? "Cook Count Locked" : "Booking Active"}
              </span>
              <p className="font-medium">
                Cutoff: {cutoffLabel(selectedService.cutoffAt)} IST
              </p>
            </div>
            <p className="mt-2 text-sm">
              {report.isCutoffPassed
                ? "The cutoff has passed. These cook counts are final."
                : "Counts are provisional. Students can still book or cancel, so the final cook count may change."}
            </p>
          </section>

          <section className="mt-8">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-2xl font-semibold">Planned preparation</h2>
                <p className="mt-1 text-sm text-neutral-600">
                  Unbooked stock is the current stock balance
                  {report.isCutoffPassed ? " at cutoff." : " and may change before cutoff."}
                </p>
              </div>
              <p className="text-sm text-neutral-600">
                Cutoff time shown in India Standard Time
              </p>
            </div>

            {report.offerings.length === 0 ? (
              <p className="mt-4 rounded border border-neutral-200 p-4 text-neutral-700">
                No dishes are planned for this service.
              </p>
            ) : (
              <div className="mt-4 overflow-x-auto rounded-lg border border-neutral-300">
                <table className="prep-table w-full min-w-[820px] border-collapse text-left">
                  <thead>
                    <tr className="border-b-2 border-neutral-400 bg-neutral-100 text-sm">
                      <th scope="col" className="p-3">Dish</th>
                      <th scope="col" className="p-3">Planned Capacity</th>
                      <th scope="col" className="p-3">Final Cook Count</th>
                      <th scope="col" className="p-3">Unresolved Booked</th>
                      <th scope="col" className="p-3">Plates Restocked</th>
                      <th scope="col" className="p-3">
                        {getUnbookedStockLabel(report.isCutoffPassed)}
                      </th>
                      <th scope="col" className="p-3">Expected Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.offerings.map((offering) => (
                      <tr
                        key={offering.offeringId}
                        className="border-b border-neutral-300 last:border-b-0"
                      >
                        <th scope="row" className="p-3 align-middle font-semibold">
                          <span className="block text-lg">{offering.menuItemName}</span>
                          <span
                            className={`mt-1 inline-block rounded border px-2 py-0.5 text-xs font-medium ${
                              offering.included
                                ? "border-neutral-400 text-neutral-700"
                                : "border-blue-300 text-blue-900"
                            }`}
                          >
                            {offering.included ? "Included" : "Extra"}
                          </span>
                        </th>
                        <td className="p-3 text-lg tabular-nums">
                          {offering.quantityTotal}
                        </td>
                        <td className="p-3">
                          <span className="block text-4xl font-bold leading-none tabular-nums">
                            {offering.finalCookCount}
                          </span>
                          <span className="mt-1 block text-xs text-neutral-600">
                            plates to cook
                          </span>
                        </td>
                        <td className="p-3 text-lg tabular-nums">
                          {offering.bookedCount}
                        </td>
                        <td className="p-3 text-lg tabular-nums">
                          {offering.restockedCount}
                        </td>
                        <td className="p-3 text-lg tabular-nums">
                          {offering.unbookedCount}
                        </td>
                        <td className="p-3 text-base tabular-nums">
                          {offering.included
                            ? "—"
                            : offering.expectedRevenue === null
                              ? "Price not set"
                              : currencyLabel(offering.expectedRevenue)}
                        </td>
                      </tr>
                    ))}
                    <tr className="border-t-2 border-neutral-500 bg-neutral-50 font-semibold">
                      <th scope="row" className="p-3">Total</th>
                      <td className="p-3 tabular-nums">{totalCapacity}</td>
                      <td className="p-3 text-2xl tabular-nums">
                        {report.totalPlatesCooked}
                      </td>
                      <td className="p-3 tabular-nums">
                        {report.unresolvedBookedCount}
                      </td>
                      <td className="p-3 tabular-nums">{totalRestocked}</td>
                      <td className="p-3 tabular-nums">{totalUnbooked}</td>
                      <td className="p-3 tabular-nums">
                        {hasUnpricedExtra
                          ? `Known: ${currencyLabel(totalRevenue)}`
                          : currencyLabel(totalRevenue)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {isReconciliationEligible ? (
            <section className="mt-10 border-t border-neutral-300 pt-6">
              <h2 className="text-2xl font-semibold">Wastage Reconciliation</h2>
              {report.reconciliationStatus === "PENDING" ? (
                <div className="mt-3 rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
                  <p className="font-semibold">Pending reconciliation</p>
                  <p className="mt-1">
                    {report.unresolvedBookedCount > 0
                      ? `${report.unresolvedBookedCount} booked plate(s) still need to be marked served or no-show.`
                      : isHistorical
                        ? "Completion cannot be confirmed yet."
                        : "Today’s meal is not confirmed complete yet."}
                  </p>
                </div>
              ) : null}
              {report.reconciliationStatus === "COMPLETED" ? (
                <p className="mt-1 text-sm text-neutral-600">
                  Reconciliation complete: all bookings have a terminal status.
                </p>
              ) : null}
              {report.reconciliationStatus === "COMPLETED" ? (
                <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-lg border border-neutral-300 p-4">
                  <p className="text-sm text-neutral-600">Plates Cooked</p>
                  <p className="mt-1 text-3xl font-bold tabular-nums">
                    {report.totalPlatesCooked}
                  </p>
                </div>
                <div className="rounded-lg border border-neutral-300 p-4">
                  <p className="text-sm text-neutral-600">Plates Consumed</p>
                  <p className="mt-1 text-3xl font-bold tabular-nums">
                    {report.totalPlatesServed}
                  </p>
                </div>
                <div className="rounded-lg border border-neutral-300 p-4">
                  <p className="text-sm text-neutral-600">Plates Wasted</p>
                  <p className="mt-1 text-3xl font-bold tabular-nums">
                    {report.totalPlatesWasted}
                  </p>
                  <p className="text-xs text-neutral-600">
                    No-show + post-cutoff cancellations
                  </p>
                </div>
                <div className="rounded-lg border border-neutral-300 p-4">
                  <p className="text-sm text-neutral-600">Wastage Rate</p>
                  <p className="mt-1 text-3xl font-bold tabular-nums">
                    {report.wastageRatePercent.toFixed(1)}%
                  </p>
                </div>
                </div>
              ) : null}
              <p className="mt-3 text-xs text-neutral-600">
                Today’s reconciliation requires cutoff passage and at least one
                booking with every booking in a terminal status. Past services
                also require no unresolved bookings. The service model has no
                separate completion timestamp.
              </p>
            </section>
          ) : null}
        </>
      )}
    </main>
  );
}
