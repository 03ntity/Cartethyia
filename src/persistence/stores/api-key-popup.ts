// Share-popup persistence: the popup lives in its own table so the auth read
// never loads it. Helpers here merge partial patch fields onto a stored row
// and write or clear the row.

import { eq } from "drizzle-orm";
import type { CartethyiaDatabase } from "../db-handle";
import { sharePopups } from "../schema";

interface PopupFields {
  readonly sharePopupEnabled?: boolean | null;
  readonly sharePopupImage?: Buffer | null;
  readonly sharePopupImageMime?: string | null;
  readonly sharePopupTitle?: string | null;
  readonly sharePopupBody?: string | null;
}

export function popupPatchTouched(patch: PopupFields): boolean {
  return (
    patch.sharePopupEnabled !== undefined ||
    patch.sharePopupImage !== undefined ||
    patch.sharePopupImageMime !== undefined ||
    patch.sharePopupTitle !== undefined ||
    patch.sharePopupBody !== undefined
  );
}

/** Merges a partial popup patch onto the stored row, so an omitted field is kept. */
export async function mergeSharePopup(
  db: CartethyiaDatabase,
  apiKeyId: string,
  patch: PopupFields,
): Promise<void> {
  const existing = await db
    .select()
    .from(sharePopups)
    .where(eq(sharePopups.apiKeyId, apiKeyId))
    .limit(1);
  const row = existing[0];
  await writeSharePopup(db, apiKeyId, {
    sharePopupEnabled: patch.sharePopupEnabled !== undefined ? patch.sharePopupEnabled : (row?.enabled ?? false),
    sharePopupImage: patch.sharePopupImage !== undefined ? patch.sharePopupImage : (row?.image ?? null),
    sharePopupImageMime: patch.sharePopupImageMime !== undefined ? patch.sharePopupImageMime : (row?.imageMime ?? null),
    sharePopupTitle: patch.sharePopupTitle !== undefined ? patch.sharePopupTitle : (row?.title ?? null),
    sharePopupBody: patch.sharePopupBody !== undefined ? patch.sharePopupBody : (row?.body ?? null),
  });
}

/** Writes the popup row, or removes it when the owner cleared every field. */
export async function writeSharePopup(
  db: CartethyiaDatabase,
  apiKeyId: string,
  fields: PopupFields,
): Promise<void> {
  const enabled = fields.sharePopupEnabled ?? false;
  const image = fields.sharePopupImage ?? null;
  const title = fields.sharePopupTitle ?? null;
  const body = fields.sharePopupBody ?? null;
  if (!enabled && image === null && title === null && body === null) {
    await db.delete(sharePopups).where(eq(sharePopups.apiKeyId, apiKeyId));
    return;
  }
  await db
    .insert(sharePopups)
    .values({
      apiKeyId,
      enabled,
      image,
      imageMime: fields.sharePopupImageMime ?? null,
      title,
      body,
    })
    .onConflictDoUpdate({
      target: sharePopups.apiKeyId,
      set: {
        enabled,
        image,
        imageMime: fields.sharePopupImageMime ?? null,
        title,
        body,
      },
    });
}
