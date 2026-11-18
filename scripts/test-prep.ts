import assert from "node:assert/strict";
import { BookingStatus, Meal, Role } from "@prisma/client";
import {
  calculatePrepReport,
  getPrepAccess,
  getUnbookedStockLabel,
  getTodayServiceDate,
  isPastServiceDate,
  isTodayOrPastServiceDate,
  resolvePrepService,
  type PrepService,
} from "../lib/prep";

const now = new Date("2026-04-04T06:00:00.000Z");
const cutoffAt = new Date("2026-04-04T10:00:00.000Z");
const serviceDate = getTodayServiceDate(now);

const service: PrepService = {
  id: "lunch",
  meal: Meal.LUNCH,
  serviceDate,
  cutoffAt,
  offerings: [
    {
      id: "extra",
      quantityTotal: 20,
      quantityLeft: 12,
      menuItem: { name: "Biryani", included: false, priceRupees: 90 },
      bookings: [
        { count: 2, status: BookingStatus.BOOKED },
        { count: 3, status: BookingStatus.SERVED },
        { count: 1, status: BookingStatus.NO_SHOW },
        { count: 2, status: BookingStatus.CANCELLED },
        { count: 4, status: BookingStatus.CANCELLED },
      ],
    },
    {
      id: "included",
      quantityTotal: 10,
      quantityLeft: 7,
      menuItem: { name: "Thali", included: true, priceRupees: null },
      bookings: [
        { count: 3, status: BookingStatus.SERVED },
      ],
    },
  ],
};

const report = calculatePrepReport(service, now);
const extra = report.offerings.find((offering) => offering.offeringId === "extra");
const included = report.offerings.find(
  (offering) => offering.offeringId === "included",
);

assert.ok(extra);
assert.equal(extra.bookedCount, 2, "sums active BOOKED plates");
assert.equal(extra.servedCount, 3, "sums SERVED plates");
assert.equal(extra.noShowCount, 1, "sums NO_SHOW plates");
assert.equal(
  extra.totalCancelledCount,
  6,
  "sums all cancelled plates",
);
assert.equal(extra.cancelledAfterCutoffCount, 2, "derives post-cutoff cancellations from stock");
assert.equal(extra.restockedCount, 4, "derives pre-cutoff cancellations from stock");
assert.equal(extra.finalCookCount, 8, "uses quantityTotal minus quantityLeft");
assert.equal(extra.unbookedCount, 12, "uses quantityLeft as unbooked stock");
assert.equal(extra.expectedRevenue, 720, "calculates revenue from the corrected cook count");
assert.ok(included);
assert.equal(included.expectedRevenue, null, "included dishes have no extra revenue");
assert.equal(report.totalPlatesCooked, 11);
assert.equal(report.totalPlatesServed, 6);
assert.equal(report.totalPlatesWasted, 3);
assert.equal(report.wastageRatePercent, 0, "pending reconciliation has no definitive rate");
assert.equal(report.isCutoffPassed, false, "cutoff phase is active before cutoff");
assert.equal(report.reconciliationStatus, "PENDING", "active bookings keep reconciliation pending");
assert.equal(
  calculatePrepReport(service, cutoffAt).isCutoffPassed,
  true,
  "cutoff phase locks at cutoff",
);

const emptyReport = calculatePrepReport(
  { ...service, offerings: [] },
  new Date(cutoffAt.getTime() + 1),
);
assert.equal(emptyReport.totalPlatesCooked, 0);
assert.equal(emptyReport.wastageRatePercent, 0, "zero cooked plates avoid division errors");
assert.equal(emptyReport.reconciliationStatus, "PENDING");

const completedToday = calculatePrepReport(
  {
    ...service,
    cutoffAt: new Date(now.getTime() - 1),
    offerings: [
      {
        ...service.offerings[0],
        quantityLeft: 16,
        bookings: [
          { count: 3, status: BookingStatus.SERVED },
          { count: 1, status: BookingStatus.NO_SHOW },
        ],
      },
    ],
  },
  now,
);
assert.equal(
  completedToday.reconciliationStatus,
  "COMPLETED",
  "today is reconcilable when cutoff passed and all bookings are terminal",
);
assert.equal(completedToday.totalPlatesCooked, 4);
assert.equal(completedToday.totalPlatesWasted, 1);
assert.equal(completedToday.wastageRatePercent, 25);

const incompleteToday = calculatePrepReport(
  {
    ...service,
    cutoffAt: new Date(now.getTime() - 1),
    offerings: [
      {
        ...service.offerings[0],
        bookings: [
          { count: 1, status: BookingStatus.BOOKED },
        ],
      },
    ],
  },
  now,
);
assert.equal(
  incompleteToday.reconciliationStatus,
  "PENDING",
  "today remains pending while a BOOKED booking is unresolved",
);
assert.equal(incompleteToday.unresolvedBookedCount, 1);
assert.equal(incompleteToday.totalPlatesWasted, 0);

