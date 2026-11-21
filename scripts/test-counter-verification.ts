import assert from "node:assert";
import { BookingStatus, Role } from "@prisma/client";
import {
  getBookingToken,
  getStatusLabel,
  STATUS_LABELS,
  AttendanceError,
} from "../lib/attendance";
import type { BookingRowData } from "../app/kitchen/bookings/counter-verification";

console.log("Running unit & reconciliation tests for Issue #164...");

let totalTests = 0;
let passedTests = 0;

function it(desc: string, fn: () => void | Promise<void>) {
  totalTests++;
  try {
    const res = fn();
    if (res instanceof Promise) {
      throw new Error("Synchronous test expected in it()");
    }
    passedTests++;
    console.log(`  ✓ ${desc}`);
  } catch (err: any) {
    console.error(`  ✗ ${desc}:`, err.message);
  }
}

// 1. Token helper: getBookingToken
console.log("\n1. Token helper: getBookingToken");

it("returns the uppercase last 6 characters for normal CUID / IDs", () => {
  assert.strictEqual(getBookingToken("cm1234567890abcdef"), "ABCDEF");
  assert.strictEqual(getBookingToken("clzabcdef123456"), "123456");
  assert.strictEqual(getBookingToken("booking_7f2a9b"), "7F2A9B");
});

it("is deterministic for identical inputs", () => {
  const token1 = getBookingToken("abc123xyz789");
  const token2 = getBookingToken("abc123xyz789");
  assert.strictEqual(token1, "XYZ789");
  assert.strictEqual(token1, token2);
});

it("handles short or empty IDs safely without crashing", () => {
  assert.strictEqual(getBookingToken("123"), "123");
  assert.strictEqual(getBookingToken("ab"), "AB");
  assert.strictEqual(getBookingToken(""), "");
  assert.strictEqual(getBookingToken(null as any), "");
  assert.strictEqual(getBookingToken(undefined as any), "");
});

// 2. Status Badge Labels
console.log("\n2. Status Badge Labels");

it("maps raw enum values to user-friendly labels matching student bookings page", () => {
  assert.strictEqual(getStatusLabel(BookingStatus.BOOKED), "Booked");
  assert.strictEqual(getStatusLabel(BookingStatus.SERVED), "Served");
  assert.strictEqual(getStatusLabel(BookingStatus.NO_SHOW), "No-show");
  assert.strictEqual(getStatusLabel(BookingStatus.CANCELLED), "Cancelled");
  assert.strictEqual(STATUS_LABELS.NO_SHOW, "No-show");
});

// 3. Headcount Calculation Tests
console.log("\n3. Headcount calculations");

function computeHeadcount(bookings: BookingRowData[]) {
  let served = 0;
  let remaining = 0;
  let noShow = 0;

  for (const b of bookings) {
    if (b.status === BookingStatus.SERVED) {
      served++;
    } else if (b.status === BookingStatus.BOOKED) {
      remaining++;
    } else if (b.status === BookingStatus.NO_SHOW) {
      noShow++;
    }
  }

  const expected = served + remaining + noShow;
  return { expected, served, remaining, noShow };
}

const mockBookings: BookingRowData[] = [
  {
    id: "booking_100001",
    count: 2,
    status: BookingStatus.BOOKED,
    userName: "Meera Iyer",
    userEmail: "meera@messline.dev",
    dishName: "Veg thali",
    token: getBookingToken("booking_100001"),
  },
  {
    id: "booking_100002",
    count: 1,
    status: BookingStatus.SERVED,
    userName: "Kabir Shah",
    userEmail: "kabir@messline.dev",
    dishName: "Veg thali",
    token: getBookingToken("booking_100002"),
  },
  {
    id: "booking_100003",
    count: 1,
    status: BookingStatus.BOOKED,
    userName: "Aarav Patel",
    userEmail: "aarav@messline.dev",
    dishName: "Chicken biryani",
    token: getBookingToken("booking_100003"),
  },
  {
    id: "booking_100004",
    count: 1,
    status: BookingStatus.NO_SHOW,
    userName: "Rohan Verma",
    userEmail: "rohan@messline.dev",
    dishName: "Chicken biryani",
    token: getBookingToken("booking_100004"),
  },
  {
    id: "booking_100005",
    count: 1,
    status: BookingStatus.CANCELLED,
    userName: "Ananya Gupta",
    userEmail: "ananya@messline.dev",
    dishName: "Veg thali",
    token: getBookingToken("booking_100005"),
  },
];

