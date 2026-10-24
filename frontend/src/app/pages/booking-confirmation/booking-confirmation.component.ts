import { Component, OnInit, ChangeDetectorRef, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { CommonModule } from '@angular/common';
import { QRCodeComponent } from 'angularx-qrcode';
import { BookingService } from '../../services/booking.service';
import { finalize, take } from 'rxjs/operators';
import { AuthService } from '../../auth/auth.service';
import { PromotionService } from '../../services/promotion.service';

@Component({
  standalone: true,
  selector: 'app-booking-confirmation',
  imports: [CommonModule, QRCodeComponent],
  templateUrl: './booking-confirmation.component.html',
  styleUrls: ['./booking-confirmation.component.css'],
})
export class BookingConfirmationComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private bs = inject(BookingService);
  private cdr = inject(ChangeDetectorRef);
  private auth = inject(AuthService);
  private promotionService = inject(PromotionService);

  booking: any = null;
  ticketId = '';
  qrData = '';

  loading = true;
  error = '';

  get eventTitle(): string {
    return this.booking?.event?.title || this.booking?.eventTitle || 'Event Ticket';
  }

  get eventDateTime(): string {
    return this.booking?.showAt || this.booking?.event?.date || this.booking?.eventDate || this.booking?.createdAt || '';
  }

  get venueLabel(): string {
    return this.booking?.event?.venue || this.booking?.eventVenue || 'Venue to be announced';
  }

  get attendeeName(): string {
    return this.booking?.name || this.booking?.user?.name || '-';
  }

  get attendeeEmail(): string {
    return this.booking?.email || this.booking?.user?.email || '-';
  }

  get seatLabel(): string {
    return String(this.booking?.seats ?? this.booking?.seatCount ?? '-');
  }

  get paymentStatusLabel(): string {
    const raw = String(this.booking?.paymentStatus || 'confirmed');
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  }

  get finalAmountLabel(): string {
    const amount = Number(this.booking?.finalAmount ?? this.booking?.amount ?? this.booking?.totalAmount ?? 0);
    return amount > 0 ? `Rs ${amount}` : 'Free';
  }

  ngOnInit(): void {
    const tid = this.route.snapshot.paramMap.get('ticketId');

    if (!tid) {
      this.loading = false;
      this.error = 'TicketId missing in URL.';
      return;
    }

    this.ticketId = tid;
    this.loading = true;
    this.error = '';
    this.booking = null;

    this.bs.getByTicketId(tid)
      .pipe(
        take(1),
        finalize(() => {
          this.loading = false;
          this.cdr.detectChanges();
        })
      )
      .subscribe({
        next: (res: any) => {
          this.booking = res?.booking ?? res?.data ?? res;
          this.consumeBookingPromotion(this.booking);
          this.qrData = String(this.booking?.ticketId || tid);
          this.saveDownloadedTicket(this.booking, tid);
          this.cdr.detectChanges();
        },
        error: (err: any) => {
          this.error =
            err?.error?.message ||
            err?.message ||
            'Booking not found / unauthorized.';
          console.error('getByTicketId error:', err);
          this.cdr.detectChanges();
        }
      });
  }

  private getDownloadsKey(): string {
    const user = this.auth.getUser();
    const id = user?.id || user?._id || user?.email || 'guest';
    return `downloadedTickets:${id}`;
  }

  private saveDownloadedTicket(booking: any, fallbackTicketId: string): void {
    const ticketId = booking?.ticketId || fallbackTicketId;
    if (!ticketId) {
      return;
    }

    const ticket = {
      ticketId,
      event: {
        title: booking?.event?.title || booking?.eventTitle || 'Event Ticket',
        date: booking?.event?.date || booking?.eventDate || booking?.createdAt || new Date().toISOString(),
        venue: booking?.event?.venue || booking?.eventVenue || '-'
      },
      seats: booking?.seats ?? booking?.seatCount ?? '-',
      name: booking?.name || booking?.user?.name || '-',
      email: booking?.email || booking?.user?.email || '-',
      createdAt: booking?.createdAt || new Date().toISOString()
    };

    const key = this.getDownloadsKey();
    let list: any[] = [];

    try {
      const raw = localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : [];
      list = Array.isArray(parsed) ? parsed : [];
    } catch {
      list = [];
    }

    const existingIndex = list.findIndex((t) => t?.ticketId === ticketId);
    if (existingIndex >= 0) {
      list[existingIndex] = { ...list[existingIndex], ...ticket };
    } else {
      list.unshift(ticket);
    }

    localStorage.setItem(key, JSON.stringify(list));
  }

  private consumeBookingPromotion(booking: any): void {
    const promotionId = booking?.promotionId || booking?.promotion?._id || booking?.promotion?.id || null;
    const user = this.auth.getUser();
    if (!promotionId || !user) return;
    this.promotionService.consumePromotion(String(promotionId), user);
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

    return items;
  }

  private toLabel(key: string): string {
    return key
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }
}
