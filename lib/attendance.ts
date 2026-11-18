import { BookingStatus, Role } from "@prisma/client";
import { prisma } from "./db";
import { getCurrentUser } from "./auth";

/**
 * Custom error class for attendance-related domain errors.
 * Ensures only safe, predefined messages are exposed to clients.
 */
export class AttendanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttendanceError";
  }
}

// serviceDate is stored as midnight UTC of the local day (same as calendarDate in app/page.tsx)
function todayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

/**
 * Deterministic six-character booking verification token.
 * Uses the last six characters of the booking ID, upper-cased.
 * Handles short or invalid IDs safely.
 */
export function getBookingToken(bookingId: string): string {
  if (typeof bookingId !== "string" || !bookingId) return "";
  if (bookingId.length <= 6) return bookingId.toUpperCase();
  return bookingId.slice(-6).toUpperCase();
}

/**
 * User-facing display labels for booking statuses.
 */
export const STATUS_LABELS: Record<string, string> = {
  BOOKED: "Booked",
  CANCELLED: "Cancelled",
  SERVED: "Served",
  NO_SHOW: "No-show",
};

export function getStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

/**
 * Mark a single booking as SERVED.
 * Performs server-side authorization, status checks, and service-date validation (serviceDate <= today).
 */
export async function markServed(bookingId: string): Promise<void> {
  const user = await getCurrentUser();
  if (!user || user.role !== Role.KITCHEN) {
    throw new AttendanceError("Unauthorized");
  }

  // The status and serviceDate checks sit in the WHERE clause:
  // - status must still be BOOKED (prevents duplicate transitions / overwriting)
  // - serviceDate must be today or earlier (cannot mark future services served)
  // - quantityLeft is not modified: SERVED does not alter inventory.
  await prisma.$transaction(async (tx) => {
    const updated = await tx.booking.updateMany({
      where: {
        id: bookingId,
        status: BookingStatus.BOOKED,
        offering: {
          service: {
            serviceDate: { lte: todayUtc() },
          },
        },
      },
      data: { status: BookingStatus.SERVED },
    });
    if (updated.count === 0) {
      throw new AttendanceError("Cannot mark served: booking not found, already finalized, or service is in the future");
    }
  });
}

/**
 * Mark a single booking as NO_SHOW.
 * Performs server-side authorization, status checks, and service-date validation (serviceDate <= today).
 */
export async function markNoShow(bookingId: string): Promise<void> {
  const user = await getCurrentUser();
  if (!user || user.role !== Role.KITCHEN) {
    throw new AttendanceError("Unauthorized");
  }

  // The status and serviceDate checks sit in the WHERE clause:
  // - status must still be BOOKED
  // - serviceDate must be today or earlier (consistent with legacy markBooking where serviceDate <= today)
  // - quantityLeft is not modified: NO_SHOW does not alter inventory.
  await prisma.$transaction(async (tx) => {
    const updated = await tx.booking.updateMany({
      where: {
        id: bookingId,
        status: BookingStatus.BOOKED,
        offering: {
          service: {
            serviceDate: { lte: todayUtc() },
          },
        },
      },
      data: { status: BookingStatus.NO_SHOW },
    });
    if (updated.count === 0) {
      throw new AttendanceError("Cannot mark no-show: booking not found, already finalized, or service is in the future");
    }
  });
}

/**
 * Bulk reconciliation - after a service cutoff, mark all remaining BOOKED bookings
 * for the given service as NO_SHOW.
 * Returns the number of rows updated.
 */
export async function bulkMarkNoShow(serviceId: string): Promise<number> {
  const user = await getCurrentUser();
  if (!user || user.role !== Role.KITCHEN) {
    throw new AttendanceError("Unauthorized");
  }

  if (typeof serviceId !== "string" || !serviceId.trim()) {
    throw new AttendanceError("Invalid service ID");
  }

  const updatedCount = await prisma.$transaction(async (tx) => {
    // 1. Verify service exists
    const service = await tx.service.findUnique({
      where: { id: serviceId },
      select: { cutoffAt: true },
    });
    if (!service) {
      throw new AttendanceError("Service not found");
    }

    // 2. Validate cutoff has passed using database wall-clock time
    const dbNow = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() as now`;
    const now = dbNow[0]?.now;
    if (!now || now < service.cutoffAt) {
      throw new AttendanceError("Service cutoff has not passed yet");
    }

    // 3. Conditionally update BOOKED rows belonging to this service.
    // Inventory invariant: NO_SHOW does not alter quantityLeft.
    const result = await tx.booking.updateMany({
      where: {
        offering: { serviceId },
        status: BookingStatus.BOOKED,
      },
      data: { status: BookingStatus.NO_SHOW },
    });

    return result.count;
  });

  return updatedCount;
}
