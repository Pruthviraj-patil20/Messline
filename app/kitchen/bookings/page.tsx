import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { BookingStatus, Meal, Role } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { getBookingToken } from "@/lib/attendance";
import {
  KitchenCounterVerification,
  ServiceGroupData,
  BookingRowData,
} from "./counter-verification";

export const metadata: Metadata = {
  title: "Bookings | Messline",
};

export const dynamic = "force-dynamic";

// serviceDate is stored as midnight UTC of the local day (same as calendarDate in app/page.tsx)
function calendarDate(offsetDays: number) {
  const now = new Date();
  return new Date(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays)
  );
}

function mealLabel(meal: string) {
  return meal.charAt(0).toUpperCase() + meal.slice(1).toLowerCase();
}

function dateLabel(d: Date) {
  const today = calendarDate(0).getTime();
  const yesterday = calendarDate(-1).getTime();
  const tomorrow = calendarDate(1).getTime();
  const time = d.getTime();

  if (time === today) return "Today";
  if (time === yesterday) return "Yesterday";
  if (time === tomorrow) return "Tomorrow";

  return d.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

export default async function KitchenBookingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== Role.KITCHEN) redirect("/");

  const minRecentDate = calendarDate(-7);
  const maxUpcomingDate = calendarDate(1);

  // Fetch all services that either:
  // 1. Fall within the primary window: past 7 days up to tomorrow (upcoming 1 day).
  // 2. OR are older past services that still contain outstanding BOOKED bookings
  //    (ensures historical unmarked bookings are never dropped).
  const services = await prisma.service.findMany({
    where: {
      OR: [
        {
          serviceDate: {
            gte: minRecentDate,
            lte: maxUpcomingDate,
          },
        },
        {
          serviceDate: {
            lt: minRecentDate,
          },
          offerings: {
            some: {
              bookings: {
                some: {
                  status: BookingStatus.BOOKED,
                },
              },
            },
          },
        },
      ],
    },
    include: {
      offerings: {
        include: {
          menuItem: { select: { name: true } },
          bookings: {
            where: {
              status: { not: BookingStatus.CANCELLED },
            },
            include: {
              user: { select: { name: true, email: true } },
            },
            orderBy: { createdAt: "asc" },
          },
        },
      },
    },
    orderBy: [{ serviceDate: "desc" }, { meal: "desc" }],
  });

  const mealOrder: Record<Meal, number> = {
    BREAKFAST: 1,
    LUNCH: 2,
    DINNER: 3,
  };

  // Sort services chronologically: date desc, meal desc
  services.sort((a, b) => {
    const dDiff = b.serviceDate.getTime() - a.serviceDate.getTime();
    if (dDiff !== 0) return dDiff;
    return (mealOrder[b.meal] ?? 0) - (mealOrder[a.meal] ?? 0);
  });

  const now = new Date();
  const todayMidnight = calendarDate(0).getTime();

  // Determine default service:
  // 1. Look for today's service whose cutoffAt is in the future or closest to now
  // 2. Otherwise today's first service
  // 3. Otherwise the most recent service
  let defaultServiceId = "";

  const todayServices = services.filter(
    (s) => s.serviceDate.getTime() === todayMidnight
  );

  if (todayServices.length > 0) {
    const upcomingToday = todayServices.find((s) => s.cutoffAt >= now);
    if (upcomingToday) {
      defaultServiceId = upcomingToday.id;
    } else {
      defaultServiceId = todayServices[0].id;
    }
  } else if (services.length > 0) {
    defaultServiceId = services[0].id;
  }

  // Transform data for the client component
  const serviceGroups: ServiceGroupData[] = services.map((service) => {
    const isToday = service.serviceDate.getTime() === todayMidnight;
    const tabLabel = `${dateLabel(service.serviceDate)}'s ${mealLabel(service.meal)}`;

    const bookings: BookingRowData[] = [];
    for (const offering of service.offerings) {
      for (const b of offering.bookings) {
        bookings.push({
          id: b.id,
          count: b.count,
          status: b.status,
          userName: b.user.name,
          userEmail: b.user.email,
          dishName: offering.menuItem.name,
          token: getBookingToken(b.id),
        });
      }
    }

    // Sort bookings: BOOKED first (remaining in line), then SERVED, then NO_SHOW
    const statusOrder: Record<BookingStatus, number> = {
      BOOKED: 1,
      SERVED: 2,
      NO_SHOW: 3,
      CANCELLED: 4,
    };
    bookings.sort((a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9));

    return {
      id: service.id,
      meal: service.meal,
      serviceDateStr: service.serviceDate.toISOString(),
      tabLabel,
      cutoffAtStr: service.cutoffAt.toISOString(),
      isToday,
      isCutoffPassed: now >= service.cutoffAt,
      canMarkAttendance: service.serviceDate.getTime() <= todayMidnight,
      bookings,
    };
  });

  return (
    <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-900">Bookings</h1>
          <p className="mt-1 text-sm text-neutral-600">
            Counter meal verification mode and attendance tracking.
          </p>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <Link href="/kitchen" className="underline hover:text-neutral-900">
            Kitchen
          </Link>
          <Link href="/" className="underline hover:text-neutral-900">
            Home
          </Link>
        </div>
      </div>

      <KitchenCounterVerification
        services={serviceGroups}
        defaultServiceId={defaultServiceId}
      />
    </main>
  );
}
