"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Role } from "@prisma/client";
import { getCurrentUser } from "@/lib/auth";
import { bookPlates } from "@/lib/booking";
import { bulkMarkNoShow, markServed } from "@/lib/attendance";

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

export type MarkServedResult =
  | { ok: true }
  | { ok: false; error: string };

export async function markServedAction(
  bookingId: string
): Promise<MarkServedResult> {
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
    const message =
      err instanceof Error ? err.message : "Failed to mark booking served";
    return { ok: false, error: message };
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
    const message = err instanceof Error ? err.message : "Reconciliation failed";
    return { ok: false, error: message };
  }
}
