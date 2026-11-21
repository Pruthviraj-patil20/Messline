import { BookingStatus, PrismaClient } from "@prisma/client";
import { bookPlates, cancelBooking, leaveWaitlist, inspectWaitlist } from "../lib/booking";
import { prisma } from "../lib/db";

async function main() {
  let failures = 0;
  function check(label: string, ok: boolean, detail = "") {
    if (!ok) failures += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  }

  const meera = await prisma.user.findUniqueOrThrow({ where: { email: "meera@messline.dev" } });
  const kabir = await prisma.user.findUniqueOrThrow({ where: { email: "kabir@messline.dev" } });

// Find a lunch offering that's published
  const offering = await prisma.offering.findFirst({
    where: {
      service: {
        meal: "LUNCH",
        published: true,
      },
    },
    include: { service: true },
    orderBy: { service: { serviceDate: "desc" } },
  });
  if (!offering) {
    console.error("No suitable offering found. Run db:reset first.");
    process.exit(1);
  }

  // Set cutoff to far future so bookings work
  await prisma.service.update({
    where: { id: offering.serviceId },
    data: { cutoffAt: new Date(Date.now() + 24 * 60 * 60 * 1000) },
  });

  // Explicitly reset bookings and quantity
  await prisma.booking.deleteMany({ where: { offeringId: offering.id } });
  await prisma.offering.update({ where: { id: offering.id }, data: { quantityLeft: 1 } });
  const verify = await prisma.offering.findUniqueOrThrow({ where: { id: offering.id }, select: { quantityLeft: true } });
  if (verify.quantityLeft !== 1) {
    console.error(`WARNING: quantityLeft is ${verify.quantityLeft}, expected 1. Proceeding anyway.`);
  }

  console.log(`\nTesting waitlist for offering ${offering.id}, total ${offering.quantityTotal}, left ${offering.quantityLeft}\n`);

  // --- Test 1: Book the last plate, others go to waitlist ---
  console.log("Case 1: Book the last plate, others join waitlist");
  const b1 = await bookPlates(meera.id, offering.id, 1);
  check("meera books the last plate", b1.ok === true, b1.ok ? "" : b1.reason);
  const afterB1 = await prisma.offering.findUniqueOrThrow({ where: { id: offering.id }, select: { quantityLeft: true } });
  check("quantityLeft is 0 after booking", afterB1.quantityLeft === 0, "quantityLeft=" + afterB1.quantityLeft);

  // kabir tries to book but it's sold out -> should join waitlist
  const kWaitlist = await bookPlates(kabir.id, offering.id, 1);
  const isWaitlist = !kWaitlist.ok && kWaitlist.reason === "SOLD_OUT" && typeof kWaitlist.position === "number" && typeof kWaitlist.waitlistId === "string";
  check("kabir joins waitlist (SOLD_OUT with position+waitlistId)", 
    isWaitlist,
    !kWaitlist.ok ? `reason=${kWaitlist.reason} position=${kWaitlist.position} waitlistId=${kWaitlist.waitlistId}` : "unexpected ok");
  if (!kWaitlist.ok && kWaitlist.reason === "SOLD_OUT" && kWaitlist.position !== undefined) {
    check("kabir is position 1 on waitlist", kWaitlist.position === 1, "position=" + kWaitlist.position);
  }

  // --- Test 2: inspect waitlist (kitchen staff) ---
  console.log("\nCase 2: Inspect waitlist (kitchen staff)");
  const { entries, totalActive } = await inspectWaitlist(offering.id, 10);
  check("waitlist has 1 active entry (kabir)", totalActive === 1, "totalActive=" + totalActive);
  check("entry has position 1", entries[0].position === 1, "position=" + entries[0].position);
  check("entry status is ACTIVE", entries[0].status === "ACTIVE", "status=" + entries[0].status);

  // --- Test 3: leave waitlist (student) ---
  console.log("\nCase 3: Student leaves waitlist");
  const left = await leaveWaitlist(kabir.id, offering.id);
  check("leaveWaitlist succeeds", left === true, "left=" + left);
  const afterLeave = await inspectWaitlist(offering.id, 10);
  check("waitlist is now empty after leave", afterLeave.totalActive === 0, "totalActive=" + afterLeave.totalActive);

  // --- Test 4: Promotion via before-cutoff cancellation ---
  console.log("\nCase 4: Promotion via before-cutoff cancellation");
  // Reset state: clear meera's booking and set quantity to 1
  await prisma.booking.deleteMany({ where: { offeringId: offering.id, userId: meera.id } });
  await prisma.offering.update({ where: { id: offering.id }, data: { quantityLeft: 1 } });
  const b2 = await bookPlates(meera.id, offering.id, 1); // meera takes last plate
  check("meera books the last plate", b2.ok === true, b2.ok ? "" : b2.reason);
  if (!b2.ok) throw new Error("b2 booking failed");

  // kabir is already on waitlist from before, but let's re-join to test fresh
  await bookPlates(kabir.id, offering.id, 1); // kabir joins waitlist at position 1
  const kWL = await inspectWaitlist(offering.id, 10);
  check("kabir is on waitlist", kWL.totalActive === 1, "totalActive=" + kWL.totalActive);

  // Set cutoff far in the future
  await prisma.service.update({
    where: { id: offering.serviceId },
    data: { cutoffAt: new Date(Date.now() + 24 * 60 * 60 * 1000) },
  });

  // Cancel meera's booking before cutoff
  const cancelResult = await cancelBooking(meera.id, b2.bookingId);
  check("cancel before cutoff restocks", cancelResult.restocked === true, "restocked=" + cancelResult.restocked);

  // Check if kabir was promoted
  const afterPromote = await inspectWaitlist(offering.id, 10);
  check("waitlist entry was promoted (removed from active)", afterPromote.totalActive === 0, "totalActive=" + afterPromote.totalActive);
  // Check if kabir now has a booking
  const kabirBooking = await prisma.booking.findFirst({
    where: { userId: kabir.id, offeringId: offering.id, status: BookingStatus.BOOKED },
  });
  check("kabir was promoted to BOOKED", kabirBooking !== null, "kabir has booking: " + (kabirBooking ? "yes" : "no"));

  // --- Test 5: Duplicate join rejected (uniqueness constraint) ---
  console.log("\nCase 5: Duplicate waitlist entry rejected");
  // Try to add kabir to waitlist again - should be a no-op since already there
  await bookPlates(kabir.id, offering.id, 1);
  // This will throw SOLD_OUT; check if waitlist entry still unique
  const wlCount = await prisma.waitlist.count({ where: { userId: kabir.id, offeringId: offering.id, status: "ACTIVE" } });
  check("kabir has at most one active waitlist entry", wlCount <= 1, "count=" + wlCount);

  // --- Test 6: After-cutoff cancellation does NOT promote ---
  console.log("\nCase 6: After-cutoff cancellation does not promote");
  // Fresh reset: clear all bookings and waitlist, reset quantity
  await prisma.booking.deleteMany({ where: { offeringId: offering.id } });
  await prisma.waitlist.deleteMany({ where: { offeringId: offering.id } });
  await prisma.offering.update({ where: { id: offering.id }, data: { quantityLeft: 1 } });
  const bFresh = await bookPlates(meera.id, offering.id, 1); // meera takes last plate
  if (!bFresh.ok) throw new Error("bFresh booking failed");
  // Set cutoff to past immediately
  await prisma.service.update({
    where: { id: offering.serviceId },
    data: { cutoffAt: new Date(Date.now() - 60 * 60 * 1000) },
  });
  // kabir tries to book but it's sold out -> joins waitlist
  await bookPlates(kabir.id, offering.id, 1);
  // Cancel meera's booking after cutoff
  const afterCutoffCancel = await cancelBooking(meera.id, bFresh.bookingId);
  check("cancel after cutoff does NOT restock", afterCutoffCancel.restocked === false, "restocked=" + afterCutoffCancel.restocked);
  // Waitlist entry should still be ACTIVE (not promoted)
  const afterAfterCutoff = await inspectWaitlist(offering.id, 10);
  check("waitlist entry still ACTIVE after after-cutoff cancel", afterAfterCutoff.totalActive === 1, "totalActive=" + afterAfterCutoff.totalActive);

  console.log(failures === 0 ? "\nAll waitlist checks passed." : `\n${failures} check(s) failed.`);
  process.exitCode = failures > 0 ? 1 : 0;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });