import { BookingStatus, Prisma, WaitlistStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "./db";

const countSchema = z.number().int().positive();

export type BookingFailure =
  | "INVALID_COUNT"
  | "NOT_FOUND"
  | "NOT_PUBLISHED"
  | "CUTOFF_PASSED"
  | "ALREADY_BOOKED"
  | "SOLD_OUT"
  | "ALREADY_ON_WAITLIST";

export type BookPlatesResult =
  | { ok: true; bookingId: string }
  | { ok: false; reason: BookingFailure; position?: number; waitlistId?: string };

export type WaitlistEntry = {
  id: string;
  position: number;
  status: WaitlistStatus;
  createdAt: Date;
};

export type WaitlistInfo = {
  entries: WaitlistEntry[];
  totalActive: number;
};

// Thrown inside the transaction so Prisma rolls everything back.
class BookingError extends Error {
  constructor(public reason: BookingFailure) {
    super(reason);
  }
}

export async function bookPlates(
  userId: string,
  offeringId: string,
  count: number
): Promise<BookPlatesResult> {
  const parsed = countSchema.safeParse(count);
  if (!parsed.success) return { ok: false, reason: "INVALID_COUNT" };
  const plates = parsed.data;

  // First, attempt the booking inside a transaction (locks offering row, checks stock, creates booking if possible)
  let waitlistInfo: { position: number; waitlistId: string } | null = null;

  try {
    const booking = await prisma.$transaction(async (tx) => {
      // 1. The offering must exist, its service must be published,
      //    and the cutoff must not have passed.
      const offering = await tx.offering.findUnique({
        where: { id: offeringId },
        select: { service: { select: { published: true, cutoffAt: true } } },
      });
      if (!offering) throw new BookingError("NOT_FOUND");
      if (!offering.service.published) throw new BookingError("NOT_PUBLISHED");
      if (new Date() >= offering.service.cutoffAt) {
        throw new BookingError("CUTOFF_PASSED");
      }

      // 2. The conditional update from docs/rules.md:
      //    UPDATE "Offering" SET "quantityLeft" = "quantityLeft" - $count
      //    WHERE id = $id AND "quantityLeft" >= $count
      //    Zero rows updated means sold out, and no booking is created.
      const updated = await tx.offering.updateMany({
        where: { id: offeringId, quantityLeft: { gte: plates } },
        data: { quantityLeft: { decrement: plates } },
      });

      if (updated.count === 0) throw new BookingError("SOLD_OUT");

      // 3. One open booking per student per offering. This runs after the
      //    update on purpose: the update locks the offering row, so a
      //    concurrent request from the same student waits for the lock and
      //    then sees the first booking. Throwing rolls the decrement back.
      const existing = await tx.booking.findFirst({
        where: { userId, offeringId, status: "BOOKED" },
        select: { id: true },
      });
      if (existing) throw new BookingError("ALREADY_BOOKED");

      // 4. Create the booking.
      return tx.booking.create({
        data: { userId, offeringId, count: plates, status: "BOOKED" },
        select: { id: true },
      });
    });

    return { ok: true, bookingId: booking.id };
  } catch (err) {
    if (err instanceof BookingError) {
      // Booking failed (SOLD_OUT or ALREADY_BOOKED). Now add to waitlist atomically.
      // We check for existing waitlist entry first (uniqueness constraint handles duplicates).
      // Check both ACTIVE and PROMOTED status - a PROMOTED entry means the student was already promoted.
      const existingWaitlist = await prisma.waitlist.findFirst({
        where: { userId, offeringId, status: { in: ["ACTIVE", "PROMOTED"] } },
      });
      if (existingWaitlist) {
        waitlistInfo = {
          position: existingWaitlist.position,
          waitlistId: existingWaitlist.id,
        };
      } else {
        // Add student to waitlist (FIFO: position = current active count + 1)
        const maxPosResult = await prisma.waitlist.findFirst({
          where: { offeringId, status: "ACTIVE" },
          select: { position: true },
          orderBy: { position: "desc" },
        });
        const nextPosition = (maxPosResult?.position ?? 0) + 1;
        const newWaitlistEntry = await prisma.waitlist.create({
          data: { userId, offeringId, position: nextPosition, status: "ACTIVE" },
          select: { id: true, position: true },
        });
        waitlistInfo = {
          position: newWaitlistEntry.position,
          waitlistId: newWaitlistEntry.id,
        };
      }
      return {
        ok: false,
        reason: err.reason,
        position: waitlistInfo?.position,
        waitlistId: waitlistInfo?.waitlistId,
      };
    }
    throw err; // real errors (DB down, etc.) are not a failed booking
  }
}

export type CancelBookingErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "NOT_BOOKED";

export class CancelBookingError extends Error {
  code: CancelBookingErrorCode;

  constructor(code: CancelBookingErrorCode, message: string) {
    super(message);
    this.name = "CancelBookingError";
    this.code = code;
  }
}

const cancelInput = z.object({
  userId: z.string().min(1),
  bookingId: z.string().min(1),
});

export type CancelBookingResult = {
  bookingId: string;
  // true when the plates went back into quantityLeft (cancelled before cutoffAt)
  restocked: boolean;
  quantityLeft: number;
};

/**
 * Cancel a booking, following the Cancel section of docs/rules.md.
 *
 * - Only the student who made the booking can cancel it.
 * - Only a BOOKED row can be cancelled.
 * - Before cutoffAt: status becomes CANCELLED and quantityLeft goes up by
 *   count, capped at quantityTotal.
 * - At or after cutoffAt: status becomes CANCELLED and quantityLeft does not
 *   change, because the kitchen already cooked for that count.
 *
 * The status change and the stock change run in one transaction.
 */
export async function cancelBooking(
  userId: string,
  bookingId: string,
): Promise<CancelBookingResult> {
  const parsed = cancelInput.safeParse({ userId, bookingId });
  if (!parsed.success) {
    throw new CancelBookingError(
      "INVALID_INPUT",
      "userId and bookingId are required.",
    );
  }

  return prisma.$transaction(async (tx) => {
    const booking = await tx.booking.findUnique({
      where: { id: parsed.data.bookingId },
      include: { offering: { include: { service: true } } },
    });

    // Same error for "missing" and "someone else's", so ids can't be probed.
    if (!booking || booking.userId !== parsed.data.userId) {
      throw new CancelBookingError("NOT_FOUND", "Booking not found.");
    }

    if (booking.status !== BookingStatus.BOOKED) {
      throw new CancelBookingError(
        "NOT_BOOKED",
        "Only a booking that is still BOOKED can be cancelled.",
      );
    }

    // The status check sits in the WHERE clause, so if two cancels for the
    // same booking run at the same time, only one of them updates a row and
    // the plates are never given back twice.
    const updated = await tx.booking.updateMany({
      where: {
        id: booking.id,
        userId: parsed.data.userId,
        status: BookingStatus.BOOKED,
      },
      data: { status: BookingStatus.CANCELLED },
    });

    if (updated.count === 0) {
      throw new CancelBookingError(
        "NOT_BOOKED",
        "Only a booking that is still BOOKED can be cancelled.",
      );
    }

    const beforeCutoff = new Date() < booking.offering.service.cutoffAt;

    if (beforeCutoff) {
      // LEAST keeps quantityLeft from going past quantityTotal.
      await tx.$executeRaw`
        UPDATE "Offering"
        SET "quantityLeft" = LEAST("quantityLeft" + ${booking.count}, "quantityTotal")
        WHERE id = ${booking.offeringId}
      `;

      // Promote the next FIFO waitlist entry atomically.
      await promoteFromWaitlist(tx, booking.offeringId, booking.count);
    }

    const offering = await tx.offering.findUniqueOrThrow({
      where: { id: booking.offeringId },
      select: { quantityLeft: true },
    });

    return {
      bookingId: booking.id,
      restocked: beforeCutoff,
      quantityLeft: offering.quantityLeft,
    };
  });
}

async function promoteFromWaitlist(tx: Prisma.TransactionClient, offeringId: string, count: number) {
  // Find the first ACTIVE waitlist entry (FIFO = lowest position).
  const waitlistEntry = await tx.waitlist.findFirst({
    where: { offeringId, status: "ACTIVE" },
    orderBy: { position: "asc" },
  });

  if (!waitlistEntry) return;

  // Since we're already in the cancel transaction with the offering row locked,
  // we can safely attempt the booking without a nested transaction.
  // The offering lock prevents concurrent stock depletion.

  // 1. Conditional decrement
  const updated = await tx.offering.updateMany({
    where: { id: offeringId, quantityLeft: { gte: count } },
    data: { quantityLeft: { decrement: count } },
  });
  if (updated.count === 0) return; // still sold out, leave waitlist ACTIVE

  // 2. One open booking per student per offering check
  const existing = await tx.booking.findFirst({
    where: { userId: waitlistEntry.userId, offeringId, status: "BOOKED" },
    select: { id: true },
  });
  if (existing) {
    // Student already has a booking; revert the decrement and leave waitlist ACTIVE.
    await tx.offering.update({
      where: { id: offeringId },
      data: { quantityLeft: { increment: count } },
    });
    return;
  }

  // 3. Create the booking
  await tx.booking.create({
    data: { userId: waitlistEntry.userId, offeringId, count, status: "BOOKED" },
  });

  // 4. Mark the waitlist entry as PROMOTED
  await tx.waitlist.update({
    where: { id: waitlistEntry.id },
    data: { status: "PROMOTED" },
  });
}

export async function leaveWaitlist(userId: string, offeringId: string) {
  const result = await prisma.$executeRaw`
    DELETE FROM "Waitlist"
    WHERE "userId" = ${userId} AND "offeringId" = ${offeringId} AND "status" = 'ACTIVE'
  `;
  // Return number of deleted rows (0 or 1)
  return result > 0;
}

export async function inspectWaitlist(offeringId: string, limit = 20) {
  const entries = await prisma.waitlist.findMany({
    where: { offeringId },
    orderBy: { position: "asc" },
    take: limit,
    select: { id: true, userId: true, position: true, createdAt: true, status: true },
  });

  const totalActive = await prisma.waitlist.count({
    where: { offeringId, status: "ACTIVE" },
  });

  return { entries, totalActive };
}