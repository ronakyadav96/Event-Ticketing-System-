import { Injectable } from '@angular/core';

export type PromotionKind = 'coupon' | 'gift';
export type PromotionDiscountType = 'percent' | 'flat';
export type PromotionScope = 'event' | 'platform';

export interface PromotionRecord {
  id: string;
  title: string;
  code: string;
  kind: PromotionKind;
  scope: PromotionScope;
  discountType: PromotionDiscountType;
  discountValue: number;
  eventId: string | null;
  eventTitle: string;
  description: string;
  expiryDate: string;
  maxClaims: number;
  active: boolean;
  createdAt: string;
  createdById: string;
  createdByName: string;
  createdByRole: string;
  claimedBy: string[];
  usedBy: string[];
}

export interface PromotionCreateInput {
  title: string;
  code: string;
  kind: PromotionKind;
  scope?: PromotionScope;
  discountType: PromotionDiscountType;
  discountValue: number;
  eventId?: string | null;
  eventTitle?: string;
  description?: string;
  expiryDate?: string;
  maxClaims?: number;
}

@Injectable({
  providedIn: 'root'
})
export class PromotionService {
  private readonly storageKey = 'event-ticketing-promotions-v1';

  createPromotion(input: PromotionCreateInput, user: any): PromotionRecord {
    const list = this.readAll();
    const record: PromotionRecord = {
      id: this.makeId(),
      title: String(input.title || '').trim(),
      code: String(input.code || '').trim().toUpperCase(),
      kind: input.kind,
      scope: input.scope || 'event',
      discountType: input.discountType,
      discountValue: Math.max(0, Number(input.discountValue || 0)),
      eventId: input.scope === 'platform' ? null : String(input.eventId || '').trim() || null,
      eventTitle: input.scope === 'platform' ? 'All events' : String(input.eventTitle || '').trim(),
      description: String(input.description || '').trim(),
      expiryDate: String(input.expiryDate || '').trim(),
      maxClaims: Math.max(1, Number(input.maxClaims || 1)),
      active: true,
      createdAt: new Date().toISOString(),
      createdById: this.userIdOf(user),
      createdByName: String(user?.name || 'Unknown'),
      createdByRole: String(user?.role || 'creator'),
      claimedBy: [],
      usedBy: [],
    };

    list.unshift(record);
    this.writeAll(list);
    return record;
  }

  listAll(): PromotionRecord[] {
    return this.readAll();
  }

  listByCreator(user: any): PromotionRecord[] {
    const uid = this.userIdOf(user);
    return this.readAll().filter((item) => item.createdById === uid);
  }

  listClaimableForUser(user: any, eventId?: string | null): PromotionRecord[] {
    const uid = this.userIdOf(user);
    return this.readAll().filter((item) => {
      if (!this.isPromotionActive(item)) return false;
      if (!this.matchesEvent(item, eventId)) return false;
      if (item.usedBy.includes(uid)) return false;
      if (item.claimedBy.includes(uid)) return false;
      return item.claimedBy.length < item.maxClaims;
    });
  }

  listClaimedForUser(user: any, eventId?: string | null): PromotionRecord[] {
    const uid = this.userIdOf(user);
    return this.readAll().filter((item) => {
      if (!this.isPromotionActive(item)) return false;
      if (!this.matchesEvent(item, eventId)) return false;
      if (item.usedBy.includes(uid)) return false;
      return item.claimedBy.includes(uid);
    });
  }

  deletePromotion(id: string, user: any): { ok: boolean; message: string } {
    const uid = this.userIdOf(user);
    const role = String(user?.role || '');
    const list = this.readAll();
    const item = list.find((entry) => entry.id === id);

    if (!item) {
      return { ok: false, message: 'Offer not found.' };
    }

    const canDelete = role === 'superadmin' || item.createdById === uid;
    if (!canDelete) {
      return { ok: false, message: 'You are not allowed to delete this offer.' };
    }

    this.writeAll(list.filter((entry) => entry.id !== id));
    return { ok: true, message: `${item.code} deleted successfully.` };
  }

