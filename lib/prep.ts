import { BookingStatus, Role, type Meal } from "@prisma/client";
import type { CurrentUser } from "@/lib/auth";

export type PrepBooking = {
  count: number;
  status: BookingStatus;
  /**
   * Optional trusted cancellation timestamp. The current Booking model does
   * not persist one, so application-loaded cancelled rows leave this unset.
   */
  cancellationAt?: Date | null;
};

export type PrepOffering = {
  id: string;
  quantityTotal: number;
  quantityLeft: number;
  menuItem: {
    name: string;
    included: boolean;
    priceRupees: number | null;
  };
  bookings: PrepBooking[];
};

export type PrepService = {
  id: string;
  meal: Meal;
  serviceDate: Date;
  cutoffAt: Date;
  offerings: PrepOffering[];
};

export type OfferingPrepSummary = {
  offeringId: string;
  menuItemName: string;
  included: boolean;
  priceRupees: number | null;
  quantityTotal: number;
  quantityLeft: number;
  bookedCount: number;
  servedCount: number;
  noShowCount: number;
  postCutoffCancelledCount: number;
  preCutoffCancelledCount: number;
  uncertainCancelledCount: number;
  finalCookCount: number;
  unbookedCount: number;
  expectedRevenue: number | null;
};

export type ReconciliationStatus = "COMPLETED" | "PENDING";

export type ServicePrepReport = {
  serviceId: string;
  meal: Meal;
  serviceDate: Date;
  cutoffAt: Date;
  isCutoffPassed: boolean;
  offerings: OfferingPrepSummary[];
  totalPlatesCooked: number;
  totalPlatesServed: number;
  totalPlatesWasted: number;
  wastageRatePercent: number;
  unresolvedBookedCount: number;
  uncertainCancelledCount: number;
  reconciliationStatus: ReconciliationStatus;
};

export type PrepAccess =
  | { allowed: true; user: CurrentUser }
  | { allowed: false; redirectTo: "/login" | "/" };

export function getPrepAccess(user: CurrentUser | null): PrepAccess {
  if (!user) return { allowed: false, redirectTo: "/login" };
  if (user.role !== Role.KITCHEN) return { allowed: false, redirectTo: "/" };
  return { allowed: true, user };
}

export function getTodayServiceDate(now: Date): Date {
  return new Date(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()),
  );
}

export type CancellationTiming = "PRE_CUTOFF" | "POST_CUTOFF" | "UNKNOWN";

export function classifyCancellation(
  cutoffAt: Date,
  cancellationAt: Date | null | undefined,
): CancellationTiming {
  if (!cancellationAt) return "UNKNOWN";
  return cancellationAt.getTime() < cutoffAt.getTime()
    ? "PRE_CUTOFF"
    : "POST_CUTOFF";
}

export function resolvePrepService<T extends Pick<
  PrepService,
  "id" | "serviceDate" | "cutoffAt"
>>(
  services: readonly T[],
  requestedServiceId: string | undefined,
  now: Date,
): { service: T | null; invalidSelection: boolean } {
  if (requestedServiceId !== undefined) {
    const requested = services.find((service) => service.id === requestedServiceId);
    if (requested) return { service: requested, invalidSelection: false };
  }

  const today = getTodayServiceDate(now).getTime();
  const todaysUpcoming = services
    .filter(
      (service) =>
        service.serviceDate.getTime() === today &&
        service.cutoffAt.getTime() > now.getTime(),
    )
    .sort((a, b) => a.cutoffAt.getTime() - b.cutoffAt.getTime());

  const latestAvailable = [...services].sort(
    (a, b) =>
      b.serviceDate.getTime() - a.serviceDate.getTime() ||
      b.cutoffAt.getTime() - a.cutoffAt.getTime(),
  );

  return {
    service: todaysUpcoming[0] ?? latestAvailable[0] ?? null,
    invalidSelection:
      requestedServiceId !== undefined &&
      !services.some((service) => service.id === requestedServiceId),
  };
}