it("calculates Expected Total as all non-cancelled bookings", () => {
  const metrics = computeHeadcount(mockBookings);
  assert.strictEqual(metrics.expected, 4);
});

it("calculates Served, Remaining in Line, and No-Shows accurately", () => {
  const metrics = computeHeadcount(mockBookings);
  assert.strictEqual(metrics.served, 1);
  assert.strictEqual(metrics.remaining, 2);
  assert.strictEqual(metrics.noShow, 1);
});

// 4. Search Filtering Tests
console.log("\n4. Real-time Search filtering");

function filterBookings(bookings: BookingRowData[], searchQuery: string): BookingRowData[] {
  const query = searchQuery.trim().toLowerCase();
  if (!query) return bookings;

  return bookings.filter((b) => {
    const matchName = b.userName.toLowerCase().includes(query);
    const matchEmail = b.userEmail.toLowerCase().includes(query);
    const matchToken = b.token.toLowerCase().includes(query);
    return matchName || matchEmail || matchToken;
  });
}

it("filters by student name (case-insensitive and partial)", () => {
  const results = filterBookings(mockBookings, "meera");
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].userName, "Meera Iyer");

  const resultsPartial = filterBookings(mockBookings, "  KAB  ");
  assert.strictEqual(resultsPartial.length, 1);
  assert.strictEqual(resultsPartial[0].userName, "Kabir Shah");
});

it("filters by student email (case-insensitive and partial)", () => {
  const results = filterBookings(mockBookings, "aarav@messline.dev");
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].id, "booking_100003");

  const resultsDomain = filterBookings(mockBookings, "@messline.dev");
  assert.strictEqual(resultsDomain.length, 5);
});

it("filters by 6-character verification token", () => {
  const token = getBookingToken("booking_100001");
  assert.strictEqual(token, "100001");

  const results = filterBookings(mockBookings, "100001");
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].userName, "Meera Iyer");

  const resultsPartial = filterBookings(mockBookings, "00002");
  assert.strictEqual(resultsPartial.length, 1);
  assert.strictEqual(resultsPartial[0].userName, "Kabir Shah");
});

it("returns empty array when no matches are found", () => {
  const results = filterBookings(mockBookings, "nonexistent student or token");
  assert.strictEqual(results.length, 0);
});

it("preserves total service headcount when search filters visible items", () => {
  const filtered = filterBookings(mockBookings, "meera");
  assert.strictEqual(filtered.length, 1);

  const serviceHeadcount = computeHeadcount(mockBookings);
  assert.strictEqual(serviceHeadcount.expected, 4);
  assert.strictEqual(serviceHeadcount.served, 1);
  assert.strictEqual(serviceHeadcount.remaining, 2);
  assert.strictEqual(serviceHeadcount.noShow, 1);
});

// 5. Service Grouping & Default Selection Tests
console.log("\n5. Service grouping & default selection");

function selectDefaultService(
  services: { id: string; serviceDate: Date; cutoffAt: Date }[],
  now: Date
): string {
  const todayDate = new Date(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  ).getTime();

  const todayServices = services.filter(
    (s) => s.serviceDate.getTime() === todayDate
  );

  if (todayServices.length > 0) {
    const active = todayServices.find((s) => s.cutoffAt >= now);
    if (active) return active.id;
    return todayServices[0].id;
  }
  return services[0]?.id ?? "";
}

