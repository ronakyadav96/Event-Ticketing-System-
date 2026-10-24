import { Component, OnInit } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { DashboardService } from '../../services/dashboard.service';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../auth/auth.service';
import { PromotionRecord, PromotionService } from '../../services/promotion.service';

type RangeDays = 7 | 30;
type CreatorSection = 'overview' | 'events' | 'sales' | 'promotions';

type CreatorEventRow = {
  eventId: string;
  title: string;
  date?: string;
  venue?: string;
  price: number;
  totalSeats: number;
  bookedSeats: number;
  category?: string;
};

type DailyPoint = {
  date: Date;
  label: string;
  bookings: number;
  revenue: number;
};

@Component({
  standalone: true,
  selector: 'app-creator-dashboard',
  imports: [CommonModule, RouterModule, DatePipe, FormsModule],
  templateUrl: './creator-dashboard.component.html',
  styleUrls: ['./creator-dashboard.component.css']
})
export class CreatorDashboardComponent implements OnInit {
  activeSection: CreatorSection = 'overview';

  raw: any = null;
  events: CreatorEventRow[] = [];
  bookings: any[] = [];

  loading = false;
  errorMsg = '';
  promoMsg = '';

  rangeDays: RangeDays = 30;
  creatorPromotions: PromotionRecord[] = [];
  promotionForm = {
    title: '',
    code: '',
    kind: 'coupon' as 'coupon' | 'gift',
    discountType: 'percent' as 'percent' | 'flat',
    discountValue: 10,
    eventId: '',
    expiryDate: '',
    maxClaims: 50,
    description: '',
  };

  constructor(
    private dashboardService: DashboardService,
    private router: Router,
    private authService: AuthService,
    private promotionService: PromotionService
  ) {}

  ngOnInit() {
    this.loading = true;
    this.dashboardService.getCreatorDashboard().subscribe({
      next: (res) => {
        this.raw = res;
        this.events = this.normalizeEvents(res);
        this.bookings = this.normalizeBookings(res);
        this.refreshPromotions();
        this.loading = false;
      },
      error: (err) => {
        console.error('Creator dashboard error:', err);
        this.errorMsg = 'Failed to load dashboard.';
        this.loading = false;
      }
    });
  }

  createPromotion(): void {
    const title = this.promotionForm.title.trim();
    const code = this.promotionForm.code.trim().toUpperCase();
    const selectedEvent = this.events.find((item) => item.eventId === this.promotionForm.eventId);

    if (!title || !code || !selectedEvent) {
      this.promoMsg = 'Title, code, and event are required.';
      return;
    }

    this.promotionService.createPromotion(
      {
        title,
        code,
        kind: this.promotionForm.kind,
        scope: 'event',
        discountType: this.promotionForm.discountType,
        discountValue: this.promotionForm.discountValue,
        eventId: selectedEvent.eventId,
        eventTitle: selectedEvent.title,
        expiryDate: this.promotionForm.expiryDate,
        maxClaims: this.promotionForm.maxClaims,
        description: this.promotionForm.description,
      },
      this.authService.getUser()
    );

    this.promoMsg = `${code} created for ${selectedEvent.title}.`;
    this.promotionForm = {
      title: '',
      code: '',
      kind: 'coupon',
      discountType: 'percent',
      discountValue: 10,
      eventId: '',
      expiryDate: '',
      maxClaims: 50,
      description: '',
    };
    this.refreshPromotions();
  }

  promotionSummary(item: PromotionRecord): string {
    return this.promotionService.describePromotion(item);
  }

  deletePromotion(item: PromotionRecord): void {
    if (!confirm(`Delete ${item.code}?`)) return;
    const result = this.promotionService.deletePromotion(item.id, this.authService.getUser());
    this.promoMsg = result.message;
    this.refreshPromotions();
  }

  private refreshPromotions(): void {
    this.creatorPromotions = this.promotionService.listByCreator(this.authService.getUser());
  }

  setRange(days: RangeDays): void {
    this.rangeDays = days;
  }

  setActiveSection(section: CreatorSection): void {
    this.activeSection = section;
  }

  // ===== KPIs =====
  get myEventsCount(): number {
    return this.events.length;
  }

  get upcomingEventsCount(): number {
    const now = Date.now();
    return this.events.filter((e) => {
      const d = new Date(e.date || 0).getTime();
      return !isNaN(d) && d >= now;
    }).length;
  }

  get ticketsSold(): number {
    return this.events.reduce((sum, e) => sum + Number(e.bookedSeats || 0), 0);
  }

  get totalRevenue(): number {
    return this.events.reduce((sum, e) => sum + (Number(e.bookedSeats || 0) * Number(e.price || 0)), 0);
  }

  get soldOutCount(): number {
    return this.events.filter((e) => this.seatsLeft(e) === 0).length;
  }

