import { Component, OnInit, ChangeDetectorRef, inject, ElementRef, ViewChild, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { QRCodeComponent } from 'angularx-qrcode';
import { BookingService } from '../../services/booking.service';

@Component({
  standalone: true,
  selector: 'app-booking-history',
  imports: [CommonModule, RouterLink, QRCodeComponent],
  templateUrl: './booking-history.component.html',
  styleUrls: ['./booking-history.component.css']
})
export class BookingHistoryComponent implements OnInit, OnDestroy {
  private bs = inject(BookingService);
  private cdr = inject(ChangeDetectorRef);

  bookings: any[] = [];
  loading = true;
  loadingMore = false;
  error = '';
  cancellingId: string | null = null;
  cancelMessage: Record<string, string> = {};

  private page = 1;
  private readonly pageSize = 10;
  hasMore = true;
  private observer?: IntersectionObserver;

  @ViewChild('sentinel') set sentinelRef(el: ElementRef<HTMLDivElement> | undefined) {
    if (!el) return;
    this.setupObserver(el.nativeElement);
  }

  ngOnInit(): void {
    this.fetchBookings(true);
  }

  fetchBookings(reset = false): void {
    if (!reset && (!this.hasMore || this.loadingMore)) return;

    if (reset) {
      this.page = 1;
      this.hasMore = true;
      this.bookings = [];
      this.loading = true;
    } else {
      this.loadingMore = true;
    }

    this.error = '';

    // Uses GET /api/bookings with pagination; backend auto-scopes to current user if not admin.
    this.bs.getAllBookings({ page: this.page, limit: this.pageSize }).subscribe({
      next: (res: any) => {
        const list = Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : []);
        this.bookings = reset ? list : [...this.bookings, ...list];

        const totalPages = Number(res?.totalPages) || 1;
        const currentPage = Number(res?.page) || this.page;
        this.hasMore = currentPage < totalPages && list.length > 0;
        this.page = currentPage + 1;

        this.cdr.detectChanges();
      },
      error: (err: any) => {
        this.error = err?.error?.message || err?.message || 'Unable to load booking history.';
        console.error('getAllBookings (history) error:', err);
        this.cdr.detectChanges();
      },
      complete: () => {
        this.loading = false;
        this.loadingMore = false;
        this.cdr.detectChanges();
      },
    });
  }

  /** Only paid bookings for future shows can be cancelled; the server applies the policy. */
  canCancel(b: any): boolean {
    if (String(b?.paymentStatus || '').toUpperCase() !== 'PAID') return false;
    const showAt = new Date(b?.showAt || b?.event?.date || 0).getTime();
    return showAt > Date.now();
  }

  statusLabel(b: any): string | null {
    const s = String(b?.paymentStatus || '').toUpperCase();
    if (s === 'REFUNDED') return 'Refunded';
    if (s === 'REFUND_PROCESSING') return 'Refund processing';
    if (s === 'CANCELLED') return 'Cancelled';
    return null;
  }

  cancelBooking(b: any): void {
    const id = String(b?._id || '');
    if (!id || this.cancellingId) return;
    this.cancellingId = id;
    this.cancelMessage[id] = '';

    this.bs.getRefundQuote(id).subscribe({
      next: ({ quote }) => {
        if (!quote?.eligible) {
          this.cancelMessage[id] = quote?.reason || 'This booking cannot be cancelled.';
          this.cancellingId = null;
          this.cdr.detectChanges();
          return;
        }

        const amount = (quote.refundAmount / 100).toLocaleString('en-IN', {
          style: 'currency',
          currency: (quote.currency || 'inr').toUpperCase(),
        });
        const ok = window.confirm(
          `Cancel this booking?\n\nYou will get a ${quote.refundPercent}% refund (${amount}). This cannot be undone.`
        );
        if (!ok) {
          this.cancellingId = null;
          this.cdr.detectChanges();
          return;
        }

        this.bs.cancelAndRefund(id).subscribe({
          next: (res) => {
            b.paymentStatus = res?.booking?.paymentStatus || res?.status || 'CANCELLED';
            this.cancelMessage[id] = res?.booking?.refundAmount
              ? `Booking cancelled. ${amount} will be refunded to your card.`
              : 'Booking cancelled.';
            this.cancellingId = null;
            this.cdr.detectChanges();
          },
          error: (err) => {
            this.cancelMessage[id] = err?.error?.message || 'Cancellation failed. Your booking is unchanged.';
            this.cancellingId = null;
            this.cdr.detectChanges();
          },
        });
      },
      error: (err) => {
        this.cancelMessage[id] = err?.error?.message || 'Could not check the refund policy. Please try again.';
        this.cancellingId = null;
        this.cdr.detectChanges();
      },
    });
  }

  private getBookingTime(b: any) {
    const d = new Date(b?.event?.date || b?.createdAt || 0).getTime();
    return isNaN(d) ? 0 : d;
  }

  getRegistrationTemplateLabel(template: string): string {
    if (template === 'workshop') return 'Workshop Form';
    if (template === 'seminar') return 'Seminar Form';
    return 'Standard Registration';
  }

  getRegistrationItems(b: any): Array<{ label: string; value: string }> {
    const data = b?.registrationData || {};
    const items: Array<{ label: string; value: string }> = [];

    const baseFields = ['phone', 'experience', 'skillLevel', 'company', 'designation'];
    baseFields.forEach((key) => {
      if (data[key]) {
        items.push({ label: this.toLabel(key), value: String(data[key]) });
      }
    });

    const custom = data?.customFields || {};
    Object.keys(custom).forEach((k) => {
      const val = custom[k];
      if (val === undefined || val === null || String(val).trim() === '') return;
      items.push({ label: this.toLabel(k), value: String(val) });
    });

    return items.length ? items : [{ label: 'Details', value: 'Not provided' }];
  }

  private toLabel(key: string): string {
    return key
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  private setupObserver(target: HTMLDivElement) {
    if (this.observer) this.observer.disconnect();

    this.observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          this.fetchBookings(false);
        }
      },
      { rootMargin: '200px 0px', threshold: 0.1 }
    );

    this.observer.observe(target);
  }

  ngOnDestroy(): void {
    if (this.observer) this.observer.disconnect();
  }
}