it("selects today's active service when cutoff is upcoming", () => {
  const now = new Date("2026-11-16T12:00:00Z");
  const today = new Date(Date.UTC(2026, 10, 16));
  const yesterday = new Date(Date.UTC(2026, 10, 15));

  const services = [
    { id: "srv_today_lunch", serviceDate: today, cutoffAt: new Date("2026-11-16T13:00:00Z") },
    { id: "srv_today_breakfast", serviceDate: today, cutoffAt: new Date("2026-11-16T09:00:00Z") },
    { id: "srv_yesterday_dinner", serviceDate: yesterday, cutoffAt: new Date("2026-11-15T20:00:00Z") },
  ];

  const defaultId = selectDefaultService(services, now);
  assert.strictEqual(defaultId, "srv_today_lunch");
});

it("falls back to the most recent service when today has no active cutoff", () => {
  const now = new Date("2026-11-16T22:00:00Z");
  const today = new Date(Date.UTC(2026, 10, 16));

  const services = [
    { id: "srv_today_dinner", serviceDate: today, cutoffAt: new Date("2026-11-16T20:00:00Z") },
    { id: "srv_today_lunch", serviceDate: today, cutoffAt: new Date("2026-11-16T13:00:00Z") },
  ];

  const defaultId = selectDefaultService(services, now);
  assert.strictEqual(defaultId, "srv_today_dinner");
});

it("handles empty services list gracefully", () => {
  const defaultId = selectDefaultService([], new Date());
  assert.strictEqual(defaultId, "");
});

// 6. Individual Mark Served & No-Show with Service Date Restriction
console.log("\n6. Individual Mark Served & No-Show (Service Date Restriction)");

function simulateIndividualAction(
  booking: BookingRowData,
  serviceDate: Date,
  today: Date,
  userRole: Role | null,
  action: "SERVED" | "NO_SHOW"
): { ok: boolean; error?: string; updatedStatus?: BookingStatus } {
  if (!userRole || userRole !== Role.KITCHEN) {
    return { ok: false, error: "Unauthorized" };
  }
  if (booking.status !== BookingStatus.BOOKED) {
    return { ok: false, error: "Cannot mark: booking not found or already finalized" };
  }
  if (serviceDate.getTime() > today.getTime()) {
    return { ok: false, error: "Cannot mark: service is in the future" };
  }
  return {
    ok: true,
    updatedStatus: action === "SERVED" ? BookingStatus.SERVED : BookingStatus.NO_SHOW,
  };
}

it("allows marking served for today's service", () => {
  const today = new Date(Date.UTC(2026, 10, 16));
  const res = simulateIndividualAction(mockBookings[0], today, today, Role.KITCHEN, "SERVED");
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.updatedStatus, BookingStatus.SERVED);
});

it("allows marking served for past service", () => {
  const today = new Date(Date.UTC(2026, 10, 16));
  const yesterday = new Date(Date.UTC(2026, 10, 15));
  const res = simulateIndividualAction(mockBookings[0], yesterday, today, Role.KITCHEN, "SERVED");
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.updatedStatus, BookingStatus.SERVED);
});

it("rejects marking served for future service (tomorrow)", () => {
  const today = new Date(Date.UTC(2026, 10, 16));
  const tomorrow = new Date(Date.UTC(2026, 10, 17));
  const res = simulateIndividualAction(mockBookings[0], tomorrow, today, Role.KITCHEN, "SERVED");
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, "Cannot mark: service is in the future");
});

it("allows marking individual no-show for today or past service", () => {
  const today = new Date(Date.UTC(2026, 10, 16));
  const res = simulateIndividualAction(mockBookings[0], today, today, Role.KITCHEN, "NO_SHOW");
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.updatedStatus, BookingStatus.NO_SHOW);
});

