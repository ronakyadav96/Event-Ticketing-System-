import { Component, OnInit, inject } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { EventService } from '../../services/event.service';
import { BookingService } from '../../services/booking.service';
import { AuthService } from '../../auth/auth.service';
import { PromotionRecord, PromotionService } from '../../services/promotion.service';
import { SeatPickerComponent } from '../../shared/seat-picker/seat-picker.component';
import { ShowtimeSelectorComponent } from '../../shared/showtime-selector/showtime-selector.component';

export interface FnbItem {
  id: string;
  name: string;
  category: 'Combos' | 'Snacks' | 'Beverages';
  price: number;
  image: string;
  icon: string;
}

@Component({
  standalone: true,
  selector: 'app-booking-page',
  imports: [
    CommonModule,
    FormsModule,
    RouterModule,
    DatePipe,
    SeatPickerComponent,
    ShowtimeSelectorComponent,
  ],
  templateUrl: './booking-page.component.html',
  styleUrls: ['./booking-page.component.css'],
})
export class BookingPageComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private es = inject(EventService);
  private bs = inject(BookingService);
  private auth = inject(AuthService);
  private promotionService = inject(PromotionService);

  eventId = '';
  event: any = null;
  loading = true;
  error = '';
  submitting = false;
  msg = '';

  // Stepper: 1: Showtimes, 2: Seats, 3: Snacks, 4: Checkout
  currentStep = 1;

  selectedShowDate = '';
  selectedShowTime = '';
  selectedHallName = '';
  selectedSeatIds: string[] = [];
  seatsCount = 1;

  name = '';
  email = '';
  phone = '';

  // Food & Beverages
  readonly fnbCatalog: FnbItem[] = [
    { id: 'fnb1', name: 'Caramel Popcorn + Coke Combo', category: 'Combos', price: 340, image: '', icon: '🍿' },
    { id: 'fnb2', name: 'Salted Large Popcorn', category: 'Snacks', price: 260, image: '', icon: '🍿' },
    { id: 'fnb3', name: 'Cheesy Nachos with Salsa', category: 'Snacks', price: 220, image: '', icon: '🧀' },
    { id: 'fnb4', name: 'Chilled Pepsi 500ml', category: 'Beverages', price: 150, image: '', icon: '🥤' },
  ];

  fnbQuantities: Record<string, number> = {};

  // Promotions
  claimablePromotions: PromotionRecord[] = [];
  claimedPromotions: PromotionRecord[] = [];
  selectedPromotionId = '';

  // Calendar State
  calYear = new Date().getFullYear();
  calMonth = new Date().getMonth();
  calHour = 10;
  calMinute = 0;
  calAmPm: 'AM' | 'PM' = 'AM';
  readonly calDayNames = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  readonly calHours = Array.from({ length: 12 }, (_, i) => i + 1);
  readonly calMinutes = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

  padTwo(n: number): string { return String(n).padStart(2, '0'); }

  get currentUser() { return this.auth.getUser(); }

  ngOnInit(): void {
    this.eventId = this.route.snapshot.paramMap.get('eventId') || '';
    if (!this.eventId) {
      this.error = 'Invalid event ID';
      this.loading = false;
      return;
    }

    // Prefill user details if logged in
    const user = this.currentUser;
    if (user) {
      this.name = user.name || '';
      this.email = user.email || '';
    }

    // Initialize calendar to today
    const now = new Date();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    this.selectedShowDate = `${now.getFullYear()}-${m}-${d}`;
    this.selectedShowTime = '10:00';

    this.loadEventDetails();
  }

  loadEventDetails(): void {
    this.loading = true;
    this.es.getEventById(this.eventId).subscribe({
      next: (res: any) => {
        this.event = res?.event || res;
        this.loading = false;
        this.refreshPromotions();
      },
      error: (err: any) => {
        this.error = err?.error?.message || 'Failed to load event details.';
        this.loading = false;
      },
    });
  }

  // Stepper Controls
  setStep(step: number): void {
    if (step < 1 || step > 4) return;
    this.currentStep = step;
  }

  nextStep(): void {
    if (this.currentStep < 4) this.currentStep++;
  }

  prevStep(): void {
    if (this.currentStep > 1) this.currentStep--;
  }

  // F&B Quantity Handlers
  updateFnbQty(id: string, delta: number): void {
    const cur = this.fnbQuantities[id] || 0;
    const next = Math.max(0, cur + delta);
    this.fnbQuantities[id] = next;
  }

  get fnbTotalRupees(): number {
    let total = 0;
    for (const item of this.fnbCatalog) {
      const qty = this.fnbQuantities[item.id] || 0;
      total += item.price * qty;
    }
    return total;
  }

  get unitPriceRupees(): number {
    if (!this.event) return 0;
    const price = Number(this.event.price ?? this.event.ticketPrice ?? 0);
    return Number.isFinite(price) ? Math.max(0, Math.round(price)) : 0;
  }

  get isFreeEvent(): boolean {
    return this.unitPriceRupees <= 0;
  }

  get seatsSubtotalRupees(): number {
    return this.unitPriceRupees * (this.seatsCount || 1);
  }

  get selectedPromotion(): PromotionRecord | null {
    return this.claimedPromotions.find((p) => p.id === this.selectedPromotionId) || null;
  }

  get discountRupees(): number {
    return this.promotionService.calculateDiscount(this.seatsSubtotalRupees, this.selectedPromotion);
  }

  get finalPayableRupees(): number {
    return Math.max(0, this.seatsSubtotalRupees + this.fnbTotalRupees - this.discountRupees);
  }

  onShowtimeSelect(evt: { hallName: string; time: string }): void {
    this.selectedHallName = evt.hallName;
    this.selectedShowTime = evt.time;
    this.nextStep(); // auto advance to seat selection
  }

  private refreshPromotions(): void {
    if (!this.currentUser || !this.eventId) return;
    this.claimablePromotions = this.promotionService.listClaimableForUser(this.currentUser, this.eventId);
    this.claimedPromotions = this.promotionService.listClaimedForUser(this.currentUser, this.eventId);
  }

  claimPromotion(id: string): void {
    const result = this.promotionService.claimPromotion(id, this.currentUser);
    this.msg = result.message;
    this.refreshPromotions();
    if (result.ok && result.promotion) {
      this.selectedPromotionId = result.promotion.id;
    }
  }

  promotionCaption(item: PromotionRecord): string {
    return this.promotionService.describePromotion(item);
  }

  buildShowAtIso(): string {
    const dateStr = this.selectedShowDate || new Date().toISOString().slice(0, 10);
    const timeStr = this.selectedShowTime || '10:00';
    let d = new Date(`${dateStr}T${timeStr}:00`);
    if (Number.isNaN(d.getTime())) d = new Date();
    if (d.getTime() <= Date.now()) {
      d = new Date(d.getTime());
      d.setFullYear(d.getFullYear() + 1);
    }
    return d.toISOString();
  }

  proceedToPayment(): void {
    if (this.submitting) return;

    if (!this.name.trim() || !this.email.trim()) {
      this.msg = '❌ Name and Email are required.';
      return;
    }

    this.submitting = true;
    this.msg = 'Processing booking...';

    const showAtIso = this.buildShowAtIso();

    // If free event, create booking directly without Stripe checkout
    if (this.isFreeEvent || this.finalPayableRupees === 0) {
      this.bs.createBooking({
        eventId: this.eventId,
        name: this.name.trim(),
        email: this.email.trim(),
        seats: this.seatsCount,
        showAt: showAtIso,
      }).subscribe({
        next: (res: any) => {
          const ticketId = res?.ticketId || res?.booking?.ticketId;
          if (ticketId) {
            this.router.navigate(['/booking', ticketId]);
          } else {
            this.router.navigate(['/history']);
          }
        },
        error: (err: any) => {
          this.submitting = false;
          this.msg = err?.error?.message || 'Booking failed.';
        },
      });
      return;
    }

    // Stripe paid checkout
    const payablePerSeat = Math.max(100, Math.round((this.finalPayableRupees / (this.seatsCount || 1)) * 100));

    this.bs.createCheckoutSession({
      eventId: this.eventId,
      ticketName: 'Standard Pass',
      name: this.name.trim(),
      email: this.email.trim(),
      quantity: this.seatsCount,
      seats: this.seatsCount,
      showAt: showAtIso,
      unitAmount: payablePerSeat,
      promotionId: this.selectedPromotionId || undefined,
    }).subscribe({
      next: (res: any) => {
        if (res?.url) {
          window.location.href = res.url;
        } else {
          this.submitting = false;
          this.msg = 'Failed to initiate payment session.';
        }
      },
      error: (err: any) => {
        this.submitting = false;
        this.msg = err?.error?.message || 'Payment initiation failed.';
      },
    });
  }

  // Calendar Nav
  get calMonthLabel(): string {
    return new Date(this.calYear, this.calMonth, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
  }

  get calLeadBlanks(): null[] {
    return Array(new Date(this.calYear, this.calMonth, 1).getDay()).fill(null);
  }

  get calDays(): number[] {
    const days = new Date(this.calYear, this.calMonth + 1, 0).getDate();
    return Array.from({ length: days }, (_, i) => i + 1);
  }

  isCalDaySelected(day: number): boolean {
    if (!this.selectedShowDate) return false;
    const [y, mo, d] = this.selectedShowDate.split('-').map(Number);
    return y === this.calYear && (mo - 1) === this.calMonth && d === day;
  }

  selectCalDay(day: number): void {
    const m = String(this.calMonth + 1).padStart(2, '0');
    const d = String(day).padStart(2, '0');
    this.selectedShowDate = `${this.calYear}-${m}-${d}`;
  }

  calPrevMonth(): void {
    if (this.calMonth === 0) { this.calYear--; this.calMonth = 11; }
    else { this.calMonth--; }
  }

  calNextMonth(): void {
    if (this.calMonth === 11) { this.calYear++; this.calMonth = 0; }
    else { this.calMonth++; }
  }
}
