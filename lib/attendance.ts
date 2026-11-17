import { BookingStatus, Role } from "@prisma/client";
import { prisma } from "./db";
import { getCurrentUser } from "./auth";

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
 * Mark a single booking as SERVED.
 * Performs server-side authorization and status checks.
 */
export async function markServed(bookingId: string): Promise<void> {
  const user = await getCurrentUser();
  if (!user || user.role !== Role.KITCHEN) {
    throw new Error("Unauthorized");
  }

  // The status check sits in the WHERE clause, so concurrent calls or re-submissions
  // only succeed if the booking is still in BOOKED status.
  // quantityLeft is not modified: SERVED does not alter inventory.
  await prisma.$transaction(async (tx) => {
    const updated = await tx.booking.updateMany({
      where: {
        id: bookingId,
        status: BookingStatus.BOOKED,
      },
      data: { status: BookingStatus.SERVED },
    });
    if (updated.count === 0) {
      throw new Error("Cannot mark served: booking not found or already finalized");
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
    throw new Error("Unauthorized");
  }

  if (typeof serviceId !== "string" || !serviceId) {
    throw new Error("Invalid serviceId");
  }

  const updatedCount = await prisma.$transaction(async (tx) => {
    // 1. Verify service exists
    const service = await tx.service.findUnique({
      where: { id: serviceId },
      select: { cutoffAt: true },
    });
    if (!service) {
      throw new Error("Service not found");
    }

    // 2. Validate cutoff has passed using database wall-clock time
    const dbNow = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() as now`;
    const now = dbNow[0]?.now;
    if (!now || now < service.cutoffAt) {
      throw new Error("Service cutoff has not passed yet");
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