it("rejects individual no-show for future service", () => {
  const today = new Date(Date.UTC(2026, 10, 16));
  const tomorrow = new Date(Date.UTC(2026, 10, 17));
  const res = simulateIndividualAction(mockBookings[0], tomorrow, today, Role.KITCHEN, "NO_SHOW");
  assert.strictEqual(res.ok, false);
});

it("prevents overwriting already served or cancelled bookings individually", () => {
  const today = new Date(Date.UTC(2026, 10, 16));
  const servedBooking = mockBookings[1]; // SERVED
  const cancelledBooking = mockBookings[4]; // CANCELLED

  const resServed = simulateIndividualAction(servedBooking, today, today, Role.KITCHEN, "SERVED");
  assert.strictEqual(resServed.ok, false);

  const resCancelled = simulateIndividualAction(cancelledBooking, today, today, Role.KITCHEN, "NO_SHOW");
  assert.strictEqual(resCancelled.ok, false);
});

it("rejects unauthenticated or student users from individual attendance actions", () => {
  const today = new Date(Date.UTC(2026, 10, 16));
  const resStudent = simulateIndividualAction(mockBookings[0], today, today, Role.STUDENT, "SERVED");
  assert.strictEqual(resStudent.ok, false);
  assert.strictEqual(resStudent.error, "Unauthorized");

  const resAnon = simulateIndividualAction(mockBookings[0], today, today, null, "NO_SHOW");
  assert.strictEqual(resAnon.ok, false);
  assert.strictEqual(resAnon.error, "Unauthorized");
});

// 7. Bulk Reconciliation Simulation & State Invariants
console.log("\n7. Bulk Reconciliation Simulation & State Invariants");

function simulateReconciliation(
  bookings: BookingRowData[],
  cutoffAt: Date,
  now: Date,
  userRole: Role | null
): { ok: boolean; count?: number; error?: string; updatedBookings: BookingRowData[] } {
  if (!userRole || userRole !== Role.KITCHEN) {
    return { ok: false, error: "Unauthorized", updatedBookings: bookings };
  }

  if (now < cutoffAt) {
    return { ok: false, error: "Service cutoff has not passed yet", updatedBookings: bookings };
  }

  let count = 0;
  const updatedBookings = bookings.map((b) => {
    if (b.status === BookingStatus.BOOKED) {
      count++;
      return { ...b, status: BookingStatus.NO_SHOW };
    }
    return b;
  });

  return { ok: true, count, updatedBookings };
}

it("reconciles only BOOKED records to NO_SHOW after cutoff", () => {
  const pastCutoff = new Date("2026-11-16T12:00:00Z");
  const now = new Date("2026-11-16T13:00:00Z");

  const res = simulateReconciliation(mockBookings, pastCutoff, now, Role.KITCHEN);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.count, 2);

  const reconciled = res.updatedBookings;
  assert.strictEqual(reconciled.find((b) => b.id === "booking_100001")?.status, BookingStatus.NO_SHOW);
  assert.strictEqual(reconciled.find((b) => b.id === "booking_100003")?.status, BookingStatus.NO_SHOW);
  assert.strictEqual(reconciled.find((b) => b.id === "booking_100002")?.status, BookingStatus.SERVED);
  assert.strictEqual(reconciled.find((b) => b.id === "booking_100005")?.status, BookingStatus.CANCELLED);
  assert.strictEqual(reconciled.find((b) => b.id === "booking_100004")?.status, BookingStatus.NO_SHOW);
});

it("rejects reconciliation before cutoff time", () => {
  const futureCutoff = new Date("2026-11-16T15:00:00Z");
  const now = new Date("2026-11-16T13:00:00Z");

  const res = simulateReconciliation(mockBookings, futureCutoff, now, Role.KITCHEN);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, "Service cutoff has not passed yet");
  assert.deepStrictEqual(res.updatedBookings, mockBookings);
});