export function calculatePrepReport(
  service: PrepService,
  now: Date,
): ServicePrepReport {
  const offerings = service.offerings.map((offering) => {
    let bookedCount = 0;
    let servedCount = 0;
    let noShowCount = 0;
    let postCutoffCancelledCount = 0;
    let preCutoffCancelledCount = 0;
    let uncertainCancelledCount = 0;

    for (const booking of offering.bookings) {
      switch (booking.status) {
        case BookingStatus.BOOKED:
          bookedCount += booking.count;
          break;
        case BookingStatus.SERVED:
          servedCount += booking.count;
          break;
        case BookingStatus.NO_SHOW:
          noShowCount += booking.count;
          break;
        case BookingStatus.CANCELLED:
          switch (classifyCancellation(service.cutoffAt, booking.cancellationAt)) {
            case "PRE_CUTOFF":
              preCutoffCancelledCount += booking.count;
              break;
            case "POST_CUTOFF":
              postCutoffCancelledCount += booking.count;
              break;
            case "UNKNOWN":
              uncertainCancelledCount += booking.count;
              break;
          }
          break;
      }
    }

    const finalCookCount =
      bookedCount +
      servedCount +
      noShowCount +
      postCutoffCancelledCount;

    return {
      offeringId: offering.id,
      menuItemName: offering.menuItem.name,
      included: offering.menuItem.included,
      priceRupees: offering.menuItem.priceRupees,
      quantityTotal: offering.quantityTotal,
      quantityLeft: offering.quantityLeft,
      bookedCount,
      servedCount,
      noShowCount,
      postCutoffCancelledCount,
      preCutoffCancelledCount,
      uncertainCancelledCount,
      finalCookCount:
        finalCookCount + uncertainCancelledCount,
      unbookedCount: offering.quantityLeft,
      expectedRevenue:
        offering.menuItem.included || offering.menuItem.priceRupees === null
          ? null
          : (finalCookCount + uncertainCancelledCount) *
            offering.menuItem.priceRupees,
    };
  });

  const totalPlatesCooked = offerings.reduce(
    (total, offering) => total + offering.finalCookCount,
    0,
  );
  const totalPlatesServed = offerings.reduce(
    (total, offering) => total + offering.servedCount,
    0,
  );
  const totalPlatesWasted = offerings.reduce(
    (total, offering) =>
      total + offering.noShowCount + offering.postCutoffCancelledCount,
    0,
  );
  const unresolvedBookedCount = offerings.reduce(
    (total, offering) => total + offering.bookedCount,
    0,
  );
  const uncertainCancelledCount = offerings.reduce(
    (total, offering) => total + offering.uncertainCancelledCount,
    0,
  );
  const totalBookingCount = service.offerings.reduce(
    (total, offering) =>
      total + offering.bookings.reduce((count, booking) => count + booking.count, 0),
    0,
  );
  const isServiceDateBeforeToday =
    service.serviceDate.getTime() < getTodayServiceDate(now).getTime();
  const isTodayWithTerminalBookings =
    service.serviceDate.getTime() === getTodayServiceDate(now).getTime() &&
    now.getTime() >= service.cutoffAt.getTime() &&
    totalBookingCount > 0;
  const reconciliationStatus: ReconciliationStatus =
    unresolvedBookedCount === 0 &&
    uncertainCancelledCount === 0 &&
    totalBookingCount > 0 &&
    (isServiceDateBeforeToday || isTodayWithTerminalBookings)
      ? "COMPLETED"
      : "PENDING";

  return {
    serviceId: service.id,
    meal: service.meal,
    serviceDate: service.serviceDate,
    cutoffAt: service.cutoffAt,
    isCutoffPassed: now.getTime() >= service.cutoffAt.getTime(),
    offerings,
    totalPlatesCooked,
    totalPlatesServed,
    totalPlatesWasted,
    wastageRatePercent:
      reconciliationStatus === "PENDING" || totalPlatesCooked === 0
        ? 0
        : (totalPlatesWasted / totalPlatesCooked) * 100,
    unresolvedBookedCount,
    uncertainCancelledCount,
    reconciliationStatus,
  };
}

export function isPastServiceDate(serviceDate: Date, now: Date): boolean {
  return serviceDate.getTime() < getTodayServiceDate(now).getTime();
}

export function isTodayOrPastServiceDate(
  serviceDate: Date,
  now: Date,
): boolean {
  return serviceDate.getTime() <= getTodayServiceDate(now).getTime();
}

export function getUnbookedStockLabel(isCutoffPassed: boolean): string {
  return isCutoffPassed
    ? "Locked Unbooked Stock"
    : "Provisional Unbooked Stock";
}