  // ===== Charts =====
  get dailySeries(): DailyPoint[] {
    const end = this.startOfDay(new Date());
    const start = new Date(end);
    start.setDate(start.getDate() - (this.rangeDays - 1));

    const buckets = new Map<string, { bookings: number; revenue: number }>();
    const priceByEventId = new Map<string, number>();
    this.events.forEach((e) => priceByEventId.set(e.eventId, Number(e.price || 0)));

    this.bookings.forEach((b: any) => {
      const createdAt = new Date(b?.createdAt || b?.date || 0);
      if (isNaN(createdAt.getTime())) return;
      const day = this.startOfDay(createdAt);
      if (day < start || day > end) return;

      const seats = Number(b?.seats ?? b?.seatCount ?? 1);
      const eventId = String(b?.event?._id || b?.event?.id || b?.eventId || b?.event || '');
      const price =
        Number(b?.event?.price ?? b?.price ?? priceByEventId.get(eventId) ?? 0) || 0;

      const key = day.toISOString().slice(0, 10);
      const curr = buckets.get(key) || { bookings: 0, revenue: 0 };
      curr.bookings += isNaN(seats) ? 0 : Math.max(0, seats);
      curr.revenue += (isNaN(seats) ? 0 : Math.max(0, seats)) * price;
      buckets.set(key, curr);
    });

    const out: DailyPoint[] = [];
    for (let i = 0; i < this.rangeDays; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const key = d.toISOString().slice(0, 10);
      const v = buckets.get(key) || { bookings: 0, revenue: 0 };
      out.push({
        date: d,
        label: this.formatShort(d),
        bookings: v.bookings,
        revenue: Math.round(v.revenue),
      });
    }
    return out;
  }

  get bookingsLinePoints(): string {
    return this.buildLinePoints(this.dailySeries.map((p) => p.bookings));
  }

  get revenueLinePoints(): string {
    return this.buildLinePoints(this.dailySeries.map((p) => p.revenue));
  }

  // ===== Top 5 =====
  get top5ByTickets(): Array<{ title: string; value: number }> {
    return [...this.events]
      .sort((a, b) => Number(b.bookedSeats || 0) - Number(a.bookedSeats || 0))
      .slice(0, 5)
      .map((e) => ({ title: e.title, value: Number(e.bookedSeats || 0) }));
  }

  get top5ByRevenue(): Array<{ title: string; value: number }> {
    return [...this.events]
      .sort((a, b) => (Number(b.bookedSeats || 0) * Number(b.price || 0)) - (Number(a.bookedSeats || 0) * Number(a.price || 0)))
      .slice(0, 5)
      .map((e) => ({ title: e.title, value: Math.round(Number(e.bookedSeats || 0) * Number(e.price || 0)) }));
  }

  maxValue(list: Array<{ value: number }>): number {
    return Math.max(...list.map((x) => Number(x.value || 0)), 1);
  }

  // ===== Table actions =====
  viewEvent(id: string): void {
    if (!id) return;
    this.router.navigate(['/events', id]);
  }

  editEvent(id: string): void {
    if (!id) return;
    this.router.navigate(['/create-event'], { queryParams: { id } });
  }

  seatsLeft(e: CreatorEventRow): number {
    const total = Number(e.totalSeats || 0);
    const booked = Number(e.bookedSeats || 0);
    const left = total - booked;
    return isNaN(left) ? 0 : Math.max(0, left);
  }

  statusOf(e: CreatorEventRow): 'Upcoming' | 'Past' | 'Sold Out' {
    if (this.seatsLeft(e) <= 0) return 'Sold Out';
    const d = new Date(e.date || 0).getTime();
    if (!isNaN(d) && d < Date.now()) return 'Past';
    return 'Upcoming';
  }

  private normalizeEvents(res: any): CreatorEventRow[] {
    const list = Array.isArray(res?.perEvent) ? res.perEvent : Array.isArray(res?.events) ? res.events : [];
    return list
      .map((e: any) => {
        const eventId = String(e?.eventId || e?._id || e?.id || '');
        const totalSeats = Number(e?.totalSeats ?? e?.seats ?? e?.capacity ?? 0);
        const bookedSeats = Number(e?.bookedSeats ?? e?.seatsBooked ?? e?.seatsSold ?? e?.bookings ?? 0);
        const price = Number(e?.price ?? e?.event?.price ?? 0);
        return {
          eventId,
          title: String(e?.title || e?.event?.title || 'Event'),
          date: e?.date || e?.event?.date,
          venue: e?.venue || e?.event?.venue,
          price: isNaN(price) ? 0 : price,
          totalSeats: isNaN(totalSeats) ? 0 : totalSeats,
          bookedSeats: isNaN(bookedSeats) ? 0 : bookedSeats,
          category: e?.category || e?.event?.category,
        } as CreatorEventRow;
      })
      .filter((e: CreatorEventRow) => !!e.eventId);
  }

  private normalizeBookings(res: any): any[] {
    const list = res?.bookings || res?.recentBookings || res?.data?.bookings || [];
    return Array.isArray(list) ? list : [];
  }

  private startOfDay(d: Date): Date {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  private formatShort(d: Date): string {
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  }

  private buildLinePoints(values: number[]): string {
    const w = 300;
    const h = 100;
    const padX = 8;
    const padY = 10;
    const innerW = w - padX * 2;
    const innerH = h - padY * 2;
    const max = Math.max(...values.map((v) => Number(v || 0)), 1);

    const pts = values.map((v, i) => {
      const x = padX + (values.length <= 1 ? 0 : (i / (values.length - 1)) * innerW);
      const y = padY + (1 - (Number(v || 0) / max)) * innerH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });

    return pts.join(' ');
  }
}