it("rejects reconciliation by non-kitchen or unauthenticated users", () => {
  const pastCutoff = new Date("2026-11-16T12:00:00Z");
  const now = new Date("2026-11-16T13:00:00Z");

  const resStudent = simulateReconciliation(mockBookings, pastCutoff, now, Role.STUDENT);
  assert.strictEqual(resStudent.ok, false);
  assert.strictEqual(resStudent.error, "Unauthorized");

  const resAnon = simulateReconciliation(mockBookings, pastCutoff, now, null);
  assert.strictEqual(resAnon.ok, false);
  assert.strictEqual(resAnon.error, "Unauthorized");
});

it("is idempotent: repeated reconciliation results in 0 count and does not overwrite", () => {
  const pastCutoff = new Date("2026-11-16T12:00:00Z");
  const now = new Date("2026-11-16T13:00:00Z");

  const firstPass = simulateReconciliation(mockBookings, pastCutoff, now, Role.KITCHEN);
  assert.strictEqual(firstPass.count, 2);

  const secondPass = simulateReconciliation(firstPass.updatedBookings, pastCutoff, now, Role.KITCHEN);
  assert.strictEqual(secondPass.count, 0);
  assert.deepStrictEqual(secondPass.updatedBookings, firstPass.updatedBookings);
});

it("updates headcount immediately after reconciliation while keeping Expected Total unchanged", () => {
  const pastCutoff = new Date("2026-11-16T12:00:00Z");
  const now = new Date("2026-11-16T13:00:00Z");

  const beforeMetrics = computeHeadcount(mockBookings);
  assert.strictEqual(beforeMetrics.expected, 4);
  assert.strictEqual(beforeMetrics.served, 1);
  assert.strictEqual(beforeMetrics.remaining, 2);
  assert.strictEqual(beforeMetrics.noShow, 1);

  const res = simulateReconciliation(mockBookings, pastCutoff, now, Role.KITCHEN);
  const afterMetrics = computeHeadcount(res.updatedBookings);

  assert.strictEqual(afterMetrics.expected, 4);
  assert.strictEqual(afterMetrics.served, 1);
  assert.strictEqual(afterMetrics.remaining, 0);
  assert.strictEqual(afterMetrics.noShow, 3);
});

it("preserves search functionality on reconciled bookings", () => {
  const pastCutoff = new Date("2026-11-16T12:00:00Z");
  const now = new Date("2026-11-16T13:00:00Z");

  const res = simulateReconciliation(mockBookings, pastCutoff, now, Role.KITCHEN);
  const results = filterBookings(res.updatedBookings, "meera");

  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].status, BookingStatus.NO_SHOW);
});

// 8. Error Sanitization Tests
console.log("\n8. Error Sanitization");

function handleServerError(err: unknown, defaultMessage: string): string {
  if (err instanceof AttendanceError) {
    return err.message;
  }
  return defaultMessage;
}

it("exposes intentional AttendanceError messages directly", () => {
  const appErr = new AttendanceError("Cannot mark served: booking not found, already finalized, or service is in the future");
  const msg = handleServerError(appErr, "Failed to mark booking served. Please try again.");
  assert.strictEqual(msg, "Cannot mark served: booking not found, already finalized, or service is in the future");
});

it("sanitizes Prisma or database exceptions to generic safe message", () => {
  const dbErr = new Error("Invalid `prisma.booking.updateMany()` invocation: SELECT clock_timestamp() failed. Table Booking does not exist.");
  const msg = handleServerError(dbErr, "Failed to mark booking served. Please try again.");
  assert.strictEqual(msg, "Failed to mark booking served. Please try again.");
  assert.strictEqual(msg.includes("SELECT"), false);
  assert.strictEqual(msg.includes("prisma"), false);
});

console.log(`\nResults: ${passedTests}/${totalTests} tests passed.`);
if (passedTests !== totalTests) {
  process.exit(1);
}
