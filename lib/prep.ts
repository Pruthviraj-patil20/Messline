import { BookingStatus, Role, type Meal } from "@prisma/client";
import type { CurrentUser } from "@/lib/auth";

export type PrepBooking = {
  count: number;
  status: BookingStatus;
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
  totalCancelledCount: number;
  cancelledAfterCutoffCount: number;
  restockedCount: number;
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
    const quantityTotal = validQuantity(offering.quantityTotal);
    const quantityLeft = Math.min(
      quantityTotal,
      validQuantity(offering.quantityLeft),
    );
    let bookedCount = 0;
    let servedCount = 0;
    let noShowCount = 0;
    let totalCancelledCount = 0;

    for (const booking of offering.bookings) {
      const count = validQuantity(booking.count);
      switch (booking.status) {
        case BookingStatus.BOOKED:
          bookedCount += count;
          break;
        case BookingStatus.SERVED:
          servedCount += count;
          break;
        case BookingStatus.NO_SHOW:
          noShowCount += count;
          break;
        case BookingStatus.CANCELLED:
          totalCancelledCount += count;
          break;
      }
    }

    const finalCookCount = Math.max(
      0,
      Math.min(quantityTotal, quantityTotal - quantityLeft),
    );
    const cancelledAfterCutoffCount = Math.min(
      totalCancelledCount,
      Math.max(0, finalCookCount - (bookedCount + servedCount + noShowCount)),
    );
    const restockedCount = Math.max(
      0,
      totalCancelledCount - cancelledAfterCutoffCount,
    );

    return {
      offeringId: offering.id,
      menuItemName: offering.menuItem.name,
      included: offering.menuItem.included,
      priceRupees: offering.menuItem.priceRupees,
      quantityTotal,
      quantityLeft,
      bookedCount,
      servedCount,
      noShowCount,
      totalCancelledCount,
      cancelledAfterCutoffCount,
      restockedCount,
      finalCookCount,
      unbookedCount: quantityLeft,
      expectedRevenue:
        offering.menuItem.included || offering.menuItem.priceRupees === null
          ? null
          : finalCookCount * offering.menuItem.priceRupees,
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
      total + offering.noShowCount + offering.cancelledAfterCutoffCount,
    0,
  );
  const unresolvedBookedCount = offerings.reduce(
    (total, offering) => total + offering.bookedCount,
    0,
  );
  const totalBookingCount = service.offerings.reduce(
    (total, offering) =>
      total +
      offering.bookings.reduce(
        (count, booking) => count + validQuantity(booking.count),
        0,
      ),
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
    reconciliationStatus,
  };
}

function validQuantity(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
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
