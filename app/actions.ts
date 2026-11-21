"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Role } from "@prisma/client";
import { clearSession, getCurrentUser } from "@/lib/auth";
import { bookPlates } from "@/lib/booking";
import {
  AttendanceError,
  bulkMarkNoShow,
  markNoShow,
  markServed,
} from "@/lib/attendance";

export async function signOut() {
  clearSession();
  redirect("/");
}

export async function bookPlatesAction(formData: FormData) {
  const user = await getCurrentUser();
  if (!user || user.role !== Role.STUDENT) {
    redirect("/?error=NOT_STUDENT");
  }

  const offeringId = String(formData.get("offeringId") ?? "");
  const count = Number(formData.get("count"));

  const result = await bookPlates(user.id, offeringId, count);

  revalidatePath("/");

  if (!result.ok) {
    redirect(`/?error=${result.reason}`);
  }

  redirect("/?booked=1");
}

export type AttendanceActionResult =
  | { ok: true }
  | { ok: false; error: string };

export async function markServedAction(
  bookingId: string
): Promise<AttendanceActionResult> {
  const user = await getCurrentUser();
  if (!user || user.role !== Role.KITCHEN) {
    return { ok: false, error: "Unauthorized" };
  }

  if (typeof bookingId !== "string" || !bookingId.trim()) {
    return { ok: false, error: "Invalid booking ID" };
  }

  try {
    await markServed(bookingId.trim());
    revalidatePath("/kitchen/bookings");
    return { ok: true };
  } catch (err: unknown) {
    if (err instanceof AttendanceError) {
      return { ok: false, error: err.message };
    }
    return { ok: false, error: "Failed to mark booking served. Please try again." };
  }
}

export async function markNoShowAction(
  bookingId: string
): Promise<AttendanceActionResult> {
  const user = await getCurrentUser();
  if (!user || user.role !== Role.KITCHEN) {
    return { ok: false, error: "Unauthorized" };
  }

  if (typeof bookingId !== "string" || !bookingId.trim()) {
    return { ok: false, error: "Invalid booking ID" };
  }

  try {
    await markNoShow(bookingId.trim());
    revalidatePath("/kitchen/bookings");
    return { ok: true };
  } catch (err: unknown) {
    if (err instanceof AttendanceError) {
      return { ok: false, error: err.message };
    }
    return { ok: false, error: "Failed to mark booking as no-show. Please try again." };
  }
}

export type BulkReconcileResult =
  | { ok: true; count: number }
  | { ok: false; error: string };

export async function reconcileServiceAction(
  serviceId: string
): Promise<BulkReconcileResult> {
  const user = await getCurrentUser();
  if (!user || user.role !== Role.KITCHEN) {
    return { ok: false, error: "Unauthorized" };
  }

  if (typeof serviceId !== "string" || !serviceId.trim()) {
    return { ok: false, error: "Invalid service ID" };
  }

  try {
    const updatedCount = await bulkMarkNoShow(serviceId.trim());
    revalidatePath("/kitchen/bookings");
    return { ok: true, count: updatedCount };
  } catch (err: unknown) {
    if (err instanceof AttendanceError) {
      return { ok: false, error: err.message };
    }
    return { ok: false, error: "Reconciliation failed. Please try again." };
  }
}