  claimPromotion(id: string, user: any): { ok: boolean; message: string; promotion?: PromotionRecord } {
    const uid = this.userIdOf(user);
    const list = this.readAll();
    const index = list.findIndex((item) => item.id === id);
    if (index < 0) return { ok: false, message: 'Offer not found.' };

    const item = list[index];
    if (!this.isPromotionActive(item)) return { ok: false, message: 'Offer is no longer active.' };
    if (item.usedBy.includes(uid)) return { ok: false, message: 'Offer already used.' };
    if (item.claimedBy.includes(uid)) return { ok: false, message: 'Offer already claimed.' };
    if (item.claimedBy.length >= item.maxClaims) return { ok: false, message: 'Claim limit reached.' };

    item.claimedBy = [...item.claimedBy, uid];
    list[index] = item;
    this.writeAll(list);
    return { ok: true, message: `${item.code} claimed successfully.`, promotion: item };
  }

  consumePromotion(id: string, user: any): { ok: boolean; message: string; promotion?: PromotionRecord } {
    const uid = this.userIdOf(user);
    const list = this.readAll();
    const index = list.findIndex((item) => item.id === id);
    if (index < 0) return { ok: false, message: 'Offer not found.' };

    const item = list[index];
    if (!this.isPromotionActive(item)) return { ok: false, message: 'Offer is no longer active.' };
    if (!item.claimedBy.includes(uid)) return { ok: false, message: 'Claim this offer before using it.' };
    if (item.usedBy.includes(uid)) return { ok: false, message: 'Offer already used.' };

    item.usedBy = [...item.usedBy, uid];
    item.active = item.usedBy.length >= item.maxClaims ? false : item.active;
    list[index] = item;
    this.writeAll(list);
    return { ok: true, message: `${item.code} used successfully.`, promotion: item };
  }

  calculateDiscount(subtotal: number, promotion: PromotionRecord | null | undefined): number {
    const safeSubtotal = Math.max(0, Number(subtotal || 0));
    if (!promotion || safeSubtotal <= 0 || !this.isPromotionActive(promotion)) return 0;

    let discount = 0;
    if (promotion.discountType === 'percent') {
      discount = Math.round((safeSubtotal * promotion.discountValue) / 100);
    } else {
      discount = Math.round(promotion.discountValue);
    }

    return Math.max(0, Math.min(safeSubtotal, discount));
  }

  describePromotion(item: PromotionRecord): string {
    const value = item.discountType === 'percent'
      ? `${item.discountValue}% off`
      : `Rs ${item.discountValue} off`;
    const target = item.scope === 'platform' ? 'All events' : (item.eventTitle || 'Selected event');
    return `${value} • ${target}`;
  }

  private matchesEvent(item: PromotionRecord, eventId?: string | null): boolean {
    if (item.scope === 'platform') return true;
    return !!eventId && item.eventId === String(eventId);
  }

  private isPromotionActive(item: PromotionRecord): boolean {
    if (!item.active) return false;
    if (!item.expiryDate) return true;
    const expiry = new Date(`${item.expiryDate}T23:59:59`);
    return !Number.isNaN(expiry.getTime()) && expiry.getTime() >= Date.now();
  }

  private userIdOf(user: any): string {
    return String(user?.id || user?._id || user?.email || 'anonymous');
  }

  private makeId(): string {
    return `promo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  private readAll(): PromotionRecord[] {
    if (typeof localStorage === 'undefined') return [];
    try {
      const raw = localStorage.getItem(this.storageKey);
      const list = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(list)) return [];
      return list.map((item) => ({
        ...item,
        claimedBy: Array.isArray(item?.claimedBy) ? item.claimedBy : [],
        usedBy: Array.isArray(item?.usedBy) ? item.usedBy : [],
      }));
    } catch {
      return [];
    }
  }

  private writeAll(list: PromotionRecord[]): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(this.storageKey, JSON.stringify(list));
  }
}