const noCancellations = calculatePrepReport(
  {
    ...service,
    offerings: [
      {
        ...service.offerings[0],
        bookings: [
          { count: 4, status: BookingStatus.SERVED },
        ],
      },
    ],
  },
  cutoffAt,
);
assert.equal(
  noCancellations.offerings[0].restockedCount,
  0,
  "no cancellations do not produce restocked plates",
);
assert.equal(noCancellations.offerings[0].cancelledAfterCutoffCount, 0);

const allPreCutoff = calculatePrepReport(
  {
    ...service,
    offerings: [
      {
        ...service.offerings[0],
        quantityLeft: 20,
        bookings: [{ count: 20, status: BookingStatus.CANCELLED }],
      },
    ],
  },
  now,
).offerings[0];
assert.equal(allPreCutoff.finalCookCount, 0);
assert.equal(allPreCutoff.restockedCount, 20);
assert.equal(allPreCutoff.cancelledAfterCutoffCount, 0);

const allPostCutoff = calculatePrepReport(
  {
    ...service,
    offerings: [
      {
        ...service.offerings[0],
        quantityLeft: 0,
        bookings: [{ count: 20, status: BookingStatus.CANCELLED }],
      },
    ],
  },
  cutoffAt,
).offerings[0];
assert.equal(allPostCutoff.finalCookCount, 20);
assert.equal(allPostCutoff.restockedCount, 0);
assert.equal(allPostCutoff.cancelledAfterCutoffCount, 20);

const invalidQuantities = calculatePrepReport(
  {
    ...service,
    offerings: [
      {
        ...service.offerings[0],
        quantityTotal: -5,
        quantityLeft: -2,
        bookings: [
          { count: -3, status: BookingStatus.BOOKED },
          { count: 2.5, status: BookingStatus.CANCELLED },
        ],
      },
    ],
  },
  cutoffAt,
).offerings[0];
assert.equal(invalidQuantities.quantityTotal, 0);
assert.equal(invalidQuantities.quantityLeft, 0);
assert.equal(invalidQuantities.finalCookCount, 0);
assert.equal(invalidQuantities.totalCancelledCount, 0);
assert.equal(invalidQuantities.expectedRevenue, 0);

const missingBookings = calculatePrepReport(
  {
    ...service,
    offerings: [
      { ...service.offerings[0], quantityLeft: 20, bookings: [] },
    ],
  },
  new Date(cutoffAt.getTime() + 1),
);
assert.equal(missingBookings.totalPlatesCooked, 0);
assert.equal(missingBookings.reconciliationStatus, "PENDING");

assert.equal(getUnbookedStockLabel(false), "Provisional Unbooked Stock");
assert.equal(getUnbookedStockLabel(true), "Locked Unbooked Stock");

const laterService = {
  id: "dinner",
  serviceDate,
  cutoffAt: new Date("2026-04-04T14:00:00.000Z"),
};
const yesterdayService = {
  id: "yesterday",
  serviceDate: new Date(serviceDate.getTime() - 24 * 60 * 60 * 1000),
  cutoffAt,
};
assert.equal(
  resolvePrepService([service, laterService], undefined, now).service?.id,
  "lunch",
  "defaults to the earliest upcoming service today",
);
assert.equal(
  resolvePrepService([service, laterService], "dinner", now).service?.id,
  "dinner",
  "accepts a valid selected service",
);
const invalidSelection = resolvePrepService(
  [service, laterService],
  "missing",
  now,
);
assert.equal(invalidSelection.invalidSelection, true);
assert.equal(invalidSelection.service?.id, "lunch");
assert.equal(resolvePrepService([], undefined, now).service, null, "handles no services");
assert.equal(
  resolvePrepService([yesterdayService], undefined, now).service?.id,
  "yesterday",
  "falls back to the latest available service",
);
assert.equal(isPastServiceDate(yesterdayService.serviceDate, now), true);
assert.equal(isPastServiceDate(serviceDate, now), false);
assert.equal(isTodayOrPastServiceDate(serviceDate, now), true);

const kitchenUser = { id: "k", name: "Kitchen", role: Role.KITCHEN };
assert.equal(getPrepAccess(kitchenUser).allowed, true);
assert.deepEqual(getPrepAccess(null), {
  allowed: false,
  redirectTo: "/login",
});
assert.deepEqual(getPrepAccess({ ...kitchenUser, role: Role.STUDENT }), {
  allowed: false,
  redirectTo: "/",
});
assert.deepEqual(getPrepAccess({ ...kitchenUser, role: Role.SECRETARY }), {
  allowed: false,
  redirectTo: "/",
});

console.log("All prep calculation and selection checks passed.");
